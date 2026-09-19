/**
 * The console's hash links must go somewhere, and must be able to go there.
 *
 * Three links in the Maintenance tab were dead at once, and the whole suite
 * passed while they were. Two failure modes, both invisible to every other
 * test because they need a DOM:
 *
 *   1. The destination did not exist. "Preview an email" pointed at
 *      `/admin/#messages`, and Messages stopped being a tab in the fourteen-to-
 *      eight consolidation. `show()` falls back to the first visible tab, so
 *      the button did not error — it quietly meant Home.
 *
 *   2. Nothing routed a hash change. Writing `/admin/#bills` from a page that
 *      already IS `/admin/` is a same-document hash change: no reload, `init`
 *      never runs again, the panel does not move. Every one of these links is
 *      a string assignment, so there is nothing for a test to observe and
 *      nothing for the eye to notice either — the button simply does nothing.
 *
 * This is static, like `public-js.test.js`, and for the same reason: these
 * files are served as written and the cheapest guard that would have caught
 * both is a read of the source.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const CONSOLE = 'public/js/admin-console.js';

/** The tab ids the console will actually render, read from TABS itself. */
function tabIds() {
  const src = readFileSync(CONSOLE, 'utf8');
  const block = /const TABS = \[([\s\S]*?)\n\];/.exec(src);
  expect(block, 'TABS array not found — this test is reading the wrong file').toBeTruthy();
  return new Set([...block[1].matchAll(/\bid:\s*'([^']+)'/g)].map((m) => m[1]));
}

/**
 * Comments blanked, newlines kept.
 *
 * A comment explaining a dead link is not a dead link — this test's own
 * subject was documented in the file it scans, and the scan read the
 * explanation as the defect.
 */
function code(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, lead) => lead + ' '.repeat(m.length - lead.length));
}

/** Every `/admin/#something` written anywhere in the browser modules. */
function hashLinks() {
  const found = [];
  for (const name of readdirSync('public/js')) {
    if (!name.endsWith('.js')) continue;
    const file = join('public/js', name);
    const src = code(readFileSync(file, 'utf8'));
    for (const m of src.matchAll(/\/admin\/#([a-z0-9-]+)/gi)) {
      // Line number, because "one of these is wrong" is not a useful failure.
      const line = src.slice(0, m.index).split('\n').length;
      found.push({ where: `${file}:${line}`, id: m[1] });
    }
  }
  return found;
}

describe('admin console hash links', () => {
  it('every /admin/#id names a tab that exists', () => {
    const ids = tabIds();
    const dead = hashLinks().filter((l) => !ids.has(l.id));
    expect(dead.map((d) => `${d.where} → #${d.id}`)).toEqual([]);
  });

  it('finds some, so the scan has not silently stopped matching', () => {
    expect(hashLinks().length).toBeGreaterThan(0);
  });

  it('the console routes a hash change, not only a page load', () => {
    const src = readFileSync(CONSOLE, 'utf8');
    expect(src).toMatch(/addEventListener\('hashchange'/);
  });
});
