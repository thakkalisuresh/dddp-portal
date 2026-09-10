/**
 * Find control boxes inside a device screenshot.
 *
 * Captures now come off a real simulator rather than out of Playwright, so
 * there is no DOM to ask for a bounding box. What there is instead is the
 * portal's own palette: the primary button is a solid block of one green, and a
 * focused field is outlined in the same green. Both are findable by reading
 * pixels, and reading them is more honest than a hand-typed percentage that
 * silently rots the next time a control moves.
 *
 * Everything returned is a percentage of the image, so the layout can scale a
 * capture to any column and the marks follow it.
 *
 *   node guides/lib/measure.mjs path/to/shot.png
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, basename, join } from 'node:path';

/** The portal's primary green, as it lands in a screenshot. */
const GREEN = { rMax: 80, gMin: 60, gMax: 140, bMax: 110, sep: 25 };

export async function bands(file) {
  const dir = dirname(file);
  const srv = createServer((q, r) => {
    if (q.url === '/') { r.writeHead(200, { 'content-type': 'text/html' }).end('<canvas id=c></canvas>'); return; }
    try { r.writeHead(200, { 'content-type': 'image/png' }).end(readFileSync(join(dir, decodeURIComponent(q.url)))); }
    catch { r.writeHead(404).end(); }
  });
  await new Promise(r => srv.listen(0, r));
  const port = srv.address().port;
  const br = await chromium.launch();
  const page = await br.newPage();
  await page.goto(`http://127.0.0.1:${port}/`);
  const out = await page.evaluate(async ({ name, G }) => {
    const img = new Image();
    img.src = '/' + name;
    await img.decode();
    const c = document.getElementById('c');
    c.width = img.width; c.height = img.height;
    const cx = c.getContext('2d');
    cx.drawImage(img, 0, 0);
    const d = cx.getImageData(0, 0, c.width, c.height).data;

    // Rows first: how much of each row is the portal's green, and how much of
    // it is not-white. A solid button is a row that is mostly green; an
    // outlined field is two thin green rows with a pale gap between them.
    const rows = [];
    for (let y = 0; y < c.height; y++) {
      let green = 0, ink = 0;
      for (let x = 0; x < c.width; x += 2) {
        const i = (y * c.width + x) * 4;
        const r = d[i], g = d[i + 1], b = d[i + 2];
        if (r < G.rMax && g > G.gMin && g < G.gMax && b < G.bMax && g - r > G.sep) green++;
        if (r < 240 || g < 240 || b < 240) ink++;
      }
      rows.push({ green, ink });
    }
    const half = Math.ceil(c.width / 2);
    const run = (pred, min) => {
      const out = []; let s = null;
      for (let y = 0; y < rows.length; y++) {
        const on = pred(rows[y]);
        if (on && s === null) s = y;
        if (!on && s !== null) { if (y - s >= min) out.push([s, y]); s = null; }
      }
      if (s !== null && rows.length - s >= min) out.push([s, rows.length]);
      return out;
    };
    // A filled control: most of the row is green, for many rows.
    const filled = run(r => r.green > half * 0.45, 20);
    // A rule: a thin mostly-green row. Field outlines come in pairs.
    const rules = run(r => r.green > half * 0.40, 2).filter(([a, b]) => b - a < 20);

    // An unfocused field is outlined in pale grey, not green, so the pass above
    // cannot see it. A border is a thin row that is non-white across most of
    // the width; a row of text never is, however large the type.
    const greyRules = run(r => r.ink > half * 0.62 && r.green < half * 0.2, 1)
      .filter(([a, b]) => b - a < 20);

    // A dashed border is not a continuous row, so the pass above cannot see it:
    // its ink never reaches the threshold a solid rule does. What it does have
    // is ink spread across nearly the full width of the control. Measure the
    // span rather than the count.
    const spanOf = (y) => {
      let lo = -1, hi = -1;
      for (let x = 0; x < c.width; x++) {
        const i = (y * c.width + x) * 4;
        if (d[i] < 235 || d[i + 1] < 235 || d[i + 2] < 235) { if (lo < 0) lo = x; hi = x; }
      }
      return { lo, hi, span: hi - lo };
    };
    const dashed = run((r) => r.ink > half * 0.18 && r.ink < half * 0.62, 1)
      .filter(([a, b]) => b - a < 20 && spanOf(((a + b) / 2) | 0).span > c.width * 0.7);

    // Horizontal extent, from whichever band this screen actually has. Taking
    // it only from a solid button meant a screen with no solid button — which
    // is exactly what the iOS pay screen is — reported an inverted, unusable
    // range and every badge on it landed off the image.
    let left = c.width, right = 0;
    const source = filled[filled.length - 1] ?? rules[0] ?? greyRules[0] ?? dashed[0];
    if (source) {
      const y = ((source[0] + source[1]) / 2) | 0;
      const { lo, hi } = spanOf(y);
      if (lo >= 0) { left = lo; right = hi; }
    }
    // Where the browser's address pill sits. It is NOT at a fixed height:
    // Safari shows a taller toolbar on a short page and a minimised one after
    // scrolling, so an assumed percentage lands on the nav bar half the time.
    // The pill is the widest near-white run in the bottom of the frame.
    const widestWhite = (y) => {
      let best = 0, run = 0, at = 0;
      for (let x = 0; x < c.width; x++) {
        const i = (y * c.width + x) * 4;
        if (d[i] > 246 && d[i + 1] > 246 && d[i + 2] > 246) {
          run++; if (run > best) { best = run; at = x - run / 2; }
        } else run = 0;
      }
      return { best, at };
    };
    const isPillRow = (y) => {
      const { best } = widestWhite(y);
      return best > c.width * 0.22 && best < c.width * 0.75;
    };
    let pill = null;
    for (let y = c.height - 1; y > c.height * 0.78; y--) {
      if (!isPillRow(y)) continue;
      let top = y;
      while (top > 0 && isPillRow(top - 1)) top--;
      const mid = (top + y) / 2;
      pill = { top: (mid / c.height) * 100, left: (widestWhite(mid | 0).at / c.width) * 100,
               height: ((y - top) / c.height) * 100 };
      break;
    }
    return { w: c.width, h: c.height, filled, rules, greyRules, dashed, left, right, pill };
  }, { name: basename(file), G: GREEN });
  await br.close(); srv.close();
  return out;
}

/** Turn a pixel band into the percentage box the layout wants. */
export const pct = (b, [top, bottom], n) => ({
  n,
  left: (b.left / b.w) * 100,
  width: ((b.right - b.left) / b.w) * 100,
  top: (top / b.h) * 100,
  height: ((bottom - top) / b.h) * 100,
});

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = await bands(process.argv[2]);
  console.log(JSON.stringify(r, null, 1));
}
