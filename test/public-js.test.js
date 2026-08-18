/**
 * Every browser module must at least PARSE.
 *
 * There is no build step here — `public/js` is served exactly as written — so
 * nothing stood between a stray bracket and a blank screen. A missing closing
 * paren in admin-readings.js on 2026-08-12 left the readings page stuck on
 * "Loading the grid…", and the whole suite passed while it did: not one test
 * touches these files, because they need a DOM.
 *
 * This does not run them or test behaviour. It only asserts that the file is
 * syntactically valid ES, which is the failure the tests could not see and the
 * one that takes a screen down completely rather than partly.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { transformSync } from 'esbuild';
import { readFileSync } from 'node:fs';

const DIRS = ['public/js', 'public/admin'];

function modules() {
  const found = [];
  for (const dir of DIRS) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;   // an optional directory, not a failure
    }
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.js')) found.push(join(dir, entry.name));
    }
  }
  return found;
}

describe('every browser module parses', () => {
  const files = modules();

  it('finds the browser modules at all', () => {
    // Guards the guard: a renamed directory would otherwise make this suite
    // pass by checking nothing, which is the failure mode of every test that
    // iterates over a glob.
    expect(files.length).toBeGreaterThan(10);
  });

  for (const file of files) {
    it(`${file} is valid JavaScript`, () => {
      const source = readFileSync(file, 'utf8');
      expect(() => transformSync(source, { loader: 'js', format: 'esm' })).not.toThrow();
    });
  }
});

/**
 * The same class of failure as the missing bracket above: invisible, and
 * invisible in a way a green suite cannot see.
 *
 * `document.createElement('svg')` returns an element that accepts every
 * attribute, keeps its children, reports `svg` as its tag name — and renders
 * nothing. Every icon in the bottom nav and the warning triangle on the
 * impersonation banner were blank from the day they were written until
 * 2026-08-13, and the bar still looked like a bar because the labels were
 * there.
 *
 * There is no DOM in this suite, and adding jsdom to assert one line would cost
 * more than the line. So this asserts on the source instead: the shared builder
 * must know that SVG has a namespace of its own.
 */
describe('the shared element builder knows about SVG', () => {
  const ui = readFileSync('public/js/ui.js', 'utf8');

  it('creates SVG tags through createElementNS', () => {
    expect(ui).toMatch(/createElementNS\(\s*'http:\/\/www\.w3\.org\/2000\/svg'/);
  });

  it('lists svg and path among the namespaced tags', () => {
    const listed = ui.match(/SVG_TAGS = new Set\(\[([\s\S]*?)\]\)/)?.[1] ?? '';
    expect(listed).toContain("'svg'");
    expect(listed).toContain("'path'");
  });

  it('sets class by attribute, never by assigning className', () => {
    // On an SVG element className is a read-only SVGAnimatedString. These are
    // ES modules, so assigning to it throws and takes the whole render with it
    // — the impersonation banner is the one SVG here that carries a class.
    expect(ui).toMatch(/k === 'class'\) node\.setAttribute\('class'/);
    expect(ui).not.toMatch(/node\.className\s*=/);
  });
});

/**
 * The admin tab strip, asserted as a shape rather than a screenshot.
 *
 * Fourteen tabs wrapped to two or three rows depending on the window, so no tab
 * had a stable position. Four were folded into the screen that owns their
 * subject, and the risk now is that somebody re-adds one as a peer without
 * realising it was a deliberate move — which reads as a small convenience and
 * quietly undoes the consolidation.
 */
describe('the admin console does not regrow its tabs', () => {
  const src = readFileSync('public/js/admin-console.js', 'utf8');
  const tabs = src.match(/const TABS = \[([\s\S]*?)\n\];/)?.[1] ?? '';

  it('parsed a TABS block at all', () => {
    // Otherwise every assertion below passes against an empty string.
    expect(tabs.length).toBeGreaterThan(100);
  });

  it('keeps the folded-in sections off the strip', () => {
    for (const id of ['approvals', 'latefees', 'messages', 'export']) {
      expect(tabs, id).not.toContain(`id: '${id}'`);
    }
  });

  it('still reaches every folded section from the screen that owns it', () => {
    // Removing a tab and forgetting to fold its panel in would lose the screen
    // entirely — the panel would exist and nothing would call it.
    for (const fn of ['approvalsPanel', 'lateFeesPanel', 'messagesPanel', 'exportPanel']) {
      expect(src, fn).toMatch(new RegExp(`(foldedSection\\([^)]*${fn}|${fn}\\(\\))`));
    }
  });

  it('opens somewhere that changes nothing by being looked at', () => {
    // Not the rate editor, which is what every resident's bill is computed from.
    expect(src).toMatch(/location\.hash\.slice\(1\) \|\| 'home'/);
  });
});

/**
 * Notices and the proof archive live with the things they describe.
 *
 * The Archive tab was one bin for two unrelated subjects, and notices were
 * managed in a console by people who were standing on the notice board when
 * they decided to. Both moves are easy to undo by accident — re-adding a tab
 * looks like a small convenience.
 */
describe('managing a thing happens where the thing is', () => {
  const console_ = readFileSync('public/js/admin-console.js', 'utf8');
  const notices = readFileSync('public/js/notices.js', 'utf8');
  const proofs = readFileSync('public/js/admin-proofs.js', 'utf8');
  const tabs = console_.match(/const TABS = \[([\s\S]*?)\n\];/)?.[1] ?? '';

  it('has no Notices or Archive tab in the console', () => {
    expect(tabs).not.toContain("id: 'notices'");
    expect(tabs).not.toContain("id: 'archive'");
  });

  it('does not send an admin away from the board to post a notice', () => {
    // The link that used to stand in for this being on the wrong page.
    expect(notices).not.toContain("href: '/admin/#notices'");
  });

  it('keeps the committee composer, which is their whole job', () => {
    // Folding the admin form in behind a toggle must not take the committee
    // member's unconditional one with it — they have no console to fall back to.
    expect(notices).toMatch(/isCommittee && !isAdmin\)? \|\| \(isAdmin && manageOpen/);
  });

  it('keeps withdrawing behind a deliberate toggle, not beside the reading', () => {
    expect(notices).toMatch(/manageOpen/);
    expect(notices).toMatch(/manageToggle/);
  });

  it('renders the toggle on the notice page too, or the bar is unreachable', () => {
    // THE BUG THIS EXISTS FOR, live on production until 2026-08-17: manageBar
    // is gated on `isAdmin && manageOpen`; opening a notice is a full page load
    // (`/notices.html?id=N`), so manageOpen is false every time a notice page
    // starts; and the toggle was drawn only by renderList. An admin had a flag
    // that was always false and no control anywhere to flip it, on the only
    // screen that can edit or withdraw — the console's notice section having
    // been emptied when this moved here. Committee members were fine, which is
    // how it passed review.
    //
    // The assertions above could not catch it: both are satisfied by a file
    // that renders the toggle nowhere near the bar. This one is about the two
    // being reachable from the same screen.
    const renderOne = notices.match(/async function renderOne\([\s\S]*?\n}/)?.[0] ?? '';
    expect(renderOne).toContain('manageBar(');
    expect(renderOne).toContain('manageToggle(');
  });

  it('puts the notice id in the manage bar, not on the notice', () => {
    // Debuggable for the committee without printing a database key above the
    // words residents came to read. The bar is the role-gated block: canManage
    // is the server's answer, computed with the function the PATCH route
    // enforces.
    const manageBar = notices.match(/function manageBar\([\s\S]*?\n}/)?.[0] ?? '';
    expect(manageBar).toContain('Notice #');
  });

  it('shows stored proof images on the proofs screen', () => {
    expect(proofs).toContain('proofArchive');
    expect(console_).not.toContain('proofArchive');
  });
});
