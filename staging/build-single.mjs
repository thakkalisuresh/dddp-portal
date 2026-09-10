/**
 * Flattens the prototype into one self-contained HTML file.
 *
 * The reviewer's shell and the prototype have to stay in separate documents —
 * the prototype styles `html` and `body` and uses position:fixed for its tab
 * bar, and both of those mean something different once it is a div inside
 * another page. So the portal is inlined into a string and handed to an iframe
 * through srcdoc, which keeps it a real document with its own viewport.
 *
 * The string travels base64-encoded, not as text. A <script type="text/plain">
 * holding it looked simpler and was wrong: the portal's OWN closing script tag
 * terminates the outer block the moment the HTML parser reaches it, so the
 * frame came up blank. Base64 has no sequence the parser can trip over, and it
 * costs a third more bytes in a file that is already trivially small.
 */

import { readFile, writeFile } from 'node:fs/promises';

const read = (p) => readFile(new URL(p, import.meta.url), 'utf8');

/** Strip ES module syntax and concatenate, in dependency order. */
async function bundle(files) {
  const parts = [];
  for (const f of files) {
    const src = await read(f);
    parts.push(`/* ══ ${f} ══ */\n` + src
      // Imports are all relative and all resolved by concatenation.
      .replace(/^import[\s\S]*?from\s+'[^']+';\s*$/gm, '')
      .replace(/^import\s+\*\s+as\s+\w+\s+from\s+'[^']+';\s*$/gm, '')
      .replace(/^export\s+(const|function|async function|let|class)/gm, '$1')
      .replace(/^export\s+\{[^}]*\};\s*$/gm, ''));
  }
  return parts.join('\n\n');
}

const theme = await read('./css/theme.css');
const ui = await read('./css/ui.css');

// Order matters: helpers, then data, then screens, then the router.
let js = await bundle([
  './js/ui.js', './js/data.js',
  './js/screens/resident.js', './js/screens/auth.js', './js/screens/admin.js',
  './js/app.js',
]);

// The screen modules refer to their siblings through namespace imports; without
// the module system those namespaces have to be rebuilt by hand.
js = js.replace(
  "const ROUTES = {",
  `const R = { dashboard, pay, proof, usage, notices, notice, profile };
const A = { home, login, forgot, setPassword };
const M = { adminHome, adminMonth, adminBills, adminProofs, adminReconcile, adminResidents, adminRoster, adminNotices };

const ROUTES = {`);

const portal = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Diamond Park</title><meta name="color-scheme" content="light dark">
<style>${theme}\n${ui}</style></head>
<body><div class="screen" id="app"></div>
<script type="module">${js}<\/script></body></html>`;

const shell = await read('./index.html');

// The shell's own iframe points at portal.html; swap it for the inlined copy.
const out = shell
  .replace(
    /<iframe id="frame"[^>]*><\/iframe>/,
    '<iframe id="frame" title="Diamond Park prototype"></iframe>')
  .replace(
    /<a href="portal\.html" target="_blank"[^>]*>[^<]*<\/a>/,
    '')
  .replace('<script type="module">',
    `<script type="module">
// Base64 in, UTF-8 out — atob alone mangles ₹, — and ’.
const PORTAL_SRC = new TextDecoder().decode(
  Uint8Array.from(atob('${Buffer.from(portal, 'utf8').toString('base64')}'), (c) => c.charCodeAt(0)));
`)
  // Every navigation reloads the frame from the inlined source with the wanted
  // hash already in it, rather than setting .src to a file that does not exist.
  .replace(/frame\.src = `portal\.html\$\{hash\}`;/,
    "frame.srcdoc = PORTAL_SRC.replace('<div class=\"screen\" id=\"app\">', `<div class=\"screen\" id=\"app\" data-hash=\"${hash}\">`);\n  frame.dataset.hash = hash;")
  .replace("frame.contentWindow.postMessage({ dp: 'persona', value: persona }, '*');",
    `frame.contentWindow.postMessage({ dp: 'persona', value: persona }, '*');
  const want = frame.dataset.hash;
  if (want) frame.contentWindow.location.hash = want;`);

await writeFile(new URL('./single.html', import.meta.url), out);
console.log('single.html', (out.length / 1024).toFixed(0) + ' KB');

/* ── the artifact variant ────────────────────────────────────────────────
   Same page, reshaped for the Artifact wrapper: no <!doctype>, <html>, <head>
   or <body> of its own (those are supplied), and the <title> hoisted to the
   very top — only the first 8KB is scanned for it, and the base64 portal is
   far larger than that, so the title must come before the script rather than
   after it.                                                                  */

const style = out.match(/<style>([\s\S]*?)<\/style>/)[1];
const markup = out.match(/<body>([\s\S]*?)<script type="module">/)[1];
const script = out.match(/<script type="module">([\s\S]*)<\/script>\s*<\/body>/)[1];

await writeFile(new URL('./artifact.html', import.meta.url), `<title>Diamond Park Portal</title>
<style>
${theme}
${style}
/* The wrapper paints its own ground behind the page, so the shell has to fill
   it rather than inherit it. */
.shell { background: var(--bg); }
</style>
${markup}
<script type="module">${script}<\/script>
`);
console.log('artifact.html ready');
