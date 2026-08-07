import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ERROR_CODES, SEVERITIES, DOMAINS, domainOf } from '../functions/lib/error-codes.js';
import { render } from '../scripts/gen-error-docs.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function sourceFiles(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sourceFiles(p, acc);
    else if (p.endsWith('.js')) acc.push(p);
  }
  return acc;
}

const sources = sourceFiles(join(root, 'functions'))
  .map((p) => ({ p, text: readFileSync(p, 'utf8') }));

describe('registry hygiene', () => {
  it('every code is well formed and in a known domain', () => {
    for (const code of Object.keys(ERROR_CODES)) {
      expect(code).toMatch(/^DDP-[A-Z]+-\d{3}$/);
      expect(DOMAINS).toContain(domainOf(code));
    }
  });

  it('every code has a known severity and a non-empty message', () => {
    for (const [code, entry] of Object.entries(ERROR_CODES)) {
      expect(SEVERITIES, code).toContain(entry.severity);
      expect(entry.message.length, code).toBeGreaterThan(10);
    }
  });

  it('has no duplicate messages — each code means something distinct', () => {
    const messages = Object.values(ERROR_CODES).map((e) => e.message);
    expect(new Set(messages).size).toBe(messages.length);
  });
});

describe('generated docs cannot drift', () => {
  it('docs/ERROR_CODES.md matches the registry', () => {
    const onDisk = readFileSync(join(root, 'docs', 'ERROR_CODES.md'), 'utf8');
    expect(onDisk).toBe(render());
  });
});

describe('no code is silently inert', () => {
  // The failure mode being guarded: a code marked fatal whose throw sites all
  // bypass reportError, leaving it invisible to alerts AND the digest.
  const referenced = new Set();
  for (const { p, text } of sources) {
    if (p.endsWith('error-codes.js')) continue; // the registry lists every code by definition
    for (const code of Object.keys(ERROR_CODES)) {
      if (text.includes(code)) referenced.add(code);
    }
  }

  it('every implemented code is referenced somewhere in functions/', () => {
    const orphans = Object.keys(ERROR_CODES)
      .filter((c) => !ERROR_CODES[c].planned && !referenced.has(c));
    expect(orphans, `unreferenced codes: ${orphans.join(', ')}`).toEqual([]);
  });

  it('a code that has gained a call site is no longer marked planned', () => {
    // Bidirectional guard: implementing a code must unmark it, so `planned`
    // can't quietly become a permanent excuse.
    const stale = Object.keys(ERROR_CODES)
      .filter((c) => ERROR_CODES[c].planned && referenced.has(c));
    expect(stale, `implemented but still planned: ${stale.join(', ')}`).toEqual([]);
  });

  it('failures leave the system only through fail() or reportError()', () => {
    for (const { p, text } of sources) {
      if (p.endsWith('errors.js')) continue; // defines the mechanism
      const bareThrows = text.match(/throw new Error\(/g) ?? [];
      expect(bareThrows.length, `${p} throws a bare Error`).toBe(0);
    }
  });

  it('reportError is actually called outside its own module', () => {
    const callers = sources.filter(
      ({ p, text }) => !p.endsWith('errors.js') && /reportError\(/.test(text)
    );
    expect(callers.length).toBeGreaterThan(0);
  });
});
