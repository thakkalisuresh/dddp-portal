/**
 * HTML builders for both guides.
 *
 * Content modules describe pages as data and these turn them into markup, so a
 * wording change never means touching layout and a layout change never means
 * touching 40 pages of prose.
 */
import { readFileSync } from 'node:fs';

const esc = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Inline markup we allow in copy: **bold**, and nothing else. */
export const t = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');

let SHOTS = {};
export function loadShots(path = 'guides/out/shots.json') {
  SHOTS = JSON.parse(readFileSync(path, 'utf8'));
  return SHOTS;
}

/**
 * A screenshot with its numbered badges.
 *
 * Badge coordinates come from the capture manifest as percentages, so the
 * image can be scaled to any column width and the badges follow. `only` picks
 * a subset of badges when a page describes just some of the marked elements.
 */
/** Usable text width on A4 with the margins in guide.css. */
const COLUMN_MM = 180;

/** Phone captures, sized to sit inside the 62mm column of a split page. */
const MOBILE_MM = 56;

/**
 * A screenshot, sized so it cannot blow the page.
 *
 * The manifest carries each capture's real dimensions, so the width that makes
 * a shot exactly `maxH` tall is arithmetic rather than guesswork. Without this
 * a wide desktop capture lands ~124mm tall on a 251mm page and three of them
 * silently push a section onto a second sheet.
 */
export function figure(name, { caption, mobile = false, only = null, maxH = 86, w = null } = {}) {
  const shot = SHOTS[name];
  if (!shot) throw new Error(`figure: no capture named "${name}" — run guides/capture.mjs`);

  const aspect = shot.clip.width / shot.clip.height;
  // Phone captures sit in the narrow column of a split page, so they are sized
  // by WIDTH — a height cap would make a short crop (the login screen) wider
  // than the column it has to fit in. Desktop captures are the other way
  // round: width is never the constraint, height is.
  const widthMm = w ?? (mobile ? MOBILE_MM : Math.min(COLUMN_MM, maxH * aspect));

  const marks = (shot.marks ?? []).filter((m) => !only || only.includes(m.n));
  const badges = marks.map((m) => {
    // Left edge of the element, vertically centred on it.
    const left = Math.max(0, m.left);
    const top = m.top + m.height / 2;
    return `<span class="badge" style="left:${left.toFixed(2)}%;top:${top.toFixed(2)}%">${m.n}</span>`;
  }).join('');

  const style = ` style="width:${widthMm.toFixed(1)}mm"`;
  return `<figure>
  <div class="shot${mobile ? ' shot--mobile' : ''}"${style}>
    <img src="shots/${name}.png" alt="">
    ${badges}
  </div>
  ${caption ? `<figcaption>${t(caption)}</figcaption>` : ''}
</figure>`;
}

export const box = (label, ...paras) =>
  `<div class="box"><span class="lab">${t(label)}</span>${paras.map((p) => `<p>${t(p)}</p>`).join('')}</div>`;

export const warn = (label, ...paras) =>
  `<div class="box box--warn"><span class="lab">${t(label)}</span>${paras.map((p) => `<p>${t(p)}</p>`).join('')}</div>`;

export const steps = (items) =>
  `<ol class="steps">${items.map((i) => {
    const [main, note] = Array.isArray(i) ? i : [i, null];
    return `<li><span>${t(main)}${note ? `<span class="note">${t(note)}</span>` : ''}</span></li>`;
  }).join('')}</ol>`;

export const pre = (items) =>
  `<ul class="pre">${items.map((i) => `<li>${t(i)}</li>`).join('')}</ul>`;

export const plain = (items) =>
  `<ul class="plain">${items.map((i) => `<li>${t(i)}</li>`).join('')}</ul>`;

export const p = (...paras) => paras.map((x) => `<p>${t(x)}</p>`).join('');

export const h3 = (s) => `<h3>${t(s)}</h3>`;

export const table = (head, rows) => `<table>
  <thead><tr>${head.map((h) => `<th>${t(h)}</th>`).join('')}</tr></thead>
  <tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${t(c)}</td>`).join('')}</tr>`).join('')}</tbody>
</table>`;

export const split = (left, right, narrow = false) =>
  `<div class="split${narrow ? ' split--narrow' : ''}"><div>${left}</div><div>${right}</div></div>`;

/** One A4 page. */
export function page({ head = '', section = '', body, foot = '', n = null, cover = false }) {
  return `<section class="page${cover ? ' cover' : ''}">
  ${cover ? '' : `<div class="runhead"><span>${t(head)}</span><span>${t(section)}</span></div>`}
  <div class="body">${body}</div>
  ${cover ? '' : `<div class="runfoot"><span>${t(foot)}</span><span class="pg">${n ?? ''}</span></div>`}
</section>`;
}

export function document_({ title, pages }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${esc(title)}</title>
<link rel="stylesheet" href="../layout/guide.css">
</head>
<body>
${pages.join('\n')}
</body>
</html>`;
}
