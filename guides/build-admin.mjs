/**
 * Build the committee guides.
 *
 *   node guides/build-admin.mjs              # everything
 *   node guides/build-admin.mjs spine        # just the spine, phone trim
 *   node guides/build-admin.mjs sheet:proofs # just one reference sheet
 *
 * TWO DOCUMENT FAMILIES, ONE SOURCE. The spine is "your first month on the
 * committee", read start to finish once. The sheets are one screen each, kept
 * beside the person doing that job and reissued on their own when that screen
 * changes — which is why they are separate PDFs rather than chapters.
 *
 * Everything else is build-guide.mjs: paged.js, the same stylesheet, the same
 * overflow check. The overflow check is still the point — a section that
 * overruns silently becomes two sheets and every page number after it is wrong.
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, join, extname, normalize } from 'node:path';
import { spinePages, fullPages, SHEETS, sheetPages, useShots } from './content/admin-v3.mjs';
import { DEVICE_CSS } from './lib/device.mjs';

const ROOT = resolve('guides');
const OUT = resolve('guides/out');
mkdirSync(OUT, { recursive: true });

const POLYFILL = resolve('node_modules/pagedjs/dist/paged.polyfill.js');
if (!existsSync(POLYFILL)) throw new Error('paged.js missing — run: npm i -D pagedjs');

/**
 * The captures.
 *
 * A SEPARATE manifest from shots.json, because the A4 handbook and the two
 * older resident guides are still built from that one. Produced by:
 *
 *   GUIDE_ADMIN_MOBILE=… GUIDE_ADMIN_PW=… node guides/capture.mjs --admin-phone
 */
const SHOTS = join(OUT, 'admin-phone-shots.json');
if (existsSync(SHOTS)) {
  // capture.mjs records a path relative to the REPO ("guides/out/shots/x.png").
  // The document is served with guides/ as the root and lives at /out/, so that
  // string resolves to /out/guides/out/shots/x.png and 404s. The build's own
  // image check catches it, which is the only reason this was not shipped as a
  // guide full of blank rectangles.
  const raw = JSON.parse(readFileSync(SHOTS, 'utf8'));
  for (const s of Object.values(raw)) {
    if (typeof s.file === 'string') s.file = s.file.replace(/^guides\/out\//, '');
    // Older manifests recorded only `clip`. device() needs w/h, and without
    // them it produces `--sh: NaNmm` and a badge rail of zero height.
    if (s.w == null && s.clip) { s.w = Math.round(s.clip.width); s.h = Math.round(s.clip.height); }
  }
  useShots(raw);
} else if (process.env.GUIDE_PLACEHOLDER) {
  // Deliberately loud, and deliberately ugly. This exists so the LAYOUT can be
  // checked — pagination, overflow, whether a section still fits its page —
  // before anyone has a login to capture with. It is not a way to ship a guide:
  // every figure is a grey box saying which capture is missing.
  console.warn('  ! GUIDE_PLACEHOLDER — every figure is a placeholder, not a screenshot.');
  console.warn('    This checks pagination only. Do not send the output to anyone.\n');
  //
  // The heights below are the `clipTo` values from the capture spec in
  // capture.mjs -- NOT measurements. A placeholder that is a full 844px phone
  // for every figure makes short element crops look like whole screens, and
  // then the overflow check reports pages that will not actually overflow.
  // Tuning prose against that is tuning against noise. Pagination is only
  // settled once the real captures exist; this gets it close.
  const CLIP = {
    'ph-home-reminders': 620, 'ph-billing-readings': 760,
    'ph-billing-import': 620, 'ph-billing-publish': 820,
    // An element crop whose height nobody has measured yet. Deliberately
    // generous, so this errs towards reporting an overflow that is not real
    // rather than hiding one that is.
    'ph-billing-rate': 560,
  };
  useShots(new Proxy({}, {
    has: () => true,
    get: (_, name) => (typeof name === 'string'
      ? { file: null, w: 390, h: CLIP[name] ?? 844, marks: [], placeholder: name }
      : undefined),
  }));
} else {
  throw new Error(
    `no captures at ${SHOTS}\n`
    + '  Run:  GUIDE_ADMIN_MOBILE=… GUIDE_ADMIN_PW=… node guides/capture.mjs --admin-phone\n'
    + '  Or, to check pagination only:  GUIDE_PLACEHOLDER=1 node guides/build-admin.mjs');
}

const VERSION = process.env.GUIDE_VERSION ?? '1.0';
const DATE = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

/** The spine, in the three trims the resident guide already proved. */
const SPINE_TRIMS = {
  spine: { size: '116mm 207mm', margin: '9mm 8mm 8mm', body: '', file: 'committee-spine-phone', trim: 'phone' },
  'spine-a5': { size: '148mm 210mm', margin: '12mm 12mm 11mm', body: 'a5', file: 'committee-spine-a5', trim: 'a5' },
  'spine-a5-print': { size: '148mm 210mm', margin: '12mm 12mm 11mm', body: 'a5 mono', file: 'committee-spine-a5-print', trim: 'a5' },
};

/**
 * The sheets are A5 only, and A5 print only.
 *
 * A reference sheet is looked at beside the screen being worked, so it is
 * either on paper or on the half of a laptop the console is not using. The
 * phone trim earns its place on the spine, which is read once, on a phone.
 */
const sheetJobs = () => SHEETS.flatMap(({ id, title }) => ([
  [`sheet:${id}`, { size: '148mm 210mm', margin: '12mm 12mm 11mm', body: 'a5', file: `committee-${id}`, trim: 'a5', sheet: id, title }],
  [`sheet:${id}:print`, { size: '148mm 210mm', margin: '12mm 12mm 11mm', body: 'a5 mono', file: `committee-${id}-print`, trim: 'a5', sheet: id, title }],
]));

/**
 * The whole thing as one document, A5 only.
 *
 * A5 because this is the version that gets printed and put in a drawer, or read
 * on half a laptop screen beside the console. The phone trim earns its place on
 * the spine, which is twelve pages read once; nobody reads twenty-two pages of
 * reference material on a phone.
 */
const FULL_TRIMS = {
  full: { size: '148mm 210mm', margin: '12mm 12mm 11mm', body: 'a5', file: 'committee-handbook', trim: 'a5', full: true, title: 'Running the gas billing' },
  'full-print': { size: '148mm 210mm', margin: '12mm 12mm 11mm', body: 'a5 mono', file: 'committee-handbook-print', trim: 'a5', full: true, title: 'Running the gas billing' },
};

const JOBS = [...Object.entries(SPINE_TRIMS), ...Object.entries(FULL_TRIMS), ...sheetJobs()];

const body = (job) => {
  if (job.full) return fullPages({ version: VERSION, date: DATE, trim: job.trim });
  return job.sheet
    ? sheetPages(job.sheet, { version: VERSION, date: DATE, trim: job.trim })
    : spinePages({ version: VERSION, date: DATE, trim: job.trim });
};

const doc = (job) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>DD Diamond Park — ${job.title ?? 'running the gas billing'}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,600;12..96,800&family=Figtree:wght@400;500;700;800&display=swap">
<link rel="stylesheet" href="../layout/resident-v3.css">
<style>
@page {
  size: ${job.size};
  margin: ${job.margin};
  @bottom-left { content: string(runfoot); font-family:"Figtree",sans-serif; font-size:7pt; color:#8A9891; }
  @bottom-right { content: counter(page); font-family:"Figtree",sans-serif; font-weight:700; font-size:7.5pt; color:#101E18; }
}
@page :first { @bottom-left { content: none } @bottom-right { content: none } }
.sheet h1 { string-set: runfoot content(text); }
${DEVICE_CSS}
/* Placeholder figures. Only ever rendered under GUIDE_PLACEHOLDER. */
.ph { display:flex; align-items:center; justify-content:center; width:100%; height:100%;
      background:repeating-linear-gradient(45deg,#EFEEE9,#EFEEE9 6px,#E4E3DC 6px,#E4E3DC 12px);
      font:600 6pt "Figtree",sans-serif; color:#6B7A72; text-align:center; padding:2mm; }
</style>
<script>window.PagedConfig = { auto: true, after: () => { window.__paged = true; } };</script>
<script src="../paged.polyfill.js"></script>
</head>
<body class="${job.body}">
${body(job).join('\n')}
</body></html>`;

/* Served, never opened as a file: paged.js re-fetches the stylesheet with XHR
   and a file:// origin refuses that. */
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml',
};
const docs = new Map();
const server = createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  if (docs.has(url)) { res.writeHead(200, { 'content-type': TYPES['.html'] }).end(docs.get(url)); return; }
  if (url === '/paged.polyfill.js') {
    res.writeHead(200, { 'content-type': TYPES['.js'] }).end(readFileSync(POLYFILL)); return;
  }
  const file = join(ROOT, normalize(url).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
  let payload;
  try { payload = readFileSync(file); }
  catch (e) { res.writeHead(404).end(String(e.message)); return; }
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' }).end(payload);
});

await new Promise((r) => server.listen(0, r));
const port = server.address().port;

const only = process.argv[2];
const chosen = JOBS.filter(([k]) => !only || k === only || k === `${only}:print`);
if (!chosen.length) {
  console.error(`  no such job: ${only}\n  known: ${JOBS.map(([k]) => k).join(', ')}`);
  process.exit(2);
}
// Registered under /out/ so relative paths resolve the same whether the page is
// served by this build or opened from guides/out/ afterwards.
for (const [key, job] of chosen) docs.set(`/out/${key.replace(/:/g, '-')}.html`, doc(job));

const browser = await chromium.launch();
const page = await browser.newPage();
let failed = 0;

for (const [key, job] of chosen) {
  const route = `/out/${key.replace(/:/g, '-')}.html`;
  await page.goto(`http://127.0.0.1:${port}${route}`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.__paged === true, { timeout: 60_000 });
  await page.evaluate(() => document.fonts.ready);

  const check = await page.evaluate(() => ({
    sections: document.querySelectorAll('.pagedjs_page').length,
    titles: [...document.querySelectorAll('.pagedjs_page')].map((p) => {
      const h = p.querySelector('h1');
      return h ? h.textContent.trim().slice(0, 40) : '(continued)';
    }),
  }));
  const authored = body(job).length;

  writeFileSync(join(OUT, `${job.file}.html`), docs.get(route));
  await page.pdf({
    path: join(OUT, `${job.file}.pdf`), printBackground: true,
    width: job.size.split(' ')[0], height: job.size.split(' ')[1],
    margin: { top: 0, right: 0, bottom: 0, left: 0 },
  });

  const broken = await page.evaluate(() =>
    [...document.images].filter((i) => !i.complete || i.naturalWidth === 0).map((i) => i.getAttribute('src')));
  if (broken.length) {
    failed++;
    console.log(`  ${key.padEnd(22)} IMAGES MISSING: ${[...new Set(broken)].join(', ')}`);
  }

  const spill = check.sections - authored;
  if (spill !== 0) {
    failed++;
    console.log(`  ${key.padEnd(22)} ${String(check.sections).padStart(2)} pages  OVERFLOW — ${spill} extra page(s)`);
    // Name the section that grew. A count alone means guessing which page to
    // shorten, and the guessing is the slow part.
    let last = '(cover)';
    for (const [i, title] of check.titles.entries()) {
      if (title === '(continued)') console.log(`${' '.repeat(25)}p${i + 1} continues "${last}"`);
      else last = title;
    }
  } else {
    console.log(`  ${key.padEnd(22)} ${String(check.sections).padStart(2)} pages  ok  ->  ${job.file}.pdf`);
  }
}

await browser.close();
server.close();
if (failed) {
  console.error(`\n  ${failed} document(s) failed. The PDFs were still written so you can look at them,`);
  console.error('  but the page numbers after an overrun are wrong. Shorten the section and rebuild.\n');
  process.exitCode = 1;
}
