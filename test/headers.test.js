import { describe, it, expect } from 'vitest';
import { SECURITY_HEADERS } from '../functions/lib/http.js';

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

  it('frames exactly one third-party origin, and it is OpenStreetMap', () => {
    expect(csp['frame-src']).toEqual(['https://www.openstreetmap.org']);
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
