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
