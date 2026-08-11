import { describe, it, expect } from 'vitest';
import { parse } from '../public/js/markdown.js';

/**
 * The parser is the half that can hurt somebody: it decides which order the
 * markers bind in and which URLs are allowed out of it. The DOM half only walks
 * the tree this returns.
 */

/** Flatten a tree back to the text a reader would see. */
const textOf = (nodes) => nodes.map((n) =>
  n.type === 'text' ? n.value : textOf(n.children)).join('');

describe('paragraphs', () => {
  it('splits on a blank line', () => {
    const blocks = parse('First para.\n\nSecond para.');
    expect(blocks).toHaveLength(2);
    expect(blocks.every((b) => b.type === 'p')).toBe(true);
    expect(textOf(blocks[1].children)).toBe('Second para.');
  });

  it('keeps single line breaks inside one paragraph', () => {
    // An address typed over three lines is three lines, not a run-on.
    const [block] = parse('Flat 4A\nDD Diamond Park\nKochi');
    expect(block.type).toBe('p');
    expect(textOf(block.children)).toBe('Flat 4A\nDD Diamond Park\nKochi');
  });

  it('ignores trailing and repeated blank lines', () => {
    expect(parse('One.\n\n\n\nTwo.\n\n')).toHaveLength(2);
  });

  it('returns nothing for empty input', () => {
    expect(parse('')).toEqual([]);
    expect(parse(null)).toEqual([]);
  });
});

describe('emphasis', () => {
  it('reads bold before italic', () => {
    const [block] = parse('Due by the **10th**.');
    const [, strong] = block.children;
    expect(strong.type).toBe('strong');
    expect(textOf(strong.children)).toBe('10th');
  });

  it('reads italic', () => {
    const [block] = parse('Bring an *umbrella*.');
    expect(block.children[1].type).toBe('em');
  });

  it('leaves arithmetic alone rather than guessing', () => {
    // The italic rule must not span a line break, so this stays literal.
    const [block] = parse('The hall fits 5*3*2 = 30 chairs');
    expect(textOf(block.children)).toBe('The hall fits 5*3*2 = 30 chairs');
  });

  it('does not let an unclosed marker swallow the rest of the notice', () => {
    const blocks = parse('A stray * asterisk\n\nA later paragraph');
    expect(textOf(blocks[0].children)).toBe('A stray * asterisk');
    expect(blocks[1].children.every((n) => n.type === 'text')).toBe(true);
  });

  it('handles two bold runs in one line', () => {
    const [block] = parse('**AGM** on the **30th**');
    expect(block.children.filter((n) => n.type === 'strong')).toHaveLength(2);
  });
});

describe('links', () => {
  it('accepts http, https, mailto and tel', () => {
    for (const href of ['https://a.test/x', 'http://a.test', 'mailto:a@b.test', 'tel:+919846466511']) {
      const [block] = parse(`See [here](${href})`);
      const link = block.children.find((n) => n.type === 'link');
      expect(link, href).toBeTruthy();
      expect(link.href).toBe(href);
    }
  });

  it('refuses javascript: and shows the literal text instead', () => {
    const [block] = parse('[tap me](javascript:alert(1))');
    expect(block.children.some((n) => n.type === 'link')).toBe(false);
    expect(textOf(block.children)).toBe('[tap me](javascript:alert(1))');
  });

  it('refuses data: URLs', () => {
    const [block] = parse('[x](data:text/html,<script>alert(1)</script>)');
    expect(block.children.some((n) => n.type === 'link')).toBe(false);
  });

  it('is not fooled by leading whitespace or case in the scheme', () => {
    const [block] = parse('[x](JaVaScRiPt:alert(1))');
    expect(block.children.some((n) => n.type === 'link')).toBe(false);
  });

  it('allows emphasis inside a link label', () => {
    const [block] = parse('[the **agenda**](https://a.test/agm)');
    const link = block.children.find((n) => n.type === 'link');
    expect(link.children.some((n) => n.type === 'strong')).toBe(true);
  });
});

describe('bullets', () => {
  it('gathers a run of lines into one list', () => {
    const [block] = parse('- adoption of accounts\n- sinking fund\n- elections');
    expect(block.type).toBe('ul');
    expect(block.items).toHaveLength(3);
    expect(textOf(block.items[1])).toBe('sinking fund');
  });

  it('accepts asterisk bullets too', () => {
    const [block] = parse('* one\n* two');
    expect(block.type).toBe('ul');
    expect(block.items).toHaveLength(2);
  });

  it('separates a list from the prose around it', () => {
    const blocks = parse('Agenda:\n- accounts\n- elections\nThat is all.');
    expect(blocks.map((b) => b.type)).toEqual(['p', 'ul', 'p']);
  });

  it('reads emphasis inside a bullet', () => {
    const [block] = parse('- **AGM** on the 30th');
    expect(block.items[0].some((n) => n.type === 'strong')).toBe(true);
  });
});

describe('a whole notice', () => {
  it('parses the shape a committee actually types', () => {
    const blocks = parse(
      'The AGM is on the **30th at 6 PM**.\n\n'
      + 'Agenda:\n'
      + '- adoption of accounts\n'
      + '- sinking fund revision\n\n'
      + 'Papers: [download](https://diamondpark.test/agm.pdf)'
    );
    expect(blocks.map((b) => b.type)).toEqual(['p', 'p', 'ul', 'p']);
    expect(blocks[3].children.some((n) => n.type === 'link')).toBe(true);
  });
});
