/**
 * The roster belongs to the superadmin, and belongs to them in three places.
 *
 * An import rewrites the whole resident directory from one paste, which is why
 * this went the opposite way to flat activation — that stayed with the admins
 * on 2026-08-12 because they walk the building, and one excluded flat is one
 * reversible row. A bad roster takes every resident's login with it.
 *
 * Three places, because two of them are only politeness: the tab strip hides
 * the link and the page prints a sentence, but the router is the guard. Losing
 * the router check while the other two stay would leave a screen that looks
 * refused and an API that is not — the exact shape of the bug B22 removed
 * elsewhere. Asserted against source, in the idiom of public-js.test.js, since
 * this suite has neither a DOM nor a database.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const router = readFileSync('functions/index.js', 'utf8');
const console_ = readFileSync('public/js/admin-console.js', 'utf8');
const page = readFileSync('public/js/admin-roster.js', 'utf8');

describe('the router refuses an admin the roster', () => {
  it('gates every /api/admin/roster/ route on superadmin', () => {
    // THE LOAD-BEARING ASSERTION. The four roster routes used to sit behind the
    // plain admins-only gate with no second check of their own.
    const block = router.match(
      /if \(path\.startsWith\('\/api\/admin\/roster\/'\)\) \{([\s\S]*?)\n        \}/
    )?.[1];
    expect(block, 'no roster block in the router').toBeTruthy();
    expect(block).toMatch(/hasRole\(session, 'superadmin'\)/);
    expect(block).toMatch(/return problem\(403/);
  });

  it('keeps all four roster routes inside that block', () => {
    // A route added outside it would be admin-reachable again, and nothing else
    // in this file would notice.
    const block = router.match(
      /if \(path\.startsWith\('\/api\/admin\/roster\/'\)\) \{([\s\S]*?)\n        \}/
    )?.[1] ?? '';
    for (const route of ['roster/preview', 'roster/import', 'roster/status', 'roster/sent/']) {
      expect(block, route).toContain(route);
    }
    const outside = router.replace(block, '');
    expect(outside).not.toMatch(/return rosterImport\(/);
  });
});

describe('the console does not offer what the router will refuse', () => {
  it('marks the Roster tab superadmin-only', () => {
    const tabs = console_.match(/const TABS = \[([\s\S]*?)\n\];/)?.[1] ?? '';
    const roster = tabs.split('\n').find((line) => line.includes("id: 'roster'")) ?? '';
    expect(roster, 'no roster tab found').toContain('roster');
    expect(roster).toContain('superadmin: true');
  });

  it('still hides the tab through the same filter as Errors', () => {
    // Both hidden tabs ride one test in renderTabs; a second mechanism for the
    // second tab is how one of them drifts.
    expect(console_).toMatch(/!t\.superadmin \|\| me\.role === 'superadmin'/);
  });
});

describe('the page says who it belongs to', () => {
  it('admits only the superadmin', () => {
    expect(page).toMatch(/me\.role !== 'superadmin'/);
    expect(page).not.toMatch(/me\.role !== 'admin' && me\.role !== 'superadmin'/);
  });

  it('names the administrator rather than saying "admins only"', () => {
    // An admin bounced off a page they used yesterday needs to know who to ask,
    // not that they are the wrong sort of person.
    expect(page).toMatch(/ADMINISTRATOR\.name/);
  });
});
