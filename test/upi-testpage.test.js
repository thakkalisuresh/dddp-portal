/**
 * The test page is only evidence if it carries the portal's own links.
 *
 * A hand-edited copy of a URI drifts the moment `buildUpiLinks` changes, and a
 * drifted test page produces a result about a link nobody was ever sent. These
 * assertions exist to make that drift loud.
 */
import { describe, it, expect } from 'vitest';
import { buildUpiLinks } from '../functions/lib/upi.js';
import { renderPage, linkRows, TEST_VPA, TEST_PAYEE, TEST_AMOUNT, TEST_NOTE } from '../scripts/gen-upi-testpage.mjs';

const NOW = new Date('2026-08-11T00:00:00Z');

describe('upi test page', () => {
  const html = renderPage({ now: NOW });
  const links = buildUpiLinks({ vpa: TEST_VPA, payee: TEST_PAYEE, amount: TEST_AMOUNT, flat: TEST_NOTE, now: NOW });

  it('embeds every link shape the builder emits', () => {
    for (const [, , href] of linkRows(links)) {
      expect(html).toContain(href.replace(/&/g, '&amp;'));
    }
  });

  it('covers all five shapes named in STATE.md', () => {
    const ids = linkRows(links).map(([id]) => id);
    expect(ids).toContain('generic');
    expect(ids).toContain('intent-bare');
    expect(ids).toContain('intent-gpay');
    expect(ids).toContain('scheme-gpay');
    expect(ids).toContain('scheme-tez');
  });

  // The page is handed to someone outside the association, so it must not name
  // it — and the amount must stay trivial and the payee unresolvable, because
  // a working link puts a real confirmation screen in front of a real person.
  it('names nothing and can move no money', () => {
    expect(html).not.toMatch(/diamond|dddp|ddwelfare|RWA/i);
    expect(html).toContain('am=1.00');
    expect(html).toContain(encodeURIComponent(TEST_VPA).replace(/%40/g, '%40'));
  });

  // `tn` is the only text that survives the handoff into the UPI app, so a
  // resolving payee is only safe while this warning rides along with it.
  it('carries the do-not-pay warning into every link', () => {
    for (const [, , href] of linkRows(links)) {
      expect(decodeURIComponent(href)).toContain('PLEASE DO NOT PAY');
    }
  });

  // The default must never resolve. A page generated without --vpa is the one
  // most likely to be sent by accident.
  it('defaults to a payee no registry can answer for', () => {
    expect(TEST_VPA.endsWith('@invalid')).toBe(true);
    expect(html).not.toContain('@sib');
  });

  // The portal's own hostname would reintroduce the name this page exists to
  // keep out, so no intent may carry a browser fallback.
  it('sets no browser_fallback_url', () => {
    expect(html).not.toContain('browser_fallback_url');
  });
});
