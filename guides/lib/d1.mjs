/**
 * Local D1 access for the guide pipeline.
 *
 * Goes through `wrangler d1 execute --local` rather than opening the miniflare
 * sqlite file directly. The file's name is a content hash that changes when the
 * binding changes, so a direct path is a footgun that works until it silently
 * doesn't. This is the same call seed-notices.mjs makes.
 */
import { execFileSync } from 'node:child_process';

const REPO = new URL('../../', import.meta.url).pathname;

export function exec(sql) {
  return execFileSync(
    'npx',
    ['wrangler', 'd1', 'execute', 'dddp', '--local', '--command', sql, '--json'],
    { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024 },
  );
}

/** Run a query and return its rows. */
export function query(sql) {
  const out = exec(sql);
  const start = out.indexOf('[');
  if (start === -1) return [];
  try {
    const parsed = JSON.parse(out.slice(start));
    return parsed?.[0]?.results ?? [];
  } catch {
    return [];
  }
}

export const q = (v) => (v == null ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);
