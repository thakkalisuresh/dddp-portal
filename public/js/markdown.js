/**
 * A very small markdown subset, for notice bodies.
 *
 * WHY NOT A LIBRARY, AND WHY NOT innerHTML. The whole app renders through
 * document.createTextNode (see ui.js el()), which is why it has never had to
 * think about escaping. A markdown renderer that returns an HTML string throws
 * that away: from then on correctness depends on a sanitiser being right about
 * every input, forever. This one produces DOM NODES, so text always arrives as
 * a text node — there is no string for a `<script>` to hide inside, and the CSP
 * never has to be the last line of defence.
 *
 * WHY IT IS TWO FUNCTIONS. `parse` is pure and has no idea the DOM exists, so
 * it can be tested in plain Node — and it is where every decision that could
 * hurt somebody lives: which order the markers bind in, and which URL schemes
 * are allowed out. `renderMarkdown` walks that tree into elements and is dull
 * enough to read in one sitting. Testing the parser is testing the risk.
 *
 * WHAT IT SUPPORTS, and nothing beyond it:
 *
 *   **bold**            a date, an amount, the thing residents must act on
 *   *italic*            a caveat
 *   [text](url)         http/https/mailto/tel only
 *   - bullet            the agenda list every committee notice ends up needing
 *   blank line          a new paragraph
 *
 * WHAT IT DELIBERATELY OMITS. Headings (a notice already has a title), images
 * (that is what attachments are), tables, blockquotes, code, raw HTML. The
 * committee is writing a noticeboard note on a phone, not a document, and every
 * extra construct is one more thing that can render wrong in front of 120
 * residents.
 *
 * Anything unrecognised stays as the literal characters typed. Someone writing
 * "5*3*2 = 30" gets that back rather than a mangled attempt at emphasis — an
 * unknown marker is text, never an error.
 */

/** Schemes a link may use. Everything else — javascript:, data: — is refused. */
const SAFE_SCHEME = /^(https?:|mailto:|tel:)/i;

/**
 * Inline markers, tried in this order at each position.
 *
 * Bold before italic, because `**x**` also satisfies the italic rule and the
 * order IS the disambiguation. Neither may span a line break: a stray asterisk
 * three paragraphs up must not turn half the notice italic, which is exactly
 * what an unanchored `.*` would do.
 *
 * EMPHASIS DOES NOT START OR END INSIDE A WORD. "The hall fits 5*3*2 = 30
 * chairs" is arithmetic, and CommonMark would render it as 5<em>3</em>2. On a
 * noticeboard where people type dimensions and quantities far more often than
 * they italicise mid-word, guessing emphasis there is the wrong bet — so a
 * marker must sit against a space, punctuation, or the end of the line.
 *
 * The boundary before the marker is a CAPTURED GROUP rather than a lookbehind.
 * Lookbehind needs Safari 16.4, and an iPhone older than that would not fail
 * gracefully — the regex literal throws while the module is being parsed, so
 * the entire notice board goes blank rather than merely losing italics. The
 * captured character is handed back as text; `lead` is how far past it the
 * real marker begins.
 */
const INLINE = [
  { type: 'link',   re: /\[([^\]\n]+)\]\(([^)\s]+)\)/,               lead: 0, body: 1, href: 2 },
  { type: 'strong', re: /(^|[^\w*])\*\*([^*\n]+)\*\*(?![\w*])/,      lead: 1, body: 2 },
  { type: 'em',     re: /(^|[^\w*])\*([^*\n]+)\*(?![\w*])/,          lead: 1, body: 2 },
];

const text = (value) => ({ type: 'text', value });

/** Text with inline markers -> inline nodes. */
function parseInline(source) {
  if (!source) return [];

  let earliest = null;
  for (const rule of INLINE) {
    const match = rule.re.exec(source);
    if (!match) continue;
    // Where the marker itself starts, past any boundary character the pattern
    // had to capture to get there — that is what "earliest" has to mean, or a
    // rule with a boundary always loses to one without.
    const start = match.index + (rule.lead ? match[rule.lead].length : 0);
    if (earliest === null || start < earliest.start) earliest = { rule, match, start };
  }
  if (!earliest) return [text(source)];

  const { rule, match, start } = earliest;
  const before = source.slice(0, start);
  const after = source.slice(match.index + match[0].length);
  const body = match[rule.body];

  let node;
  if (rule.type === 'link') {
    const href = match[rule.href];
    node = SAFE_SCHEME.test(href)
      ? { type: 'link', href, children: parseInline(body) }
      // Not a scheme we will emit. Give back what was typed rather than
      // silently dropping it — the author needs to see the link did not take.
      : text(match[0]);
  } else {
    node = { type: rule.type, children: parseInline(body) };
  }

  return [...parseInline(before), node, ...parseInline(after)];
}

const isBullet = (line) => /^\s*[-*]\s+/.test(line);

/**
 * Body text -> a block tree: paragraphs and bullet lists.
 *
 * Single line breaks survive inside a paragraph, because a committee that types
 * an address over three lines means those three lines. The CSS sets pre-wrap to
 * honour them.
 */
export function parse(source) {
  const blocks = [];
  const lines = String(source ?? '').replace(/\r\n?/g, '\n').split('\n');

  let paragraph = [];
  let bullets = [];

  const flushParagraph = () => {
    if (!paragraph.length) return;
    blocks.push({ type: 'p', children: parseInline(paragraph.join('\n')) });
    paragraph = [];
  };
  const flushBullets = () => {
    if (!bullets.length) return;
    blocks.push({
      type: 'ul',
      items: bullets.map((line) => parseInline(line.replace(/^\s*[-*]\s+/, ''))),
    });
    bullets = [];
  };

  for (const line of lines) {
    if (isBullet(line)) {
      flushParagraph();
      bullets.push(line);
    } else if (line.trim() === '') {
      flushBullets();
      flushParagraph();
    } else {
      flushBullets();
      paragraph.push(line);
    }
  }
  flushBullets();
  flushParagraph();

  return blocks;
}

function inlineNodes(nodes) {
  return nodes.map((node) => {
    if (node.type === 'text') return document.createTextNode(node.value);

    if (node.type === 'link') {
      const a = document.createElement('a');
      a.className = 'linkish';
      a.href = node.href;
      // A notice can link off-site; noopener stops the opened page reaching
      // back through window.opener.
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.append(...inlineNodes(node.children));
      return a;
    }

    const element = document.createElement(node.type); // strong | em
    element.append(...inlineNodes(node.children));
    return element;
  });
}

/** Body text -> block elements, ready to append. */
export function renderMarkdown(source) {
  return parse(source).map((block) => {
    if (block.type === 'ul') {
      const ul = document.createElement('ul');
      ul.className = 'prose__list';
      for (const item of block.items) {
        const li = document.createElement('li');
        li.append(...inlineNodes(item));
        ul.append(li);
      }
      return ul;
    }

    const p = document.createElement('p');
    p.className = 'prose__p';
    p.append(...inlineNodes(block.children));
    return p;
  });
}
