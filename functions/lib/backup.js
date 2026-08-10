/**
 * Nightly backup, and retention.
 *
 * The point of this is not disaster recovery — D1 has Time Travel for that.
 * It is that the committee can open a CSV in Excel **without a developer**.
 * This whole project exists because one resident built a portal and walked
 * away; a backup nobody but a programmer can read repeats that mistake.
 */

import { reportError, fail } from './errors.js';

/** Every table worth carrying off-site, in dependency order. */
export const TABLES = [
  'flats', 'owners', 'periods', 'readings', 'bills',
  'payment_intents', 'payment_proofs', 'notices', 'comments',
  'committee', 'messages', 'audit_log',
];

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

export function driveConfigured(env) {
  return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
    && env.GOOGLE_REFRESH_TOKEN && env.GOOGLE_BACKUP_FOLDER_ID);
}

/**
 * A refresh token issued while the OAuth consent screen is in "Testing" mode
 * expires after seven days. That has bitten this author before: the backup
 * simply stops, silently, and nobody notices until they need it. Publish the
 * consent screen to Production, and rely on the health check below.
 */
export async function refreshAccessToken(env) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: env.GOOGLE_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) fail('DDP-SYS-008', { status: res.status, body: (await res.text()).slice(0, 200) });
  const body = await res.json();
  if (!body.access_token) fail('DDP-SYS-008', { reason: 'no access_token in response' });
  return body.access_token;
}

export async function uploadToDrive(env, { name, content, mimeType = 'text/csv' }) {
  const token = await refreshAccessToken(env);
  const boundary = `ddp${crypto.randomUUID()}`;
  const metadata = { name, parents: [env.GOOGLE_BACKUP_FOLDER_ID] };

  const body = [
    `--${boundary}`,
    'Content-Type: application/json; charset=UTF-8',
    '',
    JSON.stringify(metadata),
    `--${boundary}`,
    `Content-Type: ${mimeType}`,
    '',
    content,
    `--${boundary}--`,
    '',
  ].join('\r\n');

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

/** Watermark key. Mirrors `last_digest_at`, and for the same reason. */
export const BACKUP_SETTING = 'last_backup_at';

export async function runBackup(env, ctx) {
  if (!driveConfigured(env)) {
    // Not an error worth alerting on — it simply hasn't been set up yet.
    return { skipped: 'drive-not-configured' };
  }
  try {
    const files = await dumpAll(env);
    const content = bundle(files, { generatedAt: new Date().toISOString() });
    const uploaded = await uploadToDrive(env, { name: backupFilename(), content });
    // Written only after the upload returns. A watermark set before the file
    // lands would report a backup that does not exist, which is worse than
    // reporting none: it is the reassurance without the copy.
    await setBackupWatermark(env, new Date().toISOString());
    return { uploaded: uploaded.name, tables: Object.keys(files).length, bytes: content.length };
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
    await refreshAccessToken(env);
    return { ok: true, lastBackupAt };
  } catch (err) {
    return { ok: false, reason: err?.code ?? 'token-refresh-failed', lastBackupAt };
  }
}
