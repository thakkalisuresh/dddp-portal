import { describe, it, expect } from 'vitest';
import { istDay, istHour, istToday } from '../functions/lib/time.js';
import { LATE_FEE_CRON } from '../functions/lib/cron.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');

describe('the IST day', () => {
  it('is still today at 18:29 UTC, and tomorrow at 18:31', () => {
    // The entire reason this module exists. The late-fee job runs at 18:30 UTC
    // precisely because that is 00:00 IST, so a UTC date computed inside that
    // job names YESTERDAY in Kerala and every fee lands a day late.
    expect(istDay('2026-08-19T18:29:00Z')).toBe('2026-08-19');
    expect(istDay('2026-08-19T18:31:00Z')).toBe('2026-08-20');
  });

  it('puts 18:30 UTC exactly at the start of the next IST day', () => {
    expect(istDay('2026-08-19T18:30:00Z')).toBe('2026-08-20');
    expect(istHour('2026-08-19T18:30:00Z')).toBe(0);
  });

  it('rolls the year over correctly', () => {
    expect(istDay('2026-12-31T18:30:00Z')).toBe('2027-01-01');
  });

  it('istToday takes an instant so tests can sit on the boundary', () => {
    expect(istToday('2026-08-19T18:31:00Z')).toBe('2026-08-20');
  });

  it('returns null rather than a wrong date for rubbish', () => {
    expect(istDay('not-a-date')).toBeNull();
  });
});

describe('the late-fee trigger', () => {
  it('matches the cron actually configured in wrangler.toml', () => {
    // A dispatcher branch keyed to a string that no trigger fires is a silent
    // no-op: nothing errors, nothing runs, and the only symptom is fees landing
    // eight hours late again at the 08:30 backstop.
    const toml = readFileSync(join(root, 'wrangler.toml'), 'utf8');
    const crons = toml.match(/^crons\s*=\s*\[(.*)\]/m)?.[1] ?? '';
    expect(crons).toContain(LATE_FEE_CRON);
  });

  it('is 18:30 UTC, which is midnight in Kerala', () => {
    const [minute, hour] = LATE_FEE_CRON.split(' ');
    expect(istHour(`2026-08-19T${hour}:${minute}:00Z`)).toBe(0);
  });
});
