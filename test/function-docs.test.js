import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { render } from '../scripts/gen-function-docs.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('the function reference cannot rot', () => {
  it('docs/FUNCTIONS.md matches the source', () => {
    // The same guard docs/ERROR_CODES.md has. A reference that drifts is worse
    // than none: it names functions that were renamed and omits the one you
    // needed, and you only find out after trusting it.
    expect(readFileSync(join(root, 'docs', 'FUNCTIONS.md'), 'utf8')).toBe(render());
  });

  it('covers every area of the codebase', () => {
    const md = render();
    for (const area of ['Server — lib', 'Server — router', 'Browser', 'Scripts']) {
      expect(md, area).toContain(`## ${area}`);
    }
  });

  it('finds the exports that matter', () => {
    // A spot check across the three kinds of export, so a regex change that
    // silently stops matching one of them fails here rather than quietly
    // shrinking the reference.
    const md = render();
    for (const name of ['computeBill', 'billAccess', 'allFlats', 'previewRoster', 'withReveal']) {
      expect(md, name).toContain(`\`${name}\``);
    }
  });
});
