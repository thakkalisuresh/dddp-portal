import { describe, it, expect } from 'vitest';
import { unreadNoticeCount, markNoticesSeen } from '../functions/lib/notices.js';
import * as publicSite from '../functions/lib/public.js';

/**
 * B16 took notices off the public homepage. The badge is the other half: a
 * resident used to meet a notice without logging in, and removing that makes
 * notices invisible rather than private unless something says one is waiting.
 */

/** Enough D1 to answer a COUNT and record an UPDATE. */
function fakeDb({ count = 0 } = {}) {
  const writes = [];
  return {
    writes,
    prepare(sql) {
      return {
        bind: (...args) => ({
          first: async () => ({ n: count }),
          run: async () => { writes.push({ sql, args }); return {}; },
        }),
      };
    },
  };
}

describe('unread notices', () => {
  it('reports the count the database gives it', async () => {
    expect(await unreadNoticeCount({ DB: fakeDb({ count: 3 }) }, 12)).toBe(3);
  });

  it('reports zero rather than undefined when there is no row', async () => {
    const DB = { prepare: () => ({ bind: () => ({ first: async () => null }) }) };
    // A nav badge rendered from `undefined` shows nothing, which looks the same
    // as "nothing new" — the failure would be silent, so it is pinned here.
    expect(await unreadNoticeCount({ DB }, 12)).toBe(0);
  });

  it('normalises both sides of the comparison through datetime()', async () => {
    const DB = fakeDb();
    let sql;
    DB.prepare = (s) => { sql = s; return { bind: () => ({ first: async () => ({ n: 0 }) }) }; };
    await unreadNoticeCount({ DB }, 1);

    // The table holds two spellings — postNotice writes ISO from JavaScript,
    // SQL written with datetime('now') writes a space instead of the T. As raw
    // strings the space sorts BELOW the T, so a later notice reads as older and
    // the badge silently stops appearing. Measured, not assumed:
    //   '2026-08-09 19:20:00' > '2026-08-09T19:19:00.000Z'  is false.
    expect(sql).toContain('datetime(posted_at)');
    expect(sql).toMatch(/datetime\(COALESCE/);
    expect(sql).toContain('notices_seen_at');
    expect(sql).toContain('active = 1');
  });

  it('falls back to 1970, not the empty string', async () => {
    const DB = fakeDb();
    let sql;
    DB.prepare = (s) => { sql = s; return { bind: () => ({ first: async () => ({ n: 0 }) }) }; };
    await unreadNoticeCount({ DB }, 1);

    // datetime('') is NULL, which would take the whole comparison NULL and
    // leave a resident who has never opened the board with no badge — the one
    // person it exists for.
    expect(sql).toContain("'1970-01-01'");
    expect(sql).not.toMatch(/COALESCE\([^)]*,\s*''\s*\)/);
  });
});

describe('marking the board as seen', () => {
  it('stamps the given owner and returns the timestamp used', async () => {
    const DB = fakeDb();
    const at = await markNoticesSeen({ DB }, 7, '2026-08-09T10:00:00.000Z');
    expect(at).toBe('2026-08-09T10:00:00.000Z');
    expect(DB.writes).toHaveLength(1);
    expect(DB.writes[0].sql).toContain('UPDATE owners SET notices_seen_at');
    expect(DB.writes[0].args).toEqual(['2026-08-09T10:00:00.000Z', 7]);
  });
});

describe('the public site cannot serve a notice', () => {
  it('exposes no notice reader at all', () => {
    // Not "returns an empty list" — the function is gone. An unused export is
    // an invitation to wire it back up, and the reason not to is not visible
    // from the function itself.
    expect(publicSite.publicNotices).toBeUndefined();
    expect(Object.keys(publicSite).some((k) => /notice/i.test(k))).toBe(false);
  });
});
