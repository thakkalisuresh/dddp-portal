import { describe, it, expect, afterEach } from 'vitest';
import {
  toCsv, toCsvValue, stripSecrets, bundle, cutoffFor, backupFilename,
  driveConfigured, backupCredentials, sharedCredentials, TABLES, RETENTION_DAYS,
  monthFolderName, ensureMonthFolder, uploadToDrive, BACKUP_CRON, isBackupCron,
} from '../functions/lib/backup.js';
import { mailConfigured } from '../functions/lib/mailer.js';

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
    let body = '';
    globalThis.fetch = async (url, init) => {
      body = String(init?.body ?? '');
      return ok({ id: 'F', name: 'diamond-park-2026-08-12.csv' });
    };
    await uploadToDrive(env, {
      name: 'diamond-park-2026-08-12.csv', content: 'a,b\n1,2\n',
      parentId: 'AUG', token: 'tok',
    });
    expect(body).toContain('"parents":["AUG"]');
    expect(body).not.toContain('"parents":["PARENT"]');
  });
});
