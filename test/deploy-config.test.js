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

  it('never exceeds 100000, which is the PLATFORM cap and not a preference', () => {
    // This assertion exists because the bound it replaces was wrong and shipped.
    // It was set to 300000 on the theory that CPU was the constraint; 200000
    // then took production login down with a 500 on every attempt:
    //
    //   NotSupportedError: Pbkdf2 failed: iteration counts above 100000 are
    //   not supported (requested 200000).
    //
    // Cloudflare refuses it outright, so there is nothing to tune. The CPU
    // headroom is real — a 32 ms login returns "ok" — and irrelevant.
    //
    // THE TEST IS THE ONLY GUARD THERE IS. `wrangler dev --local` accepts
    // 600000 without complaint, so neither a local run nor a green suite would
    // catch a raise; the failure appears for the first time on a deployed URL,
    // in front of residents. Do not relax this without evidence from a real
    // deployment that the cap has moved.
    expect(iterations).toBeLessThanOrEqual(100_000);
  });
});

describe('staging points at staging, and nowhere near production', () => {
  // The [env.staging] block is a THIRD copy of the shared vars, because
  // wrangler does not inherit bindings into an env. The whole hazard the file
  // above documents applies to it too, so it is checked the same way.
  //
  // Everything here reads one TOML section rather than the file, since the
  // top-level values appear earlier and a file-wide regex would match those
  // and pass while staging said something else entirely.
  const section = (toml, header) => {
    const start = toml.indexOf(`[${header}]`);
    if (start === -1) return null;
    const rest = toml.slice(start + header.length + 2);
    const next = rest.search(/^\s*\[/m);
    return next === -1 ? rest : rest.slice(0, next);
  };

  const PROD_DB = '56951152-d3c7-4476-a779-9ef9afe0b4d8';
  const STAGING_DB = 'adf039cd-4cec-4e66-9395-fd4a548cd01c';

  it('binds the staging database, not the production one', () => {
    // The assertion that actually matters. A copy-paste of the prod id into
    // this block turns `deploy --env staging` into an unannounced production
    // deploy of the cron Worker -- against real bills, with a real late-fee
    // job. Nothing else in the suite would notice.
    const staging = section(worker, 'env.staging.d1_databases');
    expect(staging, '[[env.staging.d1_databases]] missing from wrangler.toml').toBeTruthy();
    expect(staging).toContain(STAGING_DB);
    expect(staging, 'staging is bound to the PRODUCTION database').not.toContain(PROD_DB);
  });

  it('writes proofs to the staging bucket, not the real one', () => {
    // Same shape of mistake, quieter consequence: test payment screenshots
    // filed among residents' real ones, and swept to Drive at 3am with them.
    const staging = section(worker, 'env.staging.r2_buckets');
    expect(staging).toContain('dddp-proofs-staging');
  });

  it('keeps the shared vars in step with the other two copies', () => {
    const vars = section(worker, 'env.staging.vars');
    expect(vars, '[env.staging.vars] missing from wrangler.toml').toBeTruthy();
    for (const key of ['PBKDF2_ITERATIONS', 'UPI_VPA', 'UPI_PAYEE']) {
      const staged = vars.match(new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, 'm'))?.[1];
      expect(staged, `${key} missing from [env.staging.vars]`).toBeDefined();
      expect(staged, `${key} drifted in [env.staging.vars]`).toBe(varOf(worker, key));
    }
  });

  it('declares no crons, so a staging deploy cannot fire the money job', () => {
    // Triggers are inheritable, so an [env.staging.triggers] block is the only
    // way this env gets a schedule -- and it must not have one. A staging
    // deploy carrying the late-fee cron would charge fees on its own timer
    // using the association's real Telegram and Google secrets.
    expect(worker).not.toContain('[env.staging.triggers]');
  });
});

describe('the site keeps previews off production', () => {
  // A DEPLOYED preview reads [env.preview] and nothing else. preview_database_id
  // is a Workers key that Pages ignores at deploy time; a config carrying only
  // that line looks right and serves production data to the staging site, which
  // is how it shipped the first time. Both are asserted, for different reasons:
  // [env.preview] covers deploys, preview_database_id covers `pages dev`.
  const PROD_DB = '56951152-d3c7-4476-a779-9ef9afe0b4d8';

  it('has an [env.preview] block, which is the part Pages actually reads', () => {
    expect(pages, 'no [env.preview] -- deployed previews will read PRODUCTION').toContain(
      '[env.preview]'
    );
  });

  it('points deployed previews at the staging database, not production', () => {
    const block = pages.slice(pages.indexOf('[[env.preview.d1_databases]]'));
    const id = block.match(/^database_id\s*=\s*"([^"]*)"/m)?.[1];
    expect(id).toBe('adf039cd-4cec-4e66-9395-fd4a548cd01c');
    expect(id, 'previews are bound to the PRODUCTION database').not.toBe(PROD_DB);
  });

  it('points deployed previews at the staging bucket', () => {
    const block = pages.slice(pages.indexOf('[[env.preview.r2_buckets]]'));
    expect(block.match(/^bucket_name\s*=\s*"([^"]*)"/m)?.[1]).toBe('dddp-proofs-staging');
  });

  it('keeps local `pages dev` off production too', () => {
    expect(pages).toMatch(/^preview_database_id\s*=\s*"adf039cd-/m);
    expect(pages).toMatch(/^preview_bucket_name\s*=\s*"dddp-proofs-staging"/m);
  });
});
