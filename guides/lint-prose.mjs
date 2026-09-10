/**
 * Prose lint for the guides, built from Wikipedia:Signs of AI writing.
 *
 * The rules below are transcribed from that page's own categories — AI
 * vocabulary, copula avoidance, negative parallelism, promotional tone, undue
 * significance, vague attribution, and formatting tells. It is a prompt to look
 * again, not a verdict: every hit is reported with its line so a human decides.
 *
 *   node guides/lint-prose.mjs guides/content-draft.md
 *
 * Exit code is 1 if anything in the `hard` set appears, 0 otherwise.
 */
import { readFileSync } from 'node:fs';

const files = process.argv.slice(2);
if (!files.length) {
  console.error('usage: node guides/lint-prose.mjs <file.md> [...]');
  process.exit(2);
}

/** Words the page names as clustering in LLM output. */
const AI_VOCAB = [
  'delve', 'underscore', 'tapestry', 'intricacies', 'multifaceted', 'nuanced',
  'pivotal', 'crucial', 'vital', 'essential', 'paramount', 'testament',
  'realm', 'landscape', 'navigate the', 'embark', 'foster', 'holistic',
  'robust', 'seamless', 'streamline', 'leverage', 'utilize', 'facilitate',
  'comprehensive', 'myriad', 'plethora', 'vibrant', 'nestled', 'showcasing',
  'boasts', 'renowned', 'stands as', 'rich history', 'enduring legacy',
  'ever-evolving', 'rapidly evolving', 'in today\'s', 'moreover', 'furthermore',
  'additionally', 'notably', 'importantly', 'ultimately', 'overall',
];

/** Copula avoidance — "is/are" replaced by a marketing verb. */
const COPULA_DODGE = [
  'serves as', 'serve as', 'functions as', 'acts as', 'stands as',
  'represents a', 'offers a', 'features a', 'provides a',
];

/** Vague attribution. */
const VAGUE_ATTRIB = [
  'experts (say|argue|believe|agree)', 'studies (show|suggest|indicate)',
  'industry reports', 'it is widely', 'many believe', 'some argue',
  'research (shows|suggests)', 'observers note',
];

/** Superficial analysis: participles that attach an unearned reading. */
const PARTICIPLE_GLUE = [
  'highlighting the', 'emphasizing the', 'underscoring the', 'reflecting the',
  'showcasing the', 'demonstrating the', 'signifying', 'cementing',
];

/** Formulaic conclusion shapes. */
const FORMULAIC = [
  'despite (these )?challenges', 'in conclusion', 'it is important to note',
  'plays a (key|vital|crucial|significant) role', 'the future of',
];

const rx = (s) => new RegExp(`\\b(${s})\\b`, 'gi');

/** Rules that fail the build, versus rules that only ask for a second look. */
const RULES = [
  { id: 'ai-vocab',    hard: true,  label: 'AI vocabulary cluster',
    test: (l) => AI_VOCAB.flatMap((w) => [...l.matchAll(rx(w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))].map((m) => m[0])) },
  { id: 'copula',      hard: true,  label: 'Copula avoided (use "is"/"are")',
    test: (l) => COPULA_DODGE.flatMap((w) => [...l.matchAll(rx(w))].map((m) => m[0])) },
  { id: 'attribution', hard: true,  label: 'Vague attribution',
    test: (l) => VAGUE_ATTRIB.flatMap((w) => [...l.matchAll(new RegExp(w, 'gi'))].map((m) => m[0])) },
  { id: 'participle',  hard: true,  label: 'Participle glued to a vague reading',
    test: (l) => PARTICIPLE_GLUE.flatMap((w) => [...l.matchAll(rx(w))].map((m) => m[0])) },
  { id: 'formulaic',   hard: true,  label: 'Formulaic conclusion',
    test: (l) => FORMULAIC.flatMap((w) => [...l.matchAll(new RegExp(w, 'gi'))].map((m) => m[0])) },
  { id: 'not-just',    hard: true,  label: 'Negative parallelism ("not just X, but Y")',
    test: (l) => [...l.matchAll(/not (just|only|merely) [^,.;]{2,60}[,]? but/gi)].map((m) => m[0]) },
  { id: 'neg-par',     hard: false, label: 'Contrast by negation ("X, not Y") — fine in moderation',
    test: (l) => [...l.matchAll(/,\s*not\s+(a|an|the|from|every|by)?\s*[a-z]/g)].map((m) => m[0].trim()) },
  { id: 'em-dash',     hard: false, label: 'Em dash',
    test: (l) => [...l.matchAll(/—/g)].map(() => '—') },
  { id: 'rule-of-3',   hard: false, label: 'Three-item list ("A, B and C") — check it is not a tic',
    test: (l) => [...l.matchAll(/\b\w+, \w+ and \w+\b/g)].map((m) => m[0]) },
];

let hardHits = 0;

for (const file of files) {
  const lines = readFileSync(file, 'utf8').split('\n');
  const found = new Map();

  lines.forEach((line, i) => {
    // Skip fenced quotes of the portal's own strings: those are the product's
    // words, not ours, and rewriting them would make the guide wrong.
    if (/^\s*(\||>?\s*\*\*".*"\*\*)/.test(line)) return;
    for (const rule of RULES) {
      const hits = rule.test(line);
      if (!hits.length) continue;
      if (!found.has(rule.id)) found.set(rule.id, []);
      found.get(rule.id).push({ n: i + 1, hits });
    }
  });

  console.log(`\n\x1b[1m${file}\x1b[0m`);
  const words = readFileSync(file, 'utf8').split(/\s+/).filter(Boolean).length;
  console.log(`  ${words} words, ${lines.length} lines`);

  if (!found.size) {
    console.log('  \x1b[32mno tells found\x1b[0m');
    continue;
  }

  for (const rule of RULES) {
    const rows = found.get(rule.id);
    if (!rows) continue;
    const total = rows.reduce((a, r) => a + r.hits.length, 0);
    const mark = rule.hard ? '\x1b[31mFAIL\x1b[0m' : '\x1b[33mlook\x1b[0m';
    if (rule.hard) hardHits += total;
    console.log(`  ${mark} ${rule.label} — ${total}`);
    for (const r of rows.slice(0, 8)) {
      console.log(`       line ${r.n}: ${[...new Set(r.hits)].join(', ')}`);
    }
    if (rows.length > 8) console.log(`       …and ${rows.length - 8} more lines`);
  }
}

console.log('');
process.exit(hardHits ? 1 : 0);
