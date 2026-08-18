/**
 * Nightly backup, and retention.
 *
 * The point of this is not disaster recovery — D1 has Time Travel for that.
 * It is that the committee can open a CSV in Excel **without a developer**.
 * This whole project exists because one resident built a portal and walked
 * away; a backup nobody but a programmer can read repeats that mistake.
 */

import { reportError, fail } from './errors.js';
import { noticeHtml, noticeSignature } from './notice-doc.js';

/**
 * Every table carried off-site, in dependency order — restore reads top to
 * bottom, so a child never arrives before its parent.
 *
 * THIS LIST AND `NEVER_BACKUP` MUST BETWEEN THEM COVER THE WHOLE SCHEMA, and
 * test/backup.test.js reads migrations/ to insist on it. That test exists
 * because this list was hand-maintained for nine migrations and silently fell
 * nine tables behind: the reconciliation records, the bill-edit approvals and
 * the attachment metadata were all absent from a backup that reported success
 * every night. A new table must now be named in one list or the other, and
 * saying so in the wrong one is at least a decision somebody made.
 */
export const TABLES = [
  'flats', 'owners', 'periods', 'readings', 'meter_changes', 'bills',
  'payment_intents', 'payment_proofs', 'notices', 'comments', 'attachments',
  'committee', 'messages', 'contact_requests',
  'statement_sessions', 'statement_credits', 'reconciliations',
  'bill_edit_requests', 'bill_edit_approvals',
  'settings', 'alert_episodes', 'audit_log',
];

/**
 * Tables deliberately left out, and why — because "not in TABLES" is not a
 * reason, and the last time it was, nine tables went missing behind it.
 *
 * `sessions` and `password_resets` are the ones that matter. `sessions.token`
 * IS the credential — it is the primary key, not a hash of one — so exporting
 * that table writes every live login into a CSV that lives in a committee
 * member's personal Drive. `stripSecrets` would not save it either; that only
 * knows about `pw_hash` and `pw_salt`. These two are not "not backed up yet".
 * They must never be backed up, and adding them to TABLES is a mistake this
 * comment exists to prevent.
 *
 * The five volatile tables are pruned by RETENTION_DAYS, and pruning them is a
 * privacy promise, not housekeeping. A nightly copy of activity and click_log
 * would keep off-site, for ever, exactly the rows the retention policy exists
 * to delete — which quietly repeals the policy.
 *
 * `d1_migrations` is wrangler's own bookkeeping, rebuilt from migrations/ in
 * git. It is not created by a migration, so the coverage test never sees it;
 * it is named here anyway so the reader does not wonder.
 */
export const NEVER_BACKUP = new Set([
  'sessions', 'password_resets',
  'activity', 'click_log', 'error_log', 'login_attempts', 'message_attempts',
  'd1_migrations',
]);

/** Columns never written to a backup, however convenient. */
const NEVER_EXPORT = new Set(['pw_hash', 'pw_salt']);

/**
 * RFC 4180. The naive `join(',')` breaks the first time a resident writes a
 * comma in a comment, and silently shifts every later column — which is worse
 * than failing, because the file still opens.
 */
export function toCsvValue(value) {
  if (value == null) return '';
  const s = String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows, { columns } = {}) {
  if (!rows?.length) return columns?.length ? `${columns.join(',')}\n` : '';
  const cols = (columns ?? Object.keys(rows[0])).filter((c) => !NEVER_EXPORT.has(c));
  const head = cols.join(',');
  const body = rows.map((r) => cols.map((c) => toCsvValue(r[c])).join(','));
  return `${head}\n${body.join('\n')}\n`;
}

/** Password material must never leave the database, even to a private folder. */
export function stripSecrets(rows) {
  return rows.map((row) => {
    const copy = { ...row };
    for (const key of NEVER_EXPORT) delete copy[key];
    return copy;
  });
}

export async function dumpTable(env, table) {
  if (!TABLES.includes(table)) fail('DDP-SYS-003', { table });
  const rows = await env.DB.prepare(`SELECT * FROM ${table}`).all();
  return toCsv(stripSecrets(rows.results ?? []));
}

export async function dumpAll(env) {
  const files = {};
  for (const table of TABLES) files[`${table}.csv`] = await dumpTable(env, table);
  return files;
}

/**
 * One readable file rather than a zip: Workers have no zip primitive, adding a
 * library for it is silly at this size, and a single annotated CSV bundle is
 * something a treasurer can actually scroll through.
 */
export function bundle(files, { generatedAt }) {
  const parts = [
    '# DD Diamond Park — full data export',
    `# Generated ${generatedAt}`,
    '# Passwords are never exported. Each section below is a separate CSV table.',
    '',
  ];
  for (const [name, csv] of Object.entries(files)) {
    parts.push(`### ${name}`, csv.trimEnd(), '');
  }
  return parts.join('\n');
}

/* ── retention ─────────────────────────────────────────────────────────── */

/**
 * Activity and click rows are the highest-volume, lowest-value data here, and
 * the most invasive. They are pruned aggressively; the audit trail is not
 * pruned at all, because it is the thing that makes administration
 * accountable.
 */
export const RETENTION_DAYS = {
  activity: 180,
  click_log: 30,
  error_log: 365,
  message_attempts: 7,
  login_attempts: 7,
};

export function cutoffFor(table, now = Date.now()) {
  const days = RETENTION_DAYS[table];
  if (!days) return null;
  return new Date(now - days * 86_400_000).toISOString();
}

export async function pruneOldRows(env, now = Date.now()) {
  const pruned = {};
  for (const table of Object.keys(RETENTION_DAYS)) {
    const cutoff = cutoffFor(table, now);
    const result = await env.DB.prepare(`DELETE FROM ${table} WHERE at < ?`).bind(cutoff).run();
    pruned[table] = result?.meta?.changes ?? 0;
  }
  return pruned;
}

/* ── Google Drive ──────────────────────────────────────────────────────── */

/**
 * Which Google account the upload authenticates as.
 *
 * Two accounts, not one, because the two jobs sharing these credentials point
 * in opposite directions. `/forgot` emails 99 residents and must come from an
 * address that says "the association"; the backup writes files, and files are
 * owned by whoever creates them, so that account is the one holding the copies.
 * The committee wanted its own Drive quota for its own documents, and the
 * treasurer's off-site copy is deliberately somewhere else.
 *
 * The `GOOGLE_BACKUP_*` trio therefore overrides the shared one for the upload
 * path only. Unset, it falls back — a single account still works and is still
 * the simpler setup, which is what the fallback is protecting.
 *
 * The consequence to know: whoever consents here holds every resident's name,
 * mobile, email and payment history in their personal Drive. That is a person
 * to replace, not a folder to move, when they leave the committee.
 */
export function backupCredentials(env) {
  return {
    clientId: env.GOOGLE_BACKUP_CLIENT_ID || env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_BACKUP_CLIENT_SECRET || env.GOOGLE_CLIENT_SECRET,
    refreshToken: env.GOOGLE_BACKUP_REFRESH_TOKEN || env.GOOGLE_REFRESH_TOKEN,
  };
}

/** The shared credentials, which is what the mail path uses. */
export function sharedCredentials(env) {
  return {
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
    refreshToken: env.GOOGLE_REFRESH_TOKEN,
  };
}

export function driveConfigured(env) {
  const { clientId, clientSecret, refreshToken } = backupCredentials(env);
  return Boolean(clientId && clientSecret && refreshToken && env.GOOGLE_BACKUP_FOLDER_ID);
}

/**
 * A refresh token issued while the OAuth consent screen is in "Testing" mode
 * expires after seven days. That has bitten this author before: the backup
 * simply stops, silently, and nobody notices until they need it. Publish the
 * consent screen to Production, and rely on the health check below.
 *
 * Takes the credentials rather than reading them off env, because there are now
 * two sets and which one is meant is the caller's business, not this
 * function's. Defaulting to the shared set keeps the mail path unchanged; a
 * default of "whatever the backup uses" would have silently mailed residents
 * from a committee member's personal address the day the two diverged.
 */
export async function refreshAccessToken(env, credentials = sharedCredentials(env)) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      refresh_token: credentials.refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) fail('DDP-SYS-008', { status: res.status, body: (await res.text()).slice(0, 200) });
  const body = await res.json();
  if (!body.access_token) fail('DDP-SYS-008', { reason: 'no access_token in response' });
  return body.access_token;
}

/** `2026-08`. ISO order so the folder list sorts itself, in every locale. */
export function monthFolderName(now = new Date()) {
  return now.toISOString().slice(0, 7);
}

/**
 * The month's subfolder, created the first night of each month.
 *
 * A year of nightly files in one folder is 365 rows to scroll, and the person
 * this backup exists for is a treasurer looking for last March — not a
 * developer with a search box. Twelve folders of thirty is the shape that
 * answers that question.
 *
 * Looked up from Drive each night rather than remembered in `settings`. A
 * cached id survives the folder being deleted or reorganised and then fails
 * every night thereafter pointing at something that is gone; a lookup costs one
 * request and repairs itself. `drive.file` can see this folder because this
 * client created it, which is also why the parent folder can stay outside the
 * scope's reach.
 *
 * `orderBy=createdTime` matters more than it looks: if a duplicate ever did
 * appear, every later night would agree on which one to use rather than
 * scattering files across both.
 */
export async function ensureMonthFolder(env, token, name = monthFolderName()) {
  return ensureFolder(env, token, { name, parentId: env.GOOGLE_BACKUP_FOLDER_ID });
}

/** The same lookup-or-create, for any folder under any parent. */
export async function ensureFolder(env, token, { name, parentId }) {
  const parent = parentId ?? env.GOOGLE_BACKUP_FOLDER_ID;
  const FOLDER = 'application/vnd.google-apps.folder';
  const q = `name = '${name}' and mimeType = '${FOLDER}' and '${parent}' in parents `
    + 'and trashed = false';

  const found = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}`
    + '&fields=files(id,name)&orderBy=createdTime&pageSize=1',
    { headers: { authorization: `Bearer ${token}` } }
  );
  if (!found.ok) fail('DDP-SYS-003', { status: found.status, step: 'find-month-folder' });
  const existing = (await found.json()).files?.[0];
  if (existing) return existing.id;

  const made = await fetch('https://www.googleapis.com/drive/v3/files?fields=id', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ name, mimeType: FOLDER, parents: [parent] }),
  });
  if (!made.ok) fail('DDP-SYS-003', { status: made.status, step: 'create-month-folder' });
  return (await made.json()).id;
}

export async function uploadToDrive(env, { name, content, mimeType = 'text/csv',
  parentId, token: given } = {}) {
  // The caller may already hold a token — runBackup needs one for the folder
  // lookup anyway, and refreshing twice a night for one upload is two chances
  // to fail where one will do.
  const token = given ?? await refreshAccessToken(env, backupCredentials(env));
  const boundary = `ddp${crypto.randomUUID()}`;
  const metadata = { name, parents: [parentId ?? env.GOOGLE_BACKUP_FOLDER_ID] };

  // A Blob rather than a joined string, because `content` is now sometimes a
  // JPEG. Concatenating bytes into a JS string corrupts them — it reinterprets
  // each byte as UTF-16 — and base64 with Content-Transfer-Encoding would work
  // but inflates every proof by a third for no reason a Blob does not solve.
  const body = new Blob([
    `--${boundary}\r\n`,
    'Content-Type: application/json; charset=UTF-8\r\n\r\n',
    JSON.stringify(metadata),
    `\r\n--${boundary}\r\n`,
    `Content-Type: ${mimeType}\r\n\r\n`,
    content,
    `\r\n--${boundary}--\r\n`,
  ]);

  const res = await fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name',
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': `multipart/related; boundary=${boundary}`,
      },
      body,
    }
  );
  if (!res.ok) fail('DDP-SYS-003', { status: res.status, body: (await res.text()).slice(0, 200) });
  return res.json();
}

export function backupFilename(now = new Date()) {
  return `diamond-park-${now.toISOString().slice(0, 10)}.csv`;
}

/* ── the two folders ───────────────────────────────────────────────────── */

/**
 * Where the committee's own material goes, which is NOT where the backup goes.
 *
 * The backup folder holds the nightly CSV bundle: every resident's name, mobile,
 * email and payment history in one file. It is a disaster copy, and the list of
 * people who should be able to open it is short.
 *
 * This folder is the opposite — proof screenshots, notice attachments, the
 * things a committee actually looks at — and is meant to be SHARED with the
 * committee. Sharing is per-folder in Drive and inherits downward, so the only
 * way to share one without the other is for them to be different folders. One
 * folder with careful permissions inside it is the version that leaks the
 * roster the first time somebody shares the parent.
 *
 * Falls back to the backup folder when unset, so nothing breaks before it is
 * configured — but `npm run doctor` says so rather than letting the two quietly
 * be the same place.
 */
export function committeeFolder(env) {
  return env.GOOGLE_COMMITTEE_FOLDER_ID || env.GOOGLE_BACKUP_FOLDER_ID;
}

export function committeeFolderSeparate(env) {
  return Boolean(env.GOOGLE_COMMITTEE_FOLDER_ID
    && env.GOOGLE_COMMITTEE_FOLDER_ID !== env.GOOGLE_BACKUP_FOLDER_ID);
}

/* ── the proof images ──────────────────────────────────────────────────── */

/**
 * The CSVs carry the RECORD of a payment; R2 carries the EVIDENCE.
 *
 * `payment_proofs` backs up the UTR, the amount, the verdict and who approved
 * it — everything except the screenshot the resident actually sent. Lose the
 * bucket and the committee can say a payment was claimed and approved but
 * cannot show what was claimed, which is exactly the position a disputed
 * payment puts them in. So the images go too.
 *
 * Deliberately NOT included: thumbnails, which are derived and regenerable, and
 * notice attachments, which share the bucket but are not financial evidence.
 * Both are a decision to revisit rather than an oversight.
 *
 * TWENTY, NOT FIFTY, AND THE NUMBER IS NOT ARBITRARY. This account is on the
 * Workers free plan (docs/COSTS.md — the card on file is for R2, which is the
 * one service that meters past its allowance), and the free plan allows **50
 * subrequests per invocation**. A night already spends a handful on the token,
 * the month folder, the CSV, the proofs root and a period folder, so fifty
 * uploads would run out of subrequests partway through and fail every night
 * once residents actually start uploading — invisible today, with one proof in
 * the bucket, and arriving exactly when the building starts using the portal.
 * Twenty leaves room to spare and still moves 600 a month against an expected
 * inflow of about 99. Revisit this if the account ever moves to Workers Paid,
 * where the ceiling is 1000.
 */
export const PROOF_BATCH = 20;

/**
 * `4A-402318889021.jpg` — flat first so a folder sorts by flat, then the
 * reference the resident and the bank both quote. A hash prefix stands in when
 * there is no reference, which is the case for a screenshot nothing could be
 * read from; the file is still worth keeping, it is just harder to name.
 */
export function proofBackupName({ flat, utr, image_sha256: hash }, contentType = 'image/jpeg') {
  const ext = contentType === 'image/png' ? 'png' : contentType === 'image/webp' ? 'webp' : 'jpg';
  return `${flat}-${utr || (hash ?? '').slice(0, 12) || 'unknown'}.${ext}`;
}

/**
 * Copy proof images that have not been copied, oldest first, and stop at
 * PROOF_BATCH.
 *
 * **Marked in D1 rather than discovered from Drive.** The month folder is
 * looked up every night precisely so a deleted folder repairs itself, and the
 * opposite choice here is deliberate: that argument costs one request, while
 * asking Drive "which of these four thousand images do you already have"
 * costs a listing of the whole folder every night, for ever, to answer a
 * question a column answers exactly. The price is that emptying the Drive
 * folder by hand does not trigger a re-copy — `UPDATE payment_proofs SET
 * backed_up_at = NULL` does, and that is written down here because nothing
 * else would tell you.
 *
 * The batch cap exists because a backlog is normal — the first run after this
 * ships has every proof ever taken — and a cron that tries to move all of them
 * in one invocation is a cron that hits a limit and moves none. Twenty a night
 * clears a year of a 99-flat building inside a month, and the watermark is
 * never held hostage to it.
 */
export async function backupProofs(env, token, { limit = PROOF_BATCH } = {}) {
  const { results } = await env.DB.prepare(
    `SELECT p.id, p.r2_key, p.utr, p.image_sha256, b.flat, b.period
       FROM payment_proofs p
       JOIN bills b ON b.id = p.bill_id
      WHERE p.r2_key IS NOT NULL
        AND p.deleted_at IS NULL
        AND p.backed_up_at IS NULL
      ORDER BY p.id
      LIMIT ?`
  ).bind(limit).all();

  const pending = results ?? [];
  if (!pending.length) return { copied: 0, failed: 0 };

  const root = await ensureFolder(env, token, {
    name: 'proofs', parentId: committeeFolder(env),
  });
  const periods = new Map();
  let copied = 0;
  let failed = 0;

  for (const row of pending) {
    try {
      const object = await env.PROOFS.get(row.r2_key);
      // The row says there is an image and the bucket disagrees. Marking it
      // copied would be a lie; leaving it unmarked retries a file that will
      // never appear, every night. Counted as a failure so the digest says so,
      // and left alone so a restored bucket still gets picked up.
      if (!object) { failed += 1; continue; }

      if (!periods.has(row.period)) {
        periods.set(row.period, await ensureFolder(env, token, {
          name: row.period, parentId: root,
        }));
      }
      const contentType = object.httpMetadata?.contentType ?? 'image/jpeg';
      await uploadToDrive(env, {
        name: proofBackupName(row, contentType),
        content: await object.arrayBuffer(),
        mimeType: contentType,
        parentId: periods.get(row.period),
        token,
      });
      await env.DB.prepare('UPDATE payment_proofs SET backed_up_at = ? WHERE id = ?')
        .bind(new Date().toISOString(), row.id).run();
      copied += 1;
    } catch {
      // One unreadable image must not cost the other nineteen. Unmarked, so
      // tomorrow tries again.
      failed += 1;
    }
  }
  return { copied, failed };
}

/* ── the notice attachments ────────────────────────────────────────────── */

/**
 * `0012-water-tank-cleaning` — id first so it is unique and sorts by age, title
 * after so a human can find the thread without opening twelve folders.
 *
 * Truncated rather than full: notice titles run to a sentence, and a Drive
 * folder called "0012-the-committee-has-decided-that-the-water-tank-on-block-b"
 * is worse to read than the short one, not better.
 */
export function noticeFolderName({ id, title }) {
  const slug = String(title ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40)
    .replace(/-$/, '');
  return `${String(id).padStart(4, '0')}${slug ? `-${slug}` : ''}`;
}

/**
 * Copy notice and comment attachments, the same way and for the same reason as
 * the proofs.
 *
 * These are photographs of the building — a damp patch, a cracked beam — kept
 * at full quality on purpose, because 0018 decided the evidence is the point.
 * Evidence that exists in exactly one bucket is evidence with a single point of
 * failure.
 *
 * A comment's attachment is filed under its NOTICE, not on its own: the thread
 * is the unit anybody thinks in, and three photographs split across a notice
 * folder and a comment folder is a thread nobody can reassemble.
 *
 * Thumbnails are skipped. They are made in the browser from the file that IS
 * copied here, so a lost thumbnail costs a page render and nothing else.
 */
export async function backupAttachments(env, token, { limit = PROOF_BATCH } = {}) {
  const { results } = await env.DB.prepare(
    `SELECT a.id, a.r2_key, a.filename, a.content_type,
            COALESCE(a.notice_id, c.notice_id) AS notice_id,
            n.title AS notice_title
       FROM attachments a
       LEFT JOIN comments c ON c.id = a.comment_id
       LEFT JOIN notices  n ON n.id = COALESCE(a.notice_id, c.notice_id)
      WHERE a.r2_key IS NOT NULL
        AND a.deleted_at IS NULL
        AND a.backed_up_at IS NULL
      ORDER BY a.id
      LIMIT ?`
  ).bind(limit).all();

  const pending = results ?? [];
  if (!pending.length) return { copied: 0, failed: 0 };

  const root = await ensureFolder(env, token, {
    name: 'notices', parentId: committeeFolder(env),
  });
  const folders = new Map();
  let copied = 0;
  let failed = 0;

  for (const row of pending) {
    try {
      const object = await env.PROOFS.get(row.r2_key);
      if (!object) { failed += 1; continue; }

      const key = row.notice_id ?? 'orphaned';
      if (!folders.has(key)) {
        folders.set(key, await ensureFolder(env, token, {
          name: row.notice_id
            ? noticeFolderName({ id: row.notice_id, title: row.notice_title })
            // A notice deleted out from under its attachment still leaves a
            // file worth keeping. Somewhere obvious beats nowhere.
            : 'orphaned',
          parentId: root,
        }));
      }

      await uploadToDrive(env, {
        // The uploader's own filename, which is what the person who attached it
        // will look for. Prefixed with the id because two residents photograph
        // the same wall and both call it IMG_2081.jpg.
        name: `${row.id}-${row.filename}`,
        content: await object.arrayBuffer(),
        mimeType: row.content_type || 'application/octet-stream',
        parentId: folders.get(key),
        token,
      });
      await env.DB.prepare('UPDATE attachments SET backed_up_at = ? WHERE id = ?')
        .bind(new Date().toISOString(), row.id).run();
      copied += 1;
    } catch {
      failed += 1;
    }
  }
  return { copied, failed };
}

/* ── the notices, as documents ─────────────────────────────────────────── */

/** What Drive calls a native Doc. Setting it on upload converts the HTML. */
const GOOGLE_DOC = 'application/vnd.google-apps.document';

/**
 * Create the Doc, or rewrite the one that is already there.
 *
 * Rewriting matters more than it sounds: a notice gains comments for weeks
 * after it is posted. Uploading a new file each time would leave the folder
 * holding six versions of the same notice with no way to tell which is current,
 * so the file id is remembered and updated in place. Drive keeps its own
 * revision history, which is a better archive than six duplicates.
 */
async function putNoticeDoc(env, token, { html, name, parentId, fileId }) {
  const boundary = `ddp${crypto.randomUUID()}`;
  const metadata = fileId
    ? { name }
    : { name, parents: [parentId], mimeType: GOOGLE_DOC };

  const body = new Blob([
    `--${boundary}\r\n`,
    'Content-Type: application/json; charset=UTF-8\r\n\r\n',
    JSON.stringify(metadata),
    `\r\n--${boundary}\r\n`,
    'Content-Type: text/html; charset=UTF-8\r\n\r\n',
    html,
    `\r\n--${boundary}--\r\n`,
  ]);

  const url = fileId
    ? `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=multipart&fields=id`
    : 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id';

  const res = await fetch(url, {
    method: fileId ? 'PATCH' : 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': `multipart/related; boundary=${boundary}`,
    },
    body,
  });
  // A remembered id that Drive no longer has — the committee deleted the doc —
  // is not a failure worth alerting on. Forget it and let the next line create
  // a fresh one, which is what somebody deleting it probably wanted anyway.
  if (res.status === 404 && fileId) {
    return putNoticeDoc(env, token, { html, name, parentId, fileId: null });
  }
  if (!res.ok) fail('DDP-SYS-003', { status: res.status, step: 'notice-doc' });
  return (await res.json()).id;
}

/**
 * Every notice, as a Doc beside its own attachments.
 *
 * Runs over all notices rather than a batch: there is one today and there will
 * be a few hundred after a decade, the signature check means almost all of them
 * do nothing, and unlike the images each one costs a single small request.
 */
export async function backupNotices(env, token) {
  const [notices, comments, attachments] = await Promise.all([
    env.DB.prepare('SELECT * FROM notices ORDER BY id').all(),
    env.DB.prepare(
      `SELECT c.*, o.name AS author_name, o.flat AS author_flat
         FROM comments c LEFT JOIN owners o ON o.id = c.owner_id
        ORDER BY c.id`).all(),
    env.DB.prepare(
      `SELECT a.id, a.filename, a.bytes, a.deleted_at,
              COALESCE(a.notice_id, c.notice_id) AS notice_id
         FROM attachments a LEFT JOIN comments c ON c.id = a.comment_id
        ORDER BY a.id`).all(),
  ]);

  const byNotice = (rows, key = 'notice_id') => {
    const map = new Map();
    for (const row of rows ?? []) {
      if (!map.has(row[key])) map.set(row[key], []);
      map.get(row[key]).push(row);
    }
    return map;
  };
  const threads = byNotice(comments.results);
  const files = byNotice(attachments.results);

  let written = 0;
  let failed = 0;
  let root = null;

  for (const notice of notices.results ?? []) {
    const parts = {
      notice,
      comments: threads.get(notice.id) ?? [],
      attachments: files.get(notice.id) ?? [],
    };
    try {
      const signature = await noticeSignature(parts);
      if (signature === notice.backup_sig) continue;

      // Only now, so a night where every notice is unchanged touches Drive not
      // at all.
      root ??= await ensureFolder(env, token, {
        name: 'notices', parentId: committeeFolder(env),
      });
      const folder = await ensureFolder(env, token, {
        name: noticeFolderName(notice), parentId: root,
      });
      const fileId = await putNoticeDoc(env, token, {
        html: noticeHtml(parts),
        name: `${String(notice.id).padStart(4, '0')} ${notice.title}`,
        parentId: folder,
        fileId: notice.backup_doc_id,
      });
      await env.DB.prepare(
        'UPDATE notices SET backup_doc_id = ?, backup_sig = ? WHERE id = ?'
      ).bind(fileId, signature, notice.id).run();
      written += 1;
    } catch {
      failed += 1;
    }
  }
  return { written, failed };
}

/** Watermark key. Mirrors `last_digest_at`, and for the same reason. */
export const BACKUP_SETTING = 'last_backup_at';

/**
 * The backup has its own cron, and runs on nothing else.
 *
 * 22:00 UTC is 03:30 IST. It was moved off the 03:00 UTC job because that one
 * also sends the Telegram digest, and a digest that arrives at 3:30 in the
 * morning is a notification people turn off — at which point the building loses
 * the 22 warnings that only the digest surfaces.
 *
 * Must match wrangler.toml exactly. A typo here means the backup silently never
 * runs while both crons fire happily, which is this feature's signature failure
 * and the reason it is a named constant rather than a string in an if.
 */
export const BACKUP_CRON = '0 22 * * *';

export function isBackupCron(cron) {
  return cron === BACKUP_CRON;
}

export async function runBackup(env, ctx) {
  if (!driveConfigured(env)) {
    // Not an error worth alerting on — it simply hasn't been set up yet.
    return { skipped: 'drive-not-configured' };
  }
  try {
    const files = await dumpAll(env);
    const content = bundle(files, { generatedAt: new Date().toISOString() });
    const token = await refreshAccessToken(env, backupCredentials(env));
    const parentId = await ensureMonthFolder(env, token);
    const uploaded = await uploadToDrive(env, {
      name: backupFilename(), content, parentId, token,
    });
    // Written only after the upload returns. A watermark set before the file
    // lands would report a backup that does not exist, which is worse than
    // reporting none: it is the reassurance without the copy.
    await setBackupWatermark(env, new Date().toISOString());

    // After the watermark, and in its own try. The CSVs are the thing this
    // feature promises and the images are the thing it should also carry; a
    // bucket having a bad night must not make the night read as "no backup",
    // because that is the one signal anybody watches.
    // Three sweeps, three separate tries. They share nothing but a token, and
    // a folder lookup failing in one is no reason for the other two not to run
    // — the images, the attachments and the notice documents are independent
    // records, and a night that saves two of the three beats a night that
    // saves none.
    const sweep = async (fn, fallback) => {
      try {
        return await fn(env, token);
      } catch (err) {
        await reportError(env, err?.code ?? 'DDP-SYS-003', err, ctx);
        return fallback;
      }
    };
    const proofs = await sweep(backupProofs, { copied: 0, failed: 0 });
    const attachments = await sweep(backupAttachments, { copied: 0, failed: 0 });
    const notices = await sweep(backupNotices, { written: 0, failed: 0 });

    return {
      uploaded: uploaded.name, tables: Object.keys(files).length,
      bytes: content.length, proofs, attachments, notices,
    };
  } catch (err) {
    await reportError(env, err?.code ?? 'DDP-SYS-003', err, ctx);
    return { failed: true };
  }
}

async function setBackupWatermark(env, at) {
  await env.DB.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).bind(BACKUP_SETTING, at).run();
}

/**
 * Confirms the backup path still works WITHOUT writing a file. Exists because
 * the failure mode is silence: a dead refresh token looks exactly like a quiet
 * night until the day you need the data.
 */
export async function backupHealth(env) {
  // Reported whatever the token says. A valid token with no file behind it is
  // the exact state this system has been in since phase 8, and the reassuring
  // half of the answer was the only half being shown.
  const mark = await env.DB.prepare('SELECT value FROM settings WHERE key = ?')
    .bind(BACKUP_SETTING).first();
  const lastBackupAt = mark?.value ?? null;

  if (!driveConfigured(env)) return { ok: false, reason: 'not-configured', lastBackupAt };
  try {
    // The backup's own credentials, not the shared ones: a valid mail token
    // says nothing about whether tonight's upload can authenticate.
    await refreshAccessToken(env, backupCredentials(env));
    return { ok: true, lastBackupAt };
  } catch (err) {
    return { ok: false, reason: err?.code ?? 'token-refresh-failed', lastBackupAt };
  }
}
