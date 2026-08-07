/**
 * QR matrix generation, shared by the browser and the tests.
 *
 * A wrong QR means a resident pays the wrong amount to the wrong place, so
 * test/qr.test.js decodes what this produces with an independent decoder and
 * asserts it round-trips to the exact UPI URI. Rendering something
 * QR-shaped is not evidence that it scans.
 */

import qrcode from 'qrcode-generator';
import { fail } from './errors.js';

/** Error correction M — survives the smudged phone screens these get scanned off. */
export const ERROR_CORRECTION = 'M';

/**
 * @returns {{ size: number, modules: boolean[][] }}
 */
export function qrMatrix(text, errorCorrection = ERROR_CORRECTION) {
  // An empty QR renders as a plausible-looking box that scans to nothing, so
  // this must be loud rather than drawn.
  if (typeof text !== 'string' || text.length === 0) fail('DDP-PAY-005', { text });
  const qr = qrcode(0, errorCorrection); // 0 = pick the smallest version that fits
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
 * Draw onto a canvas. The quiet zone is not decoration — the spec requires
 * four modules of margin and many scanners fail without it.
 */
export const QUIET_ZONE = 4;

export function drawQrToCanvas(canvas, text, { quietZone = QUIET_ZONE } = {}) {
  const { size, modules } = qrMatrix(text);
  const total = size + quietZone * 2;
  const scale = Math.max(1, Math.floor(canvas.width / total));
  const drawn = total * scale;

  canvas.width = drawn;
  canvas.height = drawn;

  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, drawn, drawn);
  ctx.fillStyle = '#0F172A';
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (modules[y][x]) {
        ctx.fillRect((x + quietZone) * scale, (y + quietZone) * scale, scale, scale);
      }
    }
  }
  return { size, scale, pixels: drawn };
}

/** Matrix -> RGBA bytes. Used by the tests to feed an independent decoder. */
export function qrToRgba(text, { scale = 4, quietZone = QUIET_ZONE } = {}) {
  const { size, modules } = qrMatrix(text);
  const total = (size + quietZone * 2) * scale;
  const data = new Uint8ClampedArray(total * total * 4).fill(255);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!modules[y][x]) continue;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const px = ((quietZone + x) * scale + dx);
          const py = ((quietZone + y) * scale + dy);
          const i = (py * total + px) * 4;
          data[i] = data[i + 1] = data[i + 2] = 0;
        }
      }
    }
  }
  return { data, width: total, height: total };
}
