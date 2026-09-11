#!/usr/bin/env node
/**
 * Build for Cloudflare Pages.
 *
 * Pages serves a directory, and an optional `_worker.js` at its root handles
 * every request. Our Worker is many ES modules, so it is bundled into that one
 * file; the static assets sit alongside it.
 *
 * Why Pages at all: it gives `diamondpark.pages.dev` instead of
 * `dddp-portal.dddp-portal.workers.dev`. Why the Worker ALSO stays deployed:
 * Pages Functions still have no cron triggers, and the nightly late-fee,
 * backup and prune job needs one. The Worker keeps its schedule with its
 * public route switched off. Same code, same D1, same R2.
 */

import { build } from 'esbuild';
import { execSync } from 'node:child_process';
import { cp, mkdir, rm, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The commit being built, printed on every alert as "Release:". "-dirty" when
 * the tree has uncommitted changes, because a build nobody can check out again
 * should not pass for the commit it started from.
 */
function release() {
  try {
    const sha = execSync('git rev-parse --short HEAD', { cwd: root }).toString().trim();
    const dirty = execSync('git status --porcelain', { cwd: root }).toString().trim();
    return dirty ? `${sha}-dirty` : sha;
  } catch {
    return 'unknown';
  }
}
const RELEASE = release();
// Pages rejects --config, so its wrangler.toml lives in pages/ and the
// build output must sit beside it.
const out = join(root, 'pages', 'dist');

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

// Static assets first, so _worker.js is never clobbered by a copy.
await cp(join(root, 'public'), out, { recursive: true });

await build({
  entryPoints: [join(root, 'functions', 'index.js')],
  outfile: join(out, '_worker.js'),
  bundle: true,
  format: 'esm',
  target: 'es2022',
  platform: 'neutral',
  // Pages runs the same runtime as Workers; keep the runtime globals external.
  conditions: ['workerd', 'worker', 'browser'],
  minify: false,          // readable in production stack traces
  sourcemap: false,
  define: { __RELEASE__: JSON.stringify(RELEASE) },
});

const files = await readdir(out);
console.log(`  dist/ built — ${files.length} entries, _worker.js bundled, release ${RELEASE}`);
