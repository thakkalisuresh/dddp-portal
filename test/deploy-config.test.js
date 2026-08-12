/**
 * The two wrangler.toml files describe two deployments over ONE database, and
 * a handful of values have to agree between them or production misbehaves in
 * ways no unit test would otherwise catch.
 *
 * This exists because of PBKDF2_ITERATIONS. Both entry points hash into the
 * same `owners` table, and login re-hashes a password whose stored count is not
 * the current target. If the site says 200000 and the cron Worker still says
 * 100000, the two do not merely disagree — they undo each other, and a resident
 * who logs in through the site has their hash rewritten at a count the other
 * deployment will rewrite straight back. Every login pays for an extra derive,
 * forever, and nothing ever looks broken.
 *
 * Reading the TOML with a regex rather than a parser is deliberate: adding a
 * dependency to check a dependency-free config is the wrong trade, and the
 * shape being matched is three lines this repo writes by hand.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const read = (p) => readFileSync(join(root, p), 'utf8');
const varOf = (toml, key) => toml.match(new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, 'm'))?.[1];

const worker = read('wrangler.toml');        // cron only, no public route
const pages  = read('pages/wrangler.toml');  // the site residents use

describe('the two deployments agree where they must', () => {
  // Everything here is read by code that writes to the shared D1, so a
  // difference is a behaviour difference and not a formatting one.
  for (const key of ['PBKDF2_ITERATIONS', 'UPI_VPA', 'UPI_PAYEE']) {
    it(`${key} matches in both wrangler.toml files`, () => {
      const a = varOf(worker, key);
      const b = varOf(pages, key);
      expect(a, `${key} missing from wrangler.toml`).toBeDefined();
      expect(b, `${key} missing from pages/wrangler.toml`).toBeDefined();
      expect(b, `${key} differs: worker=${a} pages=${b} — change both or neither`).toBe(a);
    });
  }

  it('binds the same D1 database, since that is the whole premise', () => {
    const id = (t) => t.match(/^database_id\s*=\s*"([^"]*)"/m)?.[1];
    expect(id(pages)).toBe(id(worker));
  });
});

describe('the iteration count itself', () => {
  const iterations = Number(varOf(worker, 'PBKDF2_ITERATIONS'));

  it('is a plain positive integer', () => {
    // "200_000" is valid JS and not valid here: TOML gives it to the Worker as
    // a string, Number() makes it NaN, and PBKDF2 would be asked for NaN
    // rounds. Fail in CI rather than at somebody's login.
    expect(Number.isInteger(iterations)).toBe(true);
    expect(iterations).toBeGreaterThan(0);
  });

  it('never drops below what rows were already written at', () => {
    // Lowering is SAFE for existing hashes — they carry their own count and
    // keep verifying — but it silently weakens every password re-hashed after
    // the change, and it would not show up anywhere. 100000 is the floor this
    // project shipped with; going under it should be a deliberate edit here.
    expect(iterations).toBeGreaterThanOrEqual(100_000);
  });

  it('stays inside what the edge was measured to afford', () => {
    // One derive measured ~27 ms of CPU on deployed Cloudflare at 100000, and
    // PBKDF2 is linear. 600000 would be ~162 ms on a request that also does
    // six D1 round trips. OWASP asks for 600000; this building has not shown
    // it can pay for that, and the honest ceiling is the one that was measured
    // rather than the one that was recommended. Raise this line WITH a fresh
    // `wrangler tail` reading, not ahead of one.
    expect(iterations).toBeLessThanOrEqual(300_000);
  });
});
