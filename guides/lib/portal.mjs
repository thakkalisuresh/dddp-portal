/**
 * Playwright driver for guide screenshots.
 *
 * The one idea worth knowing: this never draws an annotation onto the image.
 * It captures a clean screenshot and separately emits the BOX of each element
 * being pointed at, in percentages of the captured area. The layout draws the
 * numbered badges in CSS from those percentages.
 *
 * Two reasons. Badges stay vector-sharp at print resolution instead of being
 * resampled pixels; and the print stylesheet can restyle them (filled green ->
 * outlined black) without re-running a single capture. Baking them in would
 * make the greyscale rendering a second capture pass, which is exactly the
 * kind of thing that rots.
 */
import { chromium } from 'playwright';

export const BASE = process.env.GUIDE_BASE ?? 'http://localhost:8788';

export const DESKTOP = { width: 1440, height: 900 };
export const MOBILE = { width: 390, height: 844 };

/** The treasurer's number, wherever it surfaces. Blurred in every capture. */
const REDACT_RE = /\+91\s*98464\s*66511/;

export async function browser() {
  return chromium.launch();
}

/**
 * A logged-in page at the given viewport.
 *
 * Logs in through the real endpoint rather than forging a session row: the
 * cookie flags and the mustChangePassword redirect are part of what the
 * screenshots are supposed to show being true.
 */
export async function session(br, { mobile, password, viewport, scale = 2 }) {
  const ctx = await br.newContext({ viewport, deviceScaleFactor: scale });
  const page = await ctx.newPage();

  await page.goto(`${BASE}/login.html`, { waitUntil: 'networkidle' });
  const res = await page.evaluate(async ({ mobile, password }) => {
    const r = await fetch('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mobile, password, remember: true }),
    });
    return { status: r.status, body: await r.text() };
  }, { mobile, password });

  if (res.status !== 200) {
    throw new Error(`login failed for ${mobile}: ${res.status} ${res.body}`);
  }
  return { ctx, page };
}

/** Settle: fonts loaded, network quiet, no half-painted panel. */
export async function settle(page) {
  await page.waitForLoadState('networkidle');
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(180);
}

/**
 * Blur the treasurer's phone number anywhere it appears.
 *
 * Walks text nodes and wraps the match, rather than blurring whatever element
 * happens to contain it — on the dashboard the number shares its paragraph
 * with the sentence telling you who to contact, and blurring the paragraph
 * would take the instruction with it.
 */
export async function redactPhone(page) {
  return page.evaluate((src) => {
    const re = new RegExp(src, 'g');
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const hits = [];
    let n;
    while ((n = walker.nextNode())) {
      if (re.test(n.nodeValue || '')) hits.push(n);
      re.lastIndex = 0;
    }
    for (const node of hits) {
      const frag = document.createDocumentFragment();
      let last = 0;
      const text = node.nodeValue;
      for (const m of text.matchAll(re)) {
        if (m.index > last) frag.append(text.slice(last, m.index));
        const span = document.createElement('span');
        span.textContent = m[0];
        span.style.filter = 'blur(6px)';
        span.setAttribute('data-redacted', '');
        frag.append(span);
        last = m.index + m[0].length;
      }
      if (last < text.length) frag.append(text.slice(last));
      node.parentNode.replaceChild(frag, node);
    }
    return hits.length;
  }, REDACT_RE.source);
}

/** Hide anything that would date the capture or leak a real person. */
export async function sanitise(page) {
  await redactPhone(page);
}

/**
 * Capture `target` (a selector, or null for the viewport) and return the image
 * plus badge positions for `marks`.
 *
 * `marks` is an ordered list of selectors: mark 1 is the first, and the numbers
 * match the numbered steps in the guide text. Anything that does not resolve is
 * reported rather than silently dropped — a badge that vanishes because a
 * selector rotted is precisely the failure that would ship unnoticed.
 */
export async function shot(page, file, { target = null, marks = [], padding = 0 } = {}) {
  await settle(page);
  await sanitise(page);

  // boundingBox() is viewport-relative; screenshot clips are document-relative.
  // At scroll 0 they are the same number, and every capture below relies on
  // that. Scrolling anywhere between measuring and shooting silently shifts
  // every badge — which is exactly the bug that put four badges in a stack in
  // the top-left corner instead of on the four fields they point at.
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(80);

  const el = target ? await page.locator(target).first() : null;
  if (target && !(await el.count())) throw new Error(`shot ${file}: target not found: ${target}`);

  const box = el
    ? await el.boundingBox()
    : { x: 0, y: 0, ...page.viewportSize() };
  if (!box) throw new Error(`shot ${file}: target has no box: ${target}`);

  const clip = {
    x: Math.max(0, box.x - padding),
    y: Math.max(0, box.y - padding),
    width: box.width + padding * 2,
    height: box.height + padding * 2,
  };

  const positions = [];
  const missing = [];
  for (const [i, sel] of marks.entries()) {
    const m = page.locator(sel).first();
    const mb = (await m.count()) ? await m.boundingBox() : null;
    if (!mb) { missing.push(sel); continue; }
    positions.push({
      n: i + 1,
      // Percentages of the clip, so the layout can scale the image freely.
      left: ((mb.x - clip.x) / clip.width) * 100,
      top: ((mb.y - clip.y) / clip.height) * 100,
      width: (mb.width / clip.width) * 100,
      height: (mb.height / clip.height) * 100,
    });
  }

  // fullPage, because a panel taller than the viewport would otherwise be
  // silently truncated to the visible part while the percentages above still
  // describe the whole thing.
  await page.screenshot({ path: file, clip, fullPage: true });
  return { file, clip, marks: positions, missing };
}
