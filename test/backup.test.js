import { describe, it, expect } from 'vitest';
import {
  toCsv, toCsvValue, stripSecrets, bundle, cutoffFor, backupFilename,
  driveConfigured, TABLES, RETENTION_DAYS,
} from '../functions/lib/backup.js';

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
});
