/**
 * Build the resident guide.
 *
 *   node guides/build-guide.mjs            # all trims
 *   node guides/build-guide.mjs phone      # just one
 *   node guides/build-guide.mjs --pages    # also one PNG per page, to review
 *
 * --pages writes guides/out/pages-v3/<file>-NN.png. A PDF is hard to look at
 * from a script, and "it built" is not "it is right": a figure can overflow its
 * row or a badge land on the wrong control while every check passes. This used
 * to be a scratchpad helper, and it went when the scratchpad was cleared.
 *
 * HTML -> paged.js -> PDF. paged.js rather than Chrome's own print, because
 * Chrome implements `@page` size but not the margin BOXES, so a running foot
 * and a page number have to be faked. paged.js paginates in the browser and
 * fills them, and it counts the pages itself.
 *
 * THE OVERFLOW CHECK IS THE POINT. Every section in the content is meant to be
 * exactly one page. If a page overruns, paged.js quietly continues it onto
 * another sheet — the PDF still "builds", and every page number after it is
 * wrong. So the build counts pages against sections and fails when they differ,
 * naming the section that grew.
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { resolve, join, extname, normalize } from 'node:path';
import { pages, cardPages, useShots } from './content/resident-v3.mjs';
import { DEVICE_CSS } from './lib/device.mjs';

const ROOT = resolve('guides');
const OUT = resolve('guides/out');
mkdirSync(OUT, { recursive: true });

const POLYFILL = resolve('node_modules/pagedjs/dist/paged.polyfill.js');
if (!existsSync(POLYFILL)) throw new Error(`paged.js missing — run: npm i -D pagedjs`);

useShots(JSON.parse(readFileSync(join(OUT, 'sim-shots.json'), 'utf8')));

const VERSION = '2.0';
const DATE = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

const TRIMS = {
  phone: { size: '116mm 207mm', margin: '9mm 8mm 8mm', body: '', file: 'resident-guide-phone' },
  a5:    { size: '148mm 210mm', margin: '12mm 12mm 11mm', body: 'a5', file: 'resident-guide-a5' },
  'a5-print': { size: '148mm 210mm', margin: '12mm 12mm 11mm', body: 'a5 mono', file: 'resident-guide-a5-print' },
  card:  { size: '148mm 105mm', margin: '7mm', body: 'card', file: 'fridge-card', card: true },
};

const doc = (trim, key) => {
  const body = trim.card ? cardPages() : pages({ version: VERSION, date: DATE, trim: key.startsWith('a5') ? 'a5' : 'phone' });
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>DD Diamond Park — your gas bill</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,600;12..96,800&family=Figtree:wght@400;500;700;800&display=swap">
<link rel="stylesheet" href="../layout/resident-v3.css">
<style>
@page {
  size: ${trim.size};
  margin: ${trim.margin};
  ${trim.card ? '' : `
  @bottom-left { content: string(runfoot); font-family:"Figtree",sans-serif; font-size:8.5pt; color:#6F7E77; }
  @bottom-right { content: counter(page); font-family:"Figtree",sans-serif; font-weight:700; font-size:9pt; color:#101E18; }`}
}
@page :first { @bottom-left { content: none } @bottom-right { content: none } }
.sheet h1 { string-set: runfoot content(text); }
${DEVICE_CSS}
</style>
<script>window.PagedConfig = { auto: true, after: () => { window.__paged = true; } };</script>
<script src="../paged.polyfill.js"></script>
</head>
<body class="${trim.body}">
${body.join('\n')}
</body></html>`;
};

/* Serve from guides/, because paged.js fetches the stylesheet and a file://
   origin refuses that. */
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.png': 'image/png',
  // An <img> refuses an SVG served as octet-stream, and the failure is silent:
  // the mark simply does not appear.
  '.svg': 'image/svg+xml' };
const docs = new Map();
const server = createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  if (docs.has(url)) { res.writeHead(200, { 'content-type': TYPES['.html'] }).end(docs.get(url)); return; }
  if (url === '/paged.polyfill.js') {
    res.writeHead(200, { 'content-type': TYPES['.js'] }).end(readFileSync(POLYFILL)); return;
  }
  const file = join(ROOT, normalize(url).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
  // Read BEFORE the headers go out. Doing it inside .end() means a missing
  // file throws with the headers already sent, and the catch below then throws
  // ERR_HTTP_HEADERS_SENT over the top of the real error.
  let body;
  try { body = readFileSync(file); }
  catch (e) { res.writeHead(404).end(String(e.message)); return; }
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' }).end(body);
});

await new Promise((r) => server.listen(0, r));
const port = server.address().port;

// The contact link is a build input, and its absence is invisible in the
// output: the page still renders, just without a way to reach anyone. Say so.
if (!process.env.GUIDE_WHATSAPP) {
  console.warn('  ! GUIDE_WHATSAPP is not set — the guide will name the website');
  console.warn('    contact but carry no WhatsApp link. Rebuild with:');
  console.warn('      GUIDE_WHATSAPP=919567791515 node guides/build-guide.mjs\n');
}

const args = process.argv.slice(2);
const SHOTS = args.includes('--pages');
const only = args.find((a) => !a.startsWith('--'));
const chosen = Object.entries(TRIMS).filter(([k]) => !only || k === only);
// Registered under /out/ so the relative paths in the document are the same
// whether it is served by this build or opened from guides/out/ on disk. When
// it was served from the root, `sim/*.png` resolved to a directory that does
// not exist and every screenshot 404'd -- while the build still reported ok.
for (const [key, trim] of chosen) docs.set(`/out/${key}.html`, doc(trim, key));

const browser = await chromium.launch();
// Scale 2 only matters for the review PNGs; the PDF is vector either way.
const page = await browser.newPage({ deviceScaleFactor: 2 });
const PNG_DIR = join(OUT, 'pages-v3');
if (SHOTS) mkdirSync(PNG_DIR, { recursive: true });
let failed = 0;

for (const [key, trim] of chosen) {
  await page.goto(`http://127.0.0.1:${port}/out/${key}.html`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.__paged === true, { timeout: 60_000 });
  await page.evaluate(() => document.fonts.ready);

  const check = await page.evaluate(() => ({
    sections: document.querySelectorAll('.pagedjs_page').length,
    titles: [...document.querySelectorAll('.pagedjs_page')].map((p) => {
      const h = p.querySelector('h1');
      return h ? h.textContent.trim().slice(0, 40) : '(continued)';
    }),
  }));
  const authored = trim.card ? cardPages().length
    : pages({ version: VERSION, date: DATE, trim: key.startsWith('a5') ? 'a5' : 'phone' }).length;

  const html = join(OUT, `${trim.file}.html`);
  writeFileSync(html, docs.get(`/out/${key}.html`));
  await page.pdf({ path: join(OUT, `${trim.file}.pdf`), printBackground: true,
    width: trim.size.split(' ')[0], height: trim.size.split(' ')[1], margin: { top: 0, right: 0, bottom: 0, left: 0 } });

  if (SHOTS) {
    // Clear this document's old pages first: a guide that shrank by a page
    // would otherwise leave its last PNG behind, looking current.
    for (const f of readdirSync(PNG_DIR)) if (f.startsWith(trim.file + '-')) unlinkSync(join(PNG_DIR, f));
    const sheets = await page.$$('.pagedjs_page');
    for (const [i, el] of sheets.entries()) {
      await el.screenshot({ path: join(PNG_DIR, `${trim.file}-${String(i + 1).padStart(2, '0')}.png`) });
    }
  }

  // Markup that reached the page as text: literal **bold** or an escaped
  // <a href>. Both have shipped once, silently, because the PDF still builds.
  const leaked = await page.evaluate(() => {
    const txt = document.body.innerText;
    return [...new Set([...(txt.match(/\*\*[^*]+\*\*/g) || []), ...(txt.match(/<a href[^>]*>/g) || [])])];
  });
  if (leaked.length) {
    failed++;
    console.log(`  ${key.padEnd(9)} RAW MARKUP ON THE PAGE: ${leaked.slice(0, 4).join('  ')}`);
  }

  const broken = await page.evaluate(() =>
    [...document.images].filter((i) => !i.complete || i.naturalWidth === 0).map((i) => i.getAttribute('src')));
  if (broken.length) {
    failed++;
    console.log(`  ${key.padEnd(9)} IMAGES MISSING: ${[...new Set(broken)].join(', ')}`);
  }

  const spill = check.sections - authored;
  const status = spill === 0 ? 'ok' : `OVERFLOW — ${spill} extra page(s)`;
  if (spill !== 0) {
    failed++;
    // Name the section that grew. A count alone means guessing which page to
    // shorten, and the guessing is the slow part.
    console.log(`  ${key.padEnd(9)} ${String(check.sections).padStart(2)} pages  ${status}`);
    let last = '(cover)';
    for (const [i, title] of check.titles.entries()) {
      if (title === '(continued)') console.log(`             p${i + 1} continues "${last}"`);
      else last = title;
    }
  } else {
    console.log(`  ${key.padEnd(9)} ${String(check.sections).padStart(2)} pages  ${status}  ->  ${trim.file}.pdf`);
  }
}

await browser.close();
server.close();
if (failed) {
  console.error(`\n  ${failed} trim(s) overflowed. The PDFs were still written so you can look at them,`);
  console.error('  but the page numbers after an overrun are wrong. Shorten the section and rebuild.\n');
  process.exitCode = 1;
}
