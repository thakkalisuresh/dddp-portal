/**
 * Browser QR drawing. Mirrors functions/lib/qr.js — that module is the one
 * under test (test/qr.test.js decodes its output with an independent decoder),
 * and this keeps the same matrix logic against the vendored encoder so what a
 * resident scans is what the tests verified.
 */

import qrcode from './vendor/qrcode-generator.js';

export const ERROR_CORRECTION = 'M';

/** The spec's four-module margin. Many scanners fail without it. */
export const QUIET_ZONE = 4;

export function qrMatrix(text, errorCorrection = ERROR_CORRECTION) {
  if (typeof text !== 'string' || text.length === 0) throw new Error('QR text is empty');
  const qr = qrcode(0, errorCorrection);
  qr.addData(text);
  qr.make();

  const size = qr.getModuleCount();
  const modules = [];
  for (let y = 0; y < size; y++) {
    const row = [];
    for (let x = 0; x < size; x++) row.push(qr.isDark(y, x));
    modules.push(row);
  }
  return { size, modules };
}

/**
 * Draw at a whole-pixel scale. Fractional module sizes produce the soft edges
 * that make a code slow to scan — or fail entirely — on a cheap phone camera.
 */
export function drawQr(canvas, text, { target = 240, quietZone = QUIET_ZONE } = {}) {
  const { size, modules } = qrMatrix(text);
  const total = size + quietZone * 2;
  const scale = Math.max(1, Math.floor(target / total));
  const pixels = total * scale;

  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  canvas.width = pixels * dpr;
  canvas.height = pixels * dpr;
  canvas.style.width = `${pixels}px`;
  canvas.style.height = `${pixels}px`;

  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, pixels, pixels);
  ctx.fillStyle = '#0F172A';
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (modules[y][x]) {
        ctx.fillRect((x + quietZone) * scale, (y + quietZone) * scale, scale, scale);
      }
    }
  }
  return { size, scale, pixels };
}
