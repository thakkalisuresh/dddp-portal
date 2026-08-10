import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { SECURITY_HEADERS } from '../functions/lib/http.js';

const homeJs = readFileSync(new URL('../public/js/home.js', import.meta.url), 'utf8');

/**
 * The CSP is the one security control here that fails SILENTLY. A wrong
 * `script-src` throws in the console; a wrong `frame-src` just renders an empty
 * box, and a too-loose one renders nothing at all wrong until it matters.
 *
 * B15 widened it for the first time — one origin, frames only. These tests
 * exist so the next widening is a decision somebody makes rather than a line
 * somebody adds.
 */

const csp = Object.fromEntries(
  SECURITY_HEADERS['content-security-policy']
    .split(';')
    .map((part) => part.trim().split(/\s+/))
    .map(([directive, ...values]) => [directive, values])
);

describe('content security policy', () => {
  it('still defaults to same-origin only', () => {
    expect(csp['default-src']).toEqual(["'self'"]);
  });

  it('never allows a third-party script, whatever else changes', () => {
    // The whole point of no bundler and no CDN. If this ever fails, something
    // vendored has been replaced with a link to somebody else's server.
    expect(csp['script-src']).toEqual(["'self'"]);
  });

  it('frames only Google Maps, and both hops of its redirect', () => {
    // maps.google.com 301s to www.google.com; a frame navigation is checked
    // against this list at every hop, so listing one silently blanks the map.
    expect(csp['frame-src']).toEqual(['https://maps.google.com', 'https://www.google.com']);
  });

  it('hard-codes no Google API key anywhere', () => {
    // The invariant is not "no key" — the site can use one. It is that no
    // LITERAL key is ever committed. The old site's iframe carries a key from a
    // Cloud project nobody in the association can reach, and copying it would
    // put this map on a stranger's billing.
    //
    // Checked against the page source, not just the header: a pasted key would
    // land in the iframe URL, which is where it would actually go.
    expect(SECURITY_HEADERS['content-security-policy']).not.toMatch(/AIza/);
    expect(homeJs).not.toMatch(/AIza/);
  });

  it('takes the key from config rather than a literal', () => {
    expect(homeJs).toMatch(/key=\$\{encodeURIComponent\(mapsKey\)\}/);
  });

  it('still falls back to the keyless embed when no key is set', () => {
    // Absent is a supported state, not a broken one. This is what lets the key
    // be added, rotated or removed without the map ever going blank — and what
    // makes a key restricted to the wrong referrer degrade instead of fail.
    expect(homeJs).toContain('output=embed');
  });

  it('permits framing only over https', () => {
    for (const origin of csp['frame-src']) {
      expect(origin.startsWith('https://')).toBe(true);
    }
  });

  it('still refuses to be framed by anyone', () => {
    // Unrelated to frame-src, and repeatedly confused with it: this stops a
    // lookalike wrapping the login page to harvest credentials.
    expect(csp['frame-ancestors']).toEqual(["'none'"]);
    expect(SECURITY_HEADERS['x-frame-options']).toBe('DENY');
  });

  it('keeps the rest of the lockdown intact', () => {
    expect(csp['object-src']).toEqual(["'none'"]);
    expect(csp['base-uri']).toEqual(["'none'"]);
    expect(csp['form-action']).toEqual(["'self'"]);
    expect(csp['connect-src']).toEqual(["'self'"]);
    expect(csp['font-src']).toEqual(["'self'"]);
  });
});
