#!/usr/bin/env node
/**
 * Mint the Google refresh token the backup and `/forgot` both need (W1).
 *
 *   node scripts/google-oauth.mjs
 *
 * This exists because W1 has sat blocked for months on a step described as "an
 * OAuth consent round-trip, which wants a terminal rather than a phone". That
 * is one command's worth of work, and leaving it as a paragraph of Google
 * Console instructions is how a task stays undone. Nothing here is clever; it
 * is the loopback dance, plus the two checks that catch the ways this silently
 * fails afterwards.
 *
 * ── Before running ──────────────────────────────────────────────────────────
 *
 * 1. A Gmail account owned by the ASSOCIATION, not by a person. The whole point
 *    of B12 is that the committee keeps its own records; an account tied to
 *    whoever set it up recreates the problem this project exists to fix.
 *
 * 2. At https://console.cloud.google.com — a project, then:
 *      · APIs & Services → Library → enable **Google Drive API** and **Gmail API**
 *      · OAuth consent screen → External → add the association Gmail as a user
 *      · Credentials → Create credentials → OAuth client ID → **Desktop app**
 *
 *    Desktop app, specifically. A Web application client would need this
 *    script's exact redirect URI registered by hand; a Desktop client accepts
 *    any loopback port, so nothing has to be kept in sync.
 *
 * 3. **PUBLISH the consent screen to Production.** Not "Testing".
 *
 *    In Testing mode Google expires the refresh token after seven days. The
 *    nightly upload then stops, throws where nobody is looking, and leaves a
 *    Drive folder that has simply stopped filling — which is indistinguishable
 *    from a folder nobody opened. This is the single most likely way this
 *    feature is dead six months from now, and no code here can detect it: the
 *    token looks identical either way. `npm run doctor` catches it the day
 *    after it happens (BACKUP-STALE), which is a smoke alarm, not a fix.
 *
 * 4. A Drive folder for the backups, shared with the association account. Its
 *    id is the last path segment of the folder URL.
 *
 * ── What it prints ──────────────────────────────────────────────────────────
 *
 * The refresh token, and the eight commands that put the four secrets on BOTH
 * deployments. Both is not optional: the 3am upload runs on the cron Worker and
 * the Export tab's health line runs on Pages. Secrets on one do not reach the
 * other, and the half-configured state is the one that lies — see
 * BACKUP-CRON-UNCONFIGURED in functions/lib/diagnostics.js.
 *
 * Nothing is written to disk. The token is printed once, for pasting into
 * `wrangler secret put`, which prompts rather than taking an argument — so it
 * never reaches shell history either.
 */

import { createServer } from 'node:http';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

/**
 * `drive.file` rather than `drive`: it grants access to files this client
 * creates and nothing else, so a leaked token cannot read the committee's
 * other documents. Uploading into a folder the app did not create is still
 * allowed, which is all the backup does.
 */
const SCOPES = [
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/gmail.send',
];

const PORT = 8976;
const REDIRECT = `http://localhost:${PORT}`;

const C = { bold: '\x1b[1m', dim: '\x1b[2m', warn: '\x1b[33m', ok: '\x1b[36m', off: '\x1b[0m' };

async function ask(rl, question, fallback) {
  const answer = (await rl.question(question)).trim();
  if (!answer && !fallback) throw new Error('Required.');
  return answer || fallback;
}

/**
 * Waits for Google to redirect the browser back here with `?code=`.
 *
 * A loopback server rather than "paste the code from the browser": the
 * out-of-band copy-paste flow Google used to offer was switched off in 2022,
 * and the code now only ever arrives as a query parameter.
 */
function waitForCode() {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url, REDIRECT);
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><meta charset="utf-8"><title>DD Diamond Park</title>
<body style="font:16px system-ui;padding:3rem;max-width:32rem">
<h1>${code ? 'Done.' : 'Refused.'}</h1>
<p>${code ? 'Go back to the terminal — the refresh token is printed there.'
          : `Google said: ${error ?? 'no code returned'}`}</p>`);
      server.close();
      code ? resolve(code) : reject(new Error(error ?? 'no code returned'));
    });
    server.on('error', reject);
    server.listen(PORT, '127.0.0.1');
  });
}

async function exchange({ clientId, clientSecret, code }) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: REDIRECT,
    }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`${body.error}: ${body.error_description ?? ''}`);
  if (!body.refresh_token) {
    // Google issues a refresh token only on the FIRST consent for a client
    // unless prompt=consent is forced, which it is below. Seeing this means
    // something stripped it, and a setup that "worked" without one would break
    // in an hour when the access token expired.
    throw new Error('Google returned no refresh_token. Revoke this app at '
      + 'https://myaccount.google.com/permissions and run this again.');
  }
  return body;
}

/**
 * Writes one small real file into the folder.
 *
 * A token that refreshes proves the credentials; it does not prove the folder
 * id is right, that the account can write to it, or that the Drive API is
 * enabled. Those are three separate ways for the first 3am run to fail at a
 * time nobody is watching, and this turns all of them into an error message
 * printed while a human is still at the keyboard.
 *
 * The file is left behind on purpose. Someone should open the folder and see
 * it: that is the entire promise of this feature, tested once, by hand.
 */
async function writeCheckFile({ accessToken, folderId }) {
  const boundary = `ddp${Date.now()}`;
  const name = `setup-check-${new Date().toISOString().slice(0, 10)}.csv`;
  const content = 'what,when\nOAuth setup check — safe to delete,'
    + `${new Date().toISOString()}\n`;

  const res = await fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name',
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': `multipart/related; boundary=${boundary}`,
      },
      body: [
        `--${boundary}`, 'Content-Type: application/json; charset=UTF-8', '',
        JSON.stringify({ name, parents: [folderId] }),
        `--${boundary}`, 'Content-Type: text/csv', '',
        content,
        `--${boundary}--`, '',
      ].join('\r\n'),
    }
  );
  if (!res.ok) throw new Error(`Drive refused the upload (${res.status}): ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

const main = async () => {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    console.log(`\n${C.bold}Google credentials for the backup and password reset${C.off}`);
    console.log(`${C.dim}Read the header of this file first if you have not already.${C.off}\n`);

    const clientId = await ask(rl, 'OAuth client ID: ');
    const clientSecret = await ask(rl, 'OAuth client secret: ');
    const mailFrom = await ask(rl, 'Association Gmail address (MAIL_FROM): ');
    const folderId = await ask(rl, 'Drive folder id for backups: ');

    const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    authUrl.search = new URLSearchParams({
      client_id: clientId,
      redirect_uri: REDIRECT,
      response_type: 'code',
      scope: SCOPES.join(' '),
      // offline is what produces a refresh token at all; consent forces one to
      // be re-issued even if this client has been approved before.
      access_type: 'offline',
      prompt: 'consent',
    }).toString();

    console.log(`\n${C.bold}Open this, signed in as the association account:${C.off}\n`);
    console.log(`${authUrl}\n`);
    console.log(`${C.dim}Waiting for the redirect back to ${REDIRECT} …${C.off}`);

    const code = await waitForCode();
    const token = await exchange({ clientId, clientSecret, code });

    console.log(`\n${C.ok}Consent granted.${C.off} Writing a check file to the folder…`);
    const file = await writeCheckFile({ accessToken: token.access_token, folderId });
    console.log(`${C.ok}Drive accepted it:${C.off} ${file.name} (${file.id})`);
    console.log(`${C.dim}Open the folder and confirm you can see that file. Then delete it.${C.off}`);

    console.log(`\n${C.bold}GOOGLE_REFRESH_TOKEN${C.off}\n\n${token.refresh_token}\n`);

    console.log(`${C.bold}Set all five on BOTH deployments.${C.off} The 3am upload runs on the`);
    console.log('cron Worker; the Export tab health line runs on Pages. One without the');
    console.log('other is the state that reports healthy while nothing is written.\n');

    const names = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN',
                   'GOOGLE_BACKUP_FOLDER_ID', 'MAIL_FROM'];
    console.log(`${C.dim}# cron Worker — from the repo root${C.off}`);
    for (const n of names) console.log(`npx wrangler secret put ${n}`);
    console.log(`\n${C.dim}# Pages — from the repo root${C.off}`);
    for (const n of names) {
      console.log(`npx wrangler pages secret put ${n} --project-name diamondpark`);
    }

    console.log(`\n${C.dim}Values, for pasting into those prompts:${C.off}`);
    console.log(`  GOOGLE_CLIENT_ID          ${clientId}`);
    console.log(`  GOOGLE_CLIENT_SECRET      ${clientSecret}`);
    console.log('  GOOGLE_REFRESH_TOKEN      (printed above)');
    console.log(`  GOOGLE_BACKUP_FOLDER_ID   ${folderId}`);
    console.log(`  MAIL_FROM                 ${mailFrom}`);

    console.log(`\n${C.warn}Then, in this order:${C.off}`);
    console.log('  1. Confirm the OAuth consent screen is PUBLISHED, not in Testing.');
    console.log('     Testing expires this token in seven days and the backup then stops');
    console.log('     silently. Nothing in the code can tell the two apart.');
    console.log('  2. npm run deploy:all');
    console.log('  3. npm run doctor          — expect BACKUP-NEVER, not BACKUP-NOT-CONFIGURED');
    console.log('  4. Tomorrow, after 3am IST:');
    console.log('     npm run doctor          — BACKUP-NEVER must be gone');
    console.log('     A file in the Drive folder is the proof; the watermark is the record.\n');
  } catch (err) {
    console.error(`\n${C.warn}Stopped:${C.off} ${err.message}\n`);
    process.exitCode = 1;
  } finally {
    rl.close();
  }
};

main();
