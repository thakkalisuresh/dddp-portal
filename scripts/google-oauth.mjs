#!/usr/bin/env node
/**
 * Mint a Google refresh token — for the nightly backup, or for `/forgot` (W1).
 *
 *   npm run google:auth -- backup     # the Drive account that holds the copies
 *   npm run google:auth -- mail       # the account reset codes are sent from
 *
 * This exists because W1 has sat blocked for months on a step described as "an
 * OAuth consent round-trip, which wants a terminal rather than a phone". That
 * is one command's worth of work, and leaving it as a paragraph of Google
 * Console instructions is how a task stays undone. Nothing here is clever; it
 * is the loopback dance, plus the checks that catch the ways this silently
 * fails afterwards.
 *
 * ── Two accounts, on purpose ────────────────────────────────────────────────
 *
 * The two jobs point in opposite directions, so they are run twice, once each.
 *
 * **mail** should be the ASSOCIATION's Gmail. It emails 99 residents their
 * reset codes; the From line should say the association, and the replies should
 * arrive somewhere the committee can read.
 *
 * **backup** is whoever holds the off-site copies, and can be a personal
 * account — Drive charges a file to the account that created it, so this is
 * the account whose quota fills, and the committee's own 15 GB is left for the
 * committee's own documents.
 *
 * Know what that means before choosing: the bundle carries every resident's
 * name, mobile, email and payment history (never passwords — see NEVER_EXPORT
 * in functions/lib/backup.js). Whoever consents to `backup` is holding the
 * association's records personally, and when they leave the committee that is
 * a person to replace, not a folder to move.
 *
 * Running only `mail` is a valid, simpler setup: leave GOOGLE_BACKUP_* unset
 * and the backup falls back to the shared credentials and the same account.
 *
 * ── Before running ──────────────────────────────────────────────────────────
 *
 * 1. At https://console.cloud.google.com, signed in as the account you are
 *    setting up — a project, then:
 *      · APIs & Services → Library → enable **Google Drive API** (backup)
 *        or **Gmail API** (mail)
 *      · OAuth consent screen → External
 *      · Credentials → Create credentials → OAuth client ID → **Desktop app**
 *
 *    Desktop app, specifically. A Web application client would need this
 *    script's exact redirect URI registered by hand; a Desktop client accepts
 *    any loopback port, so nothing has to be kept in sync.
 *
 *    Two accounts means two projects and two OAuth clients. They are not
 *    interchangeable: a client belongs to one project, and the refresh token
 *    belongs to the account that consented.
 *
 * 2. **PUBLISH the consent screen to Production.** Not "Testing".
 *
 *    In Testing mode Google expires the refresh token after seven days. The
 *    nightly upload then stops, throws where nobody is looking, and leaves a
 *    Drive folder that has simply stopped filling — which is indistinguishable
 *    from a folder nobody opened. This is the single most likely way this
 *    feature is dead six months from now, and no code here can detect it: the
 *    token looks identical either way. `npm run doctor` catches it the day
 *    after it happens (BACKUP-STALE), which is a smoke alarm, not a fix.
 *
 * 3. For `backup`, a Drive folder to write into. Its id is the last path
 *    segment of the folder URL.
 *
 * ── What it does at the end ─────────────────────────────────────────────────
 *
 * Offers to set the four secrets on BOTH deployments itself, because it is
 * holding all four already and the alternative is eight prompts typed by hand.
 *
 * Both deployments is not optional: the 3am upload runs on the cron Worker and
 * the Export tab's health line runs on Pages. Secrets on one do not reach the
 * other, and the half-configured state is the one that lies — see
 * BACKUP-CRON-UNCONFIGURED in functions/lib/diagnostics.js. Doing it in one
 * pass is the point; a person copying eight commands stops after four, which is
 * exactly the state that reports healthy while nothing is backed up.
 *
 * Values reach wrangler on stdin, never as arguments. An argument would be
 * visible to `ps` for as long as the process runs, and a refresh token in
 * another user's process listing is a refresh token given away.
 *
 * Nothing is written to disk, and the secrets are not echoed. Decline the offer
 * and it prints the eight commands to run by hand instead — `wrangler secret
 * put` prompts rather than taking an argument, so the values stay out of shell
 * history either way.
 */

import { createServer } from 'node:http';
import { createInterface } from 'node:readline/promises';
import { execFileSync } from 'node:child_process';
import { stdin, stdout } from 'node:process';
import { join } from 'node:path';

/**
 * One scope each, rather than both on both.
 *
 * `drive.file` rather than `drive`: it grants access to files this client
 * creates and nothing else, so a leaked token cannot read the rest of that
 * account's Drive. Uploading into a folder the app did not create is still
 * allowed, which is all the backup does. That narrowness matters more now the
 * backup account is somebody's personal one.
 */
const MODES = {
  backup: {
    scope: 'https://www.googleapis.com/auth/drive.file',
    api: 'Google Drive API',
    names: ['GOOGLE_BACKUP_CLIENT_ID', 'GOOGLE_BACKUP_CLIENT_SECRET',
            'GOOGLE_BACKUP_REFRESH_TOKEN', 'GOOGLE_BACKUP_FOLDER_ID'],
  },
  mail: {
    scope: 'https://www.googleapis.com/auth/gmail.send',
    api: 'Gmail API',
    names: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET',
            'GOOGLE_REFRESH_TOKEN', 'MAIL_FROM'],
  },
};

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

/**
 * Put one secret on both deployments.
 *
 * The value goes in on stdin. Passing it as an argument would expose it in the
 * process list to anything running on this machine, which for a refresh token
 * is the whole secret.
 *
 * A failure here is reported and NOT swallowed: a half-set pair is the state
 * this whole exercise exists to avoid, and carrying on to the next name would
 * bury the one line that says which surface is now wrong.
 */
function putSecret(name, value) {
  const run = (args, cwd) => execFileSync('npx', ['wrangler', ...args], {
    input: value, cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
  });
  run(['secret', 'put', name], process.cwd());
  run(['pages', 'secret', 'put', name], join(process.cwd(), 'pages'));
}

const main = async () => {
  const which = process.argv[2];
  if (!MODES[which]) {
    console.error('\nUsage: npm run google:auth -- backup   (the Drive account holding the copies)'
      + '\n       npm run google:auth -- mail     (the account reset codes are sent from)'
      + '\n\nRun it once for each. Read the header of scripts/google-oauth.mjs first.\n');
    process.exitCode = 1;
    return;
  }
  const mode = MODES[which];
  const isBackup = which === 'backup';

  const rl = createInterface({ input: stdin, output: stdout });
  try {
    console.log(`\n${C.bold}Google credentials — ${which}${C.off}`);
    console.log(`${C.dim}Scope: ${mode.scope}${C.off}`);
    console.log(`${C.dim}Sign in as ${isBackup
      ? 'the account that will HOLD the backups. It keeps every resident\'s name,'
        + '\nmobile, email and payment history in its Drive.'
      : 'the ASSOCIATION\'s Gmail. Residents see this address on their reset codes.'}${C.off}\n`);

    const clientId = await ask(rl, 'OAuth client ID: ');
    const clientSecret = await ask(rl, 'OAuth client secret: ');
    const extra = isBackup
      ? await ask(rl, 'Drive folder id for backups: ')
      : await ask(rl, 'Address to send from (MAIL_FROM): ');

    const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    authUrl.search = new URLSearchParams({
      client_id: clientId,
      redirect_uri: REDIRECT,
      response_type: 'code',
      scope: mode.scope,
      // offline is what produces a refresh token at all; consent forces one to
      // be re-issued even if this client has been approved before.
      access_type: 'offline',
      prompt: 'consent',
    }).toString();

    console.log(`\n${C.bold}Open this, signed in as that account:${C.off}\n`);
    console.log(`${authUrl}\n`);
    console.log(`${C.dim}Waiting for the redirect back to ${REDIRECT} …${C.off}`);

    const code = await waitForCode();
    const token = await exchange({ clientId, clientSecret, code });
    console.log(`\n${C.ok}Consent granted.${C.off}`);

    if (isBackup) {
      console.log('Writing a check file to the folder…');
      const file = await writeCheckFile({ accessToken: token.access_token, folderId: extra });
      console.log(`${C.ok}Drive accepted it:${C.off} ${file.name} (${file.id})`);
      console.log(`${C.dim}Open the folder and confirm you can see that file. Then delete it.${C.off}`);
    }

    const [idName, secretName, tokenName, extraName] = mode.names;
    const values = {
      [idName]: clientId,
      [secretName]: clientSecret,
      [tokenName]: token.refresh_token,
      [extraName]: extra,
    };

    console.log(`\n${C.bold}Set these four on BOTH deployments?${C.off} The 3am upload runs on`);
    console.log('the cron Worker; the Export tab health line runs on Pages. One without');
    console.log('the other is the state that reports healthy while nothing is written.\n');
    for (const n of mode.names) console.log(`  ${n}`);

    const go = (await ask(rl, '\nSet them now, on both? [Y/n] ', 'y')).toLowerCase();
    if (go.startsWith('y')) {
      for (const n of mode.names) {
        process.stdout.write(`  ${n.padEnd(28)}`);
        putSecret(n, values[n]);
        console.log(`${C.ok}both${C.off}`);
      }
      console.log(`\n${C.ok}Done.${C.off} The refresh token was not printed and is not on disk.`);
      console.log(`${C.dim}To see it: rerun this. To revoke it: https://myaccount.google.com/permissions${C.off}`);
    } else {
      // Printed only when the automatic path was refused. There is no reason to
      // put a live refresh token on someone's screen otherwise.
      console.log(`\n${C.dim}# cron Worker — from the repo root${C.off}`);
      for (const n of mode.names) console.log(`npx wrangler secret put ${n}`);
      console.log(`\n${C.dim}# Pages — from the repo root${C.off}`);
      for (const n of mode.names) {
        console.log(`npx wrangler pages secret put ${n} --project-name diamondpark`);
      }
      console.log(`\n${C.dim}Values, for pasting into those prompts:${C.off}`);
      for (const n of mode.names) console.log(`  ${n.padEnd(28)}${values[n]}`);
      console.log(`\n${C.warn}That last one is a live refresh token. Clear your scrollback.${C.off}`);
    }

    console.log(`\n${C.warn}Then, in this order:${C.off}`);
    console.log('  1. Confirm the OAuth consent screen is PUBLISHED, not in Testing.');
    console.log('     Testing expires this token in seven days and the backup then stops');
    console.log('     silently. Nothing in the code can tell the two apart.');
    if (isBackup) {
      console.log(`  2. Run this again as ${C.bold}mail${C.off} if you have not — the reset emails`);
      console.log('     should come from the association, not from this account.');
    } else {
      console.log(`  2. Run this again as ${C.bold}backup${C.off} if the backups belong in a`);
      console.log('     different account. Skip it to use this one for both.');
    }
    console.log('  3. npm run deploy:all');
    console.log('  4. npm run doctor          — expect BACKUP-NEVER, not BACKUP-NOT-CONFIGURED');
    console.log('  5. Tomorrow, after 3am IST:');
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
