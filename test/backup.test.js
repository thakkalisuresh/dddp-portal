import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import {
  toCsv, toCsvValue, stripSecrets, bundle, cutoffFor, backupFilename,
  driveConfigured, backupCredentials, sharedCredentials, TABLES, RETENTION_DAYS,
  monthFolderName, ensureMonthFolder, uploadToDrive, BACKUP_CRON, isBackupCron,
  backupProofs, proofBackupName, PROOF_BATCH, backupAttachments,
  committeeFolder, committeeFolderSeparate, noticeFolderName, NEVER_BACKUP,
  archiveConfigured, archiveKey, writeMonthlyArchive, ARCHIVE_SETTING, maskForViewer,
} from '../functions/lib/backup.js';
import { mailConfigured } from '../functions/lib/mailer.js';
import { testEnv, seed, rows } from './support/d1.js';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The tables production actually has, replayed from migrations/ in order.
 *
 * Replayed rather than regex-collected, because 0030 rebuilds `owners` the
 * SQLite way — create `owners_new`, drop `owners`, rename — and a plain grep
 * for CREATE TABLE reports a table called owners_new that has never existed
 * and an owners table that no longer does. Applying the three statements in
 * file order is the only reading that gets both right.
 */
function schemaTables() {
  const tables = new Set();
  for (const file of readdirSync(join(root, 'migrations')).filter((f) => f.endsWith('.sql')).sort()) {
    const sql = readFileSync(join(root, 'migrations', file), 'utf8')
      .replace(/--[^\n]*/g, '');
    for (const m of sql.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?([a-z_]+)/gi)) {
      tables.add(m[1]);
    }
    for (const m of sql.matchAll(/DROP TABLE (?:IF EXISTS )?([a-z_]+)/gi)) {
      tables.delete(m[1]);
    }
    for (const m of sql.matchAll(/ALTER TABLE ([a-z_]+) RENAME TO ([a-z_]+)/gi)) {
      tables.delete(m[1]);
      tables.add(m[2]);
    }
  }
  return tables;
}

describe('CSV that survives real resident data', () => {
  it('quotes a value containing a comma', () => {
    // The naive join(',') breaks here and silently shifts every later column,
    // which is worse than failing because the file still opens.
    expect(toCsvValue('Nair, Sabarish')).toBe('"Nair, Sabarish"');
  });

  it('escapes embedded quotes by doubling them', () => {
    expect(toCsvValue('He said "no"')).toBe('"He said ""no"""');
  });

  it('quotes newlines, which comments genuinely contain', () => {
    expect(toCsvValue('line one\nline two')).toBe('"line one\nline two"');
  });

  it('leaves plain values alone', () => {
    expect(toCsvValue('4A')).toBe('4A');
    expect(toCsvValue(329.04)).toBe('329.04');
  });

  it('defuses a cell a spreadsheet would run as a formula', () => {
    expect(toCsvValue('=HYPERLINK("http://x","pay")')).toBe(`"'=HYPERLINK(""http://x"",""pay"")"`);
    expect(toCsvValue('+cmd|x')).toBe("'+cmd|x");
    expect(toCsvValue('-2+3')).toBe("'-2+3");
    expect(toCsvValue('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(toCsvValue('\t=1')).toBe("'\t=1");
  });

  it('leaves mobiles and negative amounts as numbers', () => {
    expect(toCsvValue('+919567791515')).toBe('+919567791515');
    expect(toCsvValue(-150)).toBe('-150');
    expect(toCsvValue('-12.5')).toBe('-12.5');
  });

  it('renders null as empty, not as the word null', () => {
    expect(toCsvValue(null)).toBe('');
    expect(toCsvValue(undefined)).toBe('');
  });

  it('round-trips a row with every awkward character at once', () => {
    const csv = toCsv([{ flat: '4A', note: 'Paid, "in full"\nthanks' }]);
    expect(csv).toBe('flat,note\n4A,"Paid, ""in full""\nthanks"\n');
  });

  it('emits a header even when there are no rows', () => {
    expect(toCsv([], { columns: ['flat', 'total'] })).toBe('flat,total\n');
  });
});

describe('passwords never leave the database', () => {
  const rows = [{ id: 1, name: 'Sabarish', pw_hash: 'SECRET', pw_salt: 'SALT', mobile: '9567791515' }];

  it('strips hash and salt from the rows', () => {
    const out = stripSecrets(rows)[0];
    expect(out.pw_hash).toBeUndefined();
    expect(out.pw_salt).toBeUndefined();
    expect(out.name).toBe('Sabarish');
  });

  it('strips them from the CSV even if asked for explicitly', () => {
    const csv = toCsv(rows, { columns: ['id', 'pw_hash', 'pw_salt', 'name'] });
    expect(csv).not.toContain('SECRET');
    expect(csv).not.toContain('SALT');
    expect(csv).not.toContain('pw_hash');
  });

  it('does not mutate the caller\'s rows', () => {
    stripSecrets(rows);
    expect(rows[0].pw_hash).toBe('SECRET');
  });
});

describe('the bundle a committee member opens', () => {
  it('labels each table and says when it was made', () => {
    const out = bundle({ 'bills.csv': 'flat,total\n4A,329.04\n' }, { generatedAt: '2026-08-07T00:00:00Z' });
    expect(out).toContain('### bills.csv');
    expect(out).toContain('Generated 2026-08-07');
    expect(out).toContain('4A,329.04');
  });

  it('says plainly that passwords are excluded', () => {
    expect(bundle({}, { generatedAt: 'x' })).toMatch(/Passwords are never exported/);
  });

  it('covers every table that matters', () => {
    for (const t of ['bills', 'readings', 'owners', 'payment_proofs', 'audit_log', 'messages']) {
      expect(TABLES, t).toContain(t);
    }
  });

  it('does not back up the volatile tracking tables', () => {
    // They are pruned, not preserved — see RETENTION_DAYS.
    expect(TABLES).not.toContain('click_log');
    expect(TABLES).not.toContain('activity');
  });

  /**
   * The list above is the old guard, and it is why this one exists: six names
   * checked by hand cannot notice a SEVENTH table arriving. Nine did arrive,
   * over nine migrations, and the nightly backup reported success without them
   * — the reconciliations, the bill-edit approvals, the attachment metadata.
   *
   * So the schema is read from migrations/ rather than restated here. A new
   * CREATE TABLE now fails this test until somebody says out loud whether it
   * is backed up or deliberately not, which is the decision that went missing.
   */
  it('accounts for every table in the schema, one list or the other', () => {
    expect([...schemaTables()].filter((t) => !TABLES.includes(t) && !NEVER_BACKUP.has(t)))
      .toEqual([]);
  });

  it('names no table that the schema does not have', () => {
    const real = schemaTables();
    // NEVER_BACKUP holds d1_migrations, which wrangler creates and no migration
    // does; everything else in both lists must be a table that exists.
    const named = [...TABLES, ...NEVER_BACKUP].filter((t) => t !== 'd1_migrations');
    expect(named.filter((t) => !real.has(t))).toEqual([]);
  });

  it('never exports the session tokens', () => {
    // sessions.token IS the credential — it is the primary key, not a hash of
    // one — and stripSecrets only knows about pw_hash and pw_salt. A backup
    // carrying this table writes every live login into a CSV in somebody's
    // personal Drive.
    expect(TABLES).not.toContain('sessions');
    expect(TABLES).not.toContain('password_resets');
    expect(NEVER_BACKUP.has('sessions')).toBe(true);
    expect(NEVER_BACKUP.has('password_resets')).toBe(true);
    // A table of nothing but old credentials. Exporting it would break the
    // bundle's own header more thoroughly than any other table could.
    expect(NEVER_BACKUP.has('password_history')).toBe(true);
    expect(TABLES).not.toContain('password_history');
  });

  it('backs up the records a dispute turns on', () => {
    for (const t of ['reconciliations', 'bill_edit_requests', 'bill_edit_approvals',
      'attachments', 'meter_changes', 'settings']) {
      expect(TABLES, t).toContain(t);
    }
  });

  it('restores parents before children', () => {
    // dumpAll writes in TABLES order and a restore reads it back the same way,
    // so a child table listed above its parent fails on the foreign key.
    const parents = {
      owners: 'flats', readings: 'periods', bills: 'periods',
      payment_proofs: 'bills', comments: 'notices', attachments: 'notices',
      statement_credits: 'statement_sessions',
      reconciliations: 'statement_sessions',
      bill_edit_approvals: 'bill_edit_requests',
      bill_edit_requests: 'bills',
    };
    for (const [child, parent] of Object.entries(parents)) {
      expect(TABLES.indexOf(parent), `${parent} before ${child}`)
        .toBeLessThan(TABLES.indexOf(child));
    }
  });
});

describe('retention', () => {
  const now = Date.UTC(2026, 7, 7);

  it('prunes clicks hardest — the most invasive and least valuable', () => {
    expect(RETENTION_DAYS.click_log).toBeLessThan(RETENTION_DAYS.activity);
    expect(RETENTION_DAYS.activity).toBeLessThan(RETENTION_DAYS.error_log);
  });

  it('never prunes the audit trail, which is what makes admins accountable', () => {
    expect(RETENTION_DAYS.audit_log).toBeUndefined();
    expect(cutoffFor('audit_log', now)).toBe(null);
  });

  it('computes a cutoff 30 days back for clicks', () => {
    expect(cutoffFor('click_log', now)).toBe('2026-07-08T00:00:00.000Z');
  });
});

describe('drive configuration', () => {
  const full = {
    GOOGLE_CLIENT_ID: 'a', GOOGLE_CLIENT_SECRET: 'b',
    GOOGLE_REFRESH_TOKEN: 'c', GOOGLE_BACKUP_FOLDER_ID: 'd',
  };

  it('is only configured when every part is present', () => {
    expect(driveConfigured(full)).toBe(true);
    for (const key of Object.keys(full)) {
      expect(driveConfigured({ ...full, [key]: undefined }), key).toBe(false);
    }
  });

  it('names the file by date, so a folder sorts chronologically', () => {
    expect(backupFilename(new Date('2026-08-07T22:00:00Z'))).toBe('diamond-park-2026-08-07.csv');
  });

  // The backup writes to a committee member's personal Drive, because files
  // are charged to the account that creates them and the association's own
  // quota is for the association's own documents. The reset emails must still
  // come from the association.
  describe('the backup can run under its own account', () => {
    const split = {
      ...full,
      GOOGLE_BACKUP_CLIENT_ID: 'A', GOOGLE_BACKUP_CLIENT_SECRET: 'B',
      GOOGLE_BACKUP_REFRESH_TOKEN: 'C',
    };

    it('prefers the backup credentials when they are set', () => {
      expect(backupCredentials(split))
        .toEqual({ clientId: 'A', clientSecret: 'B', refreshToken: 'C' });
    });

    it('falls back to the shared ones, so one account is still a valid setup', () => {
      expect(backupCredentials(full))
        .toEqual({ clientId: 'a', clientSecret: 'b', refreshToken: 'c' });
    });

    it('leaves the mail path on the association account regardless', () => {
      expect(sharedCredentials(split))
        .toEqual({ clientId: 'a', clientSecret: 'b', refreshToken: 'c' });
    });

    it('is configured on the backup credentials alone, without the shared set', () => {
      const backupOnly = {
        GOOGLE_BACKUP_CLIENT_ID: 'A', GOOGLE_BACKUP_CLIENT_SECRET: 'B',
        GOOGLE_BACKUP_REFRESH_TOKEN: 'C', GOOGLE_BACKUP_FOLDER_ID: 'd',
      };
      expect(driveConfigured(backupOnly)).toBe(true);
      // Mail is a separate question with a separate answer, and this must not
      // borrow the backup's account to answer it.
      expect(mailConfigured({ ...backupOnly, MAIL_FROM: 'x@y.z' })).toBe(false);
    });

    it('still needs a folder, whichever account is used', () => {
      expect(driveConfigured({ ...split, GOOGLE_BACKUP_FOLDER_ID: undefined })).toBe(false);
    });
  });
});

describe('the backup has its own cron', () => {
  // Moved off the 03:00 UTC job because that one sends the Telegram digest, and
  // a digest arriving at 3:30am is a notification people mute.
  it('claims 22:00 UTC, which is 03:30 IST', () => {
    expect(BACKUP_CRON).toBe('0 22 * * *');
  });

  it('runs the backup on its own trigger and nothing else', () => {
    expect(isBackupCron('0 22 * * *')).toBe(true);
    expect(isBackupCron('0 3 * * *')).toBe(false);
  });

  // A scheduled event with no cron string must not be mistaken for the backup's
  // trigger: silently backing up on the digest run would double the uploads and
  // put the digest's own failures on the wrong watermark.
  it('treats an unknown or absent trigger as not the backup', () => {
    expect(isBackupCron(undefined)).toBe(false);
    expect(isBackupCron('')).toBe(false);
    expect(isBackupCron('0 22 * * 1')).toBe(false);
  });
});

// The CSVs carry the record of a payment; R2 carries the evidence. Lose the
// bucket and the committee can say a payment was approved but cannot show what
// was claimed — which is exactly the position a dispute puts them in.
describe('the proof images go too', () => {
  const ok = (body) => ({ ok: true, json: async () => body });

  afterEach(() => { globalThis.fetch = undefined; });

  it('names a file by flat and reference, so a folder is searchable', () => {
    expect(proofBackupName({ flat: '4A', utr: '402318889021' })).toBe('4A-402318889021.jpg');
  });

  it('falls back to the hash when nothing could be read off the screenshot', () => {
    expect(proofBackupName({ flat: '13E', utr: null, image_sha256: 'abc123def456789' }))
      .toBe('13E-abc123def456.jpg');
  });

  it('keeps the real extension, because not every proof is a JPEG', () => {
    expect(proofBackupName({ flat: '4A', utr: 'T2508' }, 'image/png')).toBe('4A-T2508.png');
    expect(proofBackupName({ flat: '4A', utr: 'T2508' }, 'image/webp')).toBe('4A-T2508.webp');
  });

  const envWith = (rows, objects) => ({
    GOOGLE_BACKUP_FOLDER_ID: 'PARENT',
    DB: {
      prepare(sql) {
        return {
          bind(...args) { return this._b(sql, args); },
          _b(s, args) {
            return {
              all: async () => ({ results: rows }),
              run: async () => { updates.push({ sql: s, args }); return {}; },
            };
          },
          all: async () => ({ results: rows }),
        };
      },
    },
    PROOFS: { get: async (key) => objects[key] ?? null },
  });
  let updates = [];
  beforeEach(() => { updates = []; });

  const image = { httpMetadata: { contentType: 'image/jpeg' }, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };

  it('copies a proof and records that it did', async () => {
    const env = envWith(
      [{ id: 7, r2_key: 'proofs/2026-07/4A/abc.jpg', utr: '402318889021', image_sha256: 'abc', flat: '4A', period: '2026-07' }],
      { 'proofs/2026-07/4A/abc.jpg': image }
    );
    globalThis.fetch = async (url, init) => (init?.method === 'POST' || String(url).includes('upload')
      ? ok({ id: 'F', name: '4A-402318889021.jpg' })
      : ok({ files: [{ id: 'DIR' }] }));

    const out = await backupProofs(env, 'tok');
    expect(out).toMatchObject({ copied: 1, failed: 0 });
    // The mark is what stops it being copied again every night for ever.
    expect(updates[0].sql).toContain('UPDATE payment_proofs SET backed_up_at');
    expect(updates[0].args[1]).toBe(7);
  });

  it('does not mark a proof whose image is missing from the bucket', async () => {
    const env = envWith(
      [{ id: 8, r2_key: 'gone.jpg', utr: 'x', image_sha256: 'h', flat: '4A', period: '2026-07' }],
      {}
    );
    globalThis.fetch = async () => ok({ files: [{ id: 'DIR' }] });

    const out = await backupProofs(env, 'tok');
    expect(out).toMatchObject({ copied: 0, failed: 1 });
    // Marking it would be a lie; a restored bucket must still get picked up.
    expect(updates).toHaveLength(0);
  });

  it('lets one bad image cost only itself', async () => {
    const env = envWith([
      { id: 1, r2_key: 'a.jpg', utr: 'a', image_sha256: 'h1', flat: '4A', period: '2026-07' },
      { id: 2, r2_key: 'b.jpg', utr: 'b', image_sha256: 'h2', flat: '4B', period: '2026-07' },
    ], { 'a.jpg': { ...image, arrayBuffer: async () => { throw new Error('read failed'); } }, 'b.jpg': image });
    globalThis.fetch = async (url, init) => (init?.method === 'POST' || String(url).includes('upload')
      ? ok({ id: 'F' })
      : ok({ files: [{ id: 'DIR' }] }));

    const out = await backupProofs(env, 'tok');
    expect(out).toMatchObject({ copied: 1, failed: 1 });
  });

  it('asks for no more than a batch, so a backlog cannot stall the night', async () => {
    let limit = null;
    const env = {
      GOOGLE_BACKUP_FOLDER_ID: 'PARENT',
      DB: { prepare: () => ({ bind: (n) => { limit = n; return { all: async () => ({ results: [] }) }; } }) },
      PROOFS: { get: async () => null },
    };
    const out = await backupProofs(env, 'tok');
    expect(limit).toBe(PROOF_BATCH);
    expect(out).toEqual({ copied: 0, failed: 0 });
  });

  it('touches Drive not at all when there is nothing to copy', async () => {
    let called = false;
    globalThis.fetch = async () => { called = true; return ok({}); };
    const env = {
      GOOGLE_BACKUP_FOLDER_ID: 'PARENT',
      DB: { prepare: () => ({ bind: () => ({ all: async () => ({ results: [] }) }) }) },
      PROOFS: { get: async () => null },
    };
    await backupProofs(env, 'tok');
    expect(called).toBe(false);
  });
});

describe('maintenance proofs are backed up too, from their own bucket', () => {
  // Real migrations, because the guarantee is the JOIN: backupProofs() used to
  // INNER JOIN `bills`, which silently dropped every maintenance proof (bill_id
  // is null on those), so maintenance payment evidence was never copied off-site.
  const image = () => ({
    httpMetadata: { contentType: 'image/jpeg' },
    arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
  });
  const driveOk = () => {
    globalThis.fetch = async (url, init) => (init?.method === 'POST' || String(url).includes('upload')
      ? { ok: true, json: async () => ({ id: 'F', name: 'x.jpg' }) }
      : { ok: true, json: async () => ({ files: [{ id: 'DIR' }] }) });
  };
  afterEach(() => { globalThis.fetch = undefined; });

  function seeded(extra = {}) {
    const { db, env } = testEnv({ GOOGLE_BACKUP_FOLDER_ID: 'PARENT', ...extra });
    seed(db, { flats: ['4B'], people: [{ id: 3, flat: '4B', relationship: 'tenant' }] });
    db.prepare(
      `INSERT INTO maint_quarters (quarter, owner_rate, tenant_rate, late_fee, issue_date, due_date, status, created_at)
       VALUES ('2026-Q4', 7500, 9000, 750, '2026-10-01', '2026-10-11', 'issued', '2026-09-24T00:00:00Z')`
    ).run();
    db.prepare(
      `INSERT INTO maint_bills (id, flat, quarter, owner_id, rate_applied, basis, late_fee, total, status, created_at)
       VALUES (1, '4B', '2026-Q4', 3, 9000, 'tenant', 0, 9000, 'unpaid', '2026-10-01T00:00:00Z')`
    ).run();
    return { db, env };
  }

  it('sweeps a maintenance proof and reads it from MAINT_PROOFS, not PROOFS', async () => {
    // PROOFS returns null: if backupProofs read the wrong bucket the object
    // would be "missing", counted failed and never marked. Only the maint bucket
    // holds it, so a copied:1 proves the query picked the maint proof up AND the
    // read used the right bucket.
    const { db, env } = seeded({
      PROOFS: { get: async () => null },
      MAINT_PROOFS: { get: async () => image() },
    });
    db.prepare(
      `INSERT INTO payment_proofs (bill_id, maint_bill_id, owner_id, r2_key, image_sha256, utr, parsed_amount, status, created_at)
       VALUES (NULL, 1, 3, 'proofs/2026-Q4/4B/abc.jpg', 'abc', '402318889021', 9000, 'pending', '2026-10-02T00:00:00Z')`
    ).run();
    driveOk();

    const out = await backupProofs(env, 'tok');
    expect(out).toMatchObject({ copied: 1, failed: 0 });
    const [p] = rows(db, 'SELECT backed_up_at FROM payment_proofs WHERE maint_bill_id = 1');
    expect(p.backed_up_at).not.toBeNull();
  });

  it('still routes a gas proof to PROOFS, not the maintenance bucket', async () => {
    const { db, env } = seeded({
      PROOFS: { get: async () => image() },
      MAINT_PROOFS: { get: async () => null },   // a gas proof must NOT be read here
    });
    db.prepare(
      `INSERT OR IGNORE INTO periods (period, rate_per_kg, conversion_factor, due_date, late_fee, status, created_at)
       VALUES ('2026-09', 60, 2.6, '2026-10-10', 50, 'open', '2026-09-01T00:00:00Z')`
    ).run();
    db.prepare(
      `INSERT INTO bills (id, flat, period, owner_id, consumption, meter_delta, rate_per_kg,
                          conversion_factor, gas_amount, other_charges, additional_charges,
                          late_fee, total, status, created_at)
       VALUES (50, '4B', '2026-09', 3, 4.0, 1.538, 60, 2.6, 240, 0, 0, 0, 240, 'unpaid', '2026-10-01T00:00:00Z')`
    ).run();
    db.prepare(
      `INSERT INTO payment_proofs (bill_id, maint_bill_id, owner_id, r2_key, image_sha256, utr, parsed_amount, status, created_at)
       VALUES (50, NULL, 3, 'proofs/2026-09/4B/def.jpg', 'def', '402318889099', 240, 'pending', '2026-10-02T00:00:00Z')`
    ).run();
    driveOk();

    const out = await backupProofs(env, 'tok');
    expect(out).toMatchObject({ copied: 1, failed: 0 });
    const [p] = rows(db, 'SELECT backed_up_at FROM payment_proofs WHERE bill_id = 50');
    expect(p.backed_up_at).not.toBeNull();
  });
});

// Sharing in Drive is per-folder and inherits downward, so the only way to
// share the committee's material without the roster is two folders.
describe('the committee folder is not the backup folder', () => {
  it('uses the committee folder when one is configured', () => {
    expect(committeeFolder({ GOOGLE_BACKUP_FOLDER_ID: 'B', GOOGLE_COMMITTEE_FOLDER_ID: 'C' }))
      .toBe('C');
  });

  it('falls back to the backup folder, so nothing breaks before it is set', () => {
    expect(committeeFolder({ GOOGLE_BACKUP_FOLDER_ID: 'B' })).toBe('B');
  });

  it('knows when the two are the same place, which doctor reports', () => {
    expect(committeeFolderSeparate({ GOOGLE_BACKUP_FOLDER_ID: 'B' })).toBe(false);
    expect(committeeFolderSeparate({ GOOGLE_BACKUP_FOLDER_ID: 'B', GOOGLE_COMMITTEE_FOLDER_ID: 'B' }))
      .toBe(false);
    expect(committeeFolderSeparate({ GOOGLE_BACKUP_FOLDER_ID: 'B', GOOGLE_COMMITTEE_FOLDER_ID: 'C' }))
      .toBe(true);
  });
});

describe('notice attachments', () => {
  it('names a folder by id and title, so a thread can be found', () => {
    expect(noticeFolderName({ id: 12, title: 'Water tank cleaning' }))
      .toBe('0012-water-tank-cleaning');
  });

  it('truncates a title that runs to a sentence', () => {
    const name = noticeFolderName({
      id: 3,
      title: 'The committee has decided that the water tank on Block B will be cleaned',
    });
    expect(name.length).toBeLessThanOrEqual(45);
    expect(name.startsWith('0003-')).toBe(true);
    expect(name.endsWith('-')).toBe(false);
  });

  it('survives a title with no usable characters at all', () => {
    expect(noticeFolderName({ id: 5, title: '!!!' })).toBe('0005');
    expect(noticeFolderName({ id: 5, title: null })).toBe('0005');
  });

  it('handles Malayalam titles without producing an empty slug trap', () => {
    // Nothing in the title survives slugification, which must still leave a
    // valid folder name rather than a bare hyphen.
    expect(noticeFolderName({ id: 9, title: 'ജല ടാങ്ക്' })).toBe('0009');
  });
});

// A year of nightly files in one folder is 365 rows to scroll, and the person
// this exists for is a treasurer looking for last March.
describe('one folder per month', () => {
  const env = { GOOGLE_BACKUP_FOLDER_ID: 'PARENT' };
  const ok = (body) => ({ ok: true, json: async () => body });

  afterEach(() => { globalThis.fetch = undefined; });

  it('names the folder in ISO order, so the list sorts itself', () => {
    expect(monthFolderName(new Date('2026-08-11T22:00:00Z'))).toBe('2026-08');
    expect(monthFolderName(new Date('2027-01-01T00:00:00Z'))).toBe('2027-01');
  });

  it('reuses the folder that is already there', async () => {
    const calls = [];
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), method: init?.method ?? 'GET' });
      return ok({ files: [{ id: 'AUG', name: '2026-08' }] });
    };
    expect(await ensureMonthFolder(env, 'tok', '2026-08')).toBe('AUG');
    // One lookup, and crucially no create — a second folder every night would
    // scatter the year across duplicates.
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('GET');
  });

  it('creates it on the first night of the month', async () => {
    const calls = [];
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), method: init?.method ?? 'GET', body: init?.body });
      return calls.length === 1 ? ok({ files: [] }) : ok({ id: 'SEP' });
    };
    expect(await ensureMonthFolder(env, 'tok', '2026-09')).toBe('SEP');
    expect(calls[1].method).toBe('POST');
    const sent = JSON.parse(calls[1].body);
    expect(sent).toMatchObject({
      name: '2026-09',
      mimeType: 'application/vnd.google-apps.folder',
      parents: ['PARENT'],
    });
  });

  it('searches inside the configured parent, and ignores trashed folders', async () => {
    const urls = [];
    globalThis.fetch = async (url) => {
      urls.push(decodeURIComponent(String(url)));
      return ok({ files: [] });
    };
    await ensureMonthFolder(env, 'tok', '2026-08').catch(() => {});
    const seen = urls[0];  // the lookup; urls[1] is the create that follows
    expect(seen).toContain("'PARENT' in parents");
    expect(seen).toContain('trashed = false');
    // Without this, two nights could disagree about which duplicate to use.
    expect(seen).toContain('orderBy=createdTime');
  });

  it('fails loudly rather than writing to the wrong place', async () => {
    globalThis.fetch = async () => ({ ok: false, status: 403, text: async () => 'nope' });
    await expect(ensureMonthFolder(env, 'tok', '2026-08')).rejects.toThrow();
  });

  it('uploads into the month folder, not the parent', async () => {
    let sent = null;
    globalThis.fetch = async (url, init) => {
      sent = init?.body;
      return ok({ id: 'F', name: 'diamond-park-2026-08-12.csv' });
    };
    await uploadToDrive(env, {
      name: 'diamond-park-2026-08-12.csv', content: 'a,b\n1,2\n',
      parentId: 'AUG', token: 'tok',
    });
    // A Blob now, because the same function also carries JPEGs.
    const body = await sent.text();
    expect(body).toContain('"parents":["AUG"]');
    expect(body).not.toContain('"parents":["PARENT"]');
    expect(body).toContain('a,b\n1,2\n');
  });
});

describe("the association's own archive", () => {
  /**
   * A fake bucket and a fake D1, because the two behaviours worth testing are
   * both about what is NOT written: no second object for a month that already
   * has one, and no watermark when the put never happened.
   */
  const fakeEnv = ({ objects = {} } = {}) => {
    const puts = [];
    const heads = [];
    const written = [];
    return {
      puts,
      heads,
      written,
      env: {
        ARCHIVE: {
          head: async (key) => { heads.push(key); return objects[key] ?? null; },
          put: async (key, body, opts) => {
            puts.push({ key, body, opts });
            objects[key] = { size: body.length };
          },
        },
        DB: {
          prepare: (sql) => ({
            bind: (...args) => ({ run: async () => { written.push({ sql, args }); } }),
          }),
        },
      },
    };
  };

  it('names one object per month, filed under its year', () => {
    expect(archiveKey(new Date('2026-09-11T22:00:00Z'))).toBe('snapshots/2026/2026-09.csv');
    expect(archiveKey(new Date('2027-01-31T22:00:00Z'))).toBe('snapshots/2027/2027-01.csv');
  });

  it('reads a missing binding as not configured rather than throwing', async () => {
    expect(archiveConfigured({})).toBe(false);
    // The staging deploy has no ARCHIVE binding at all, so this is the path
    // every rehearsed cron takes. It must be quiet, not an error row.
    const result = await writeMonthlyArchive({}, 'anything');
    expect(result).toEqual({ skipped: 'archive-not-configured' });
  });

  it('writes the month that is missing', async () => {
    const { env, puts, written } = fakeEnv();
    const at = new Date('2026-09-11T22:00:00Z');
    const result = await writeMonthlyArchive(env, 'a,b\n1,2\n', { now: at });

    expect(result.written).toBe(true);
    expect(puts).toHaveLength(1);
    expect(puts[0].key).toBe('snapshots/2026/2026-09.csv');
    expect(puts[0].opts.customMetadata.generatedAt).toBe(at.toISOString());
    // Watermark only after the put, so a failed write cannot report success.
    expect(written).toHaveLength(1);
    expect(written[0].args[0]).toBe(ARCHIVE_SETTING);
  });

  it('does not overwrite a month it already has', async () => {
    const { env, puts, heads, written } = fakeEnv({
      objects: { 'snapshots/2026/2026-09.csv': { size: 999 } },
    });
    const result = await writeMonthlyArchive(env, 'newer content', {
      now: new Date('2026-09-30T22:00:00Z'),
    });

    // This is the whole of "append-only". The cron runs 30 nights a month and
    // the 29 after the first must leave the snapshot alone -- an overwrite on
    // the 30th would silently replace a month's record with a later copy of a
    // database that has since been edited.
    expect(result).toEqual({ skipped: 'exists', key: 'snapshots/2026/2026-09.csv' });
    expect(heads).toHaveLength(1);
    expect(puts).toHaveLength(0);
    expect(written, 'a skipped write moved the watermark').toHaveLength(0);
  });
});

describe("an admin's download does not name the top rung", () => {
  const owners = [
    { id: 1, flat: '4A', role: 'superadmin' },
    { id: 2, flat: '10A', role: 'admin' },
    { id: 7, flat: '7B', role: 'owner' },
  ];
  const audit = [
    { id: 1, action: 'god.edit.owner.role', detail: '{"from":"admin","to":"superadmin"}' },
    { id: 2, action: 'god.view-as', detail: '{"flat":"10A"}' },
    { id: 3, action: 'superadmin.handover', detail: '{"from":1,"to":2}' },
    { id: 4, action: 'export.table', detail: '{"table":"bills"}' },
  ];

  it('leaves the nightly backup exactly as the database has it', () => {
    // No viewer is how runBackup calls it. A backup that rewrote rows would be
    // a backup that does not restore them.
    expect(maskForViewer('owners', owners, null)).toEqual(owners);
    expect(maskForViewer('audit_log', audit, null)).toEqual(audit);
  });

  it("leaves the superadmin's own download exactly as it is", () => {
    const viewer = { role: 'superadmin' };
    expect(maskForViewer('owners', owners, viewer)).toEqual(owners);
    expect(maskForViewer('audit_log', audit, viewer)).toEqual(audit);
  });

  it('lists the superadmin to an admin as an admin, and nobody else changes', () => {
    const out = maskForViewer('owners', owners, { role: 'admin' });
    expect(out.map((r) => r.role)).toEqual(['admin', 'admin', 'owner']);
  });

  it('relabels the audit log without dropping a single row', () => {
    const out = maskForViewer('audit_log', audit, { role: 'admin' });
    expect(out).toHaveLength(audit.length);
    expect(out.map((r) => r.action))
      .toEqual(['edit.owner.role', 'view-as', 'role.handover', 'export.table']);
    expect(out[0].detail).toBe('{"from":"admin","to":"admin"}');
    // The rows still say who did what and when -- only the words move.
    expect(out.map((r) => r.id)).toEqual([1, 2, 3, 4]);
  });

  it('never names either word anywhere in what an admin receives', () => {
    const text = JSON.stringify([
      maskForViewer('owners', owners, { role: 'admin' }),
      maskForViewer('audit_log', audit, { role: 'admin' }),
    ]);
    expect(text).not.toMatch(/superadmin|\bgod\b/i);
  });

  it("leaves other people's words alone", () => {
    // A resident who writes the word into a notice wrote it. That is content,
    // not a label this code chose, and rewriting it would be tampering.
    const notices = [{ id: 1, body: 'Ask the superadmin' }];
    expect(maskForViewer('notices', notices, { role: 'admin' })).toEqual(notices);
  });

  it('is applied to the download and kept off the backup, in the source', () => {
    // Handlers are not driven by tests here, so the wiring is asserted where it
    // lives. Getting either side wrong is silent: an unmasked download looks
    // like a download, and a masked backup looks like a backup.
    const index = readFileSync(join(root, 'functions/index.js'), 'utf8');
    const backup = readFileSync(join(root, 'functions/lib/backup.js'), 'utf8');
    expect(index).toMatch(/dumpTable\(env, table, \{ viewer: session\.actor \}\)/);
    expect(index).toMatch(/dumpAll\(env, \{ viewer: session\.actor \}\)/);
    expect(backup).toMatch(/files = await dumpAll\(env\);/);
  });
});
