/**
 * Client-side image compression.
 *
 * Phone screenshots are 3–8 MB. Without this the upload is slow on Kerala
 * mobile data, the vision call is needlessly expensive, and the free R2 tier
 * fills with pixels nobody looks at. ~1000px at JPEG 0.7 lands around 100 KB
 * and stays comfortably readable — a UPI receipt is large text on a plain
 * background, which survives compression well.
 */

export const MAX_EDGE = 1000;
export const QUALITY = 0.7;

export async function compressImage(file, { maxEdge = MAX_EDGE, quality = QUALITY } = {}) {
  const bitmap = await loadBitmap(file);
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();

  const blob = await new Promise((resolve) =>
    canvas.toBlob(resolve, 'image/jpeg', quality));

  // If compression somehow made it bigger (tiny images can), keep the original.
  if (!blob || blob.size >= file.size) {
    return { blob: file, width: bitmap.width, height: bitmap.height, compressed: false };
  }
  return { blob, width, height, compressed: true, originalSize: file.size };
}

async function loadBitmap(file) {
  if ('createImageBitmap' in window) {
    // imageOrientation matters: phone photos carry EXIF rotation, and a
    // sideways receipt is one the model cannot read.
    return createImageBitmap(file, { imageOrientation: 'from-image' });
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Matches MAX_BYTES on the server, which is the cap that is enforced. */
export const ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;

/**
 * The inline copy shown on the notice board.
 *
 * 400px because that is roughly what the board renders an image at on a phone
 * — going smaller shows visibly soft, going larger sends bytes nobody sees.
 * It lands around 30KB, against up to 25MB for the original, and the original
 * is one tap away for anyone who actually wants to look.
 */
export const THUMB_EDGE = 400;
export const THUMB_QUALITY = 0.7;

/**
 * A small copy for the page, or null when there should not be one.
 *
 * Null for PDFs, which are shown as links, and null if the source is already
 * smaller than the thumbnail would be — a 20KB photo does not need a second
 * object in R2 to save a resident 5KB.
 */
export async function makeThumbnail(file) {
  if (!file.type.startsWith('image/')) return null;

  const { blob } = await compressImage(file, { maxEdge: THUMB_EDGE, quality: THUMB_QUALITY });
  if (!blob || blob.size >= file.size) return null;

  return new File([blob], 'thumb.jpg', { type: blob.type || 'image/jpeg' });
}

/**
 * Progressively smaller attempts, used ONLY to rescue a photo too large to
 * store at all. Ordered largest first, so a file that is barely over the line
 * loses as little as possible.
 */
const FALLBACKS = [
  { maxEdge: 3000, quality: 0.9 },
  { maxEdge: 2400, quality: 0.85 },
  { maxEdge: 1600, quality: 0.8 },
];

/**
 * An attachment ready to upload. Photos go up AS TAKEN.
 *
 * WHY THERE IS NO ROUTINE COMPRESSION HERE. This used to run every photo
 * through compressImage at the payment-proof settings, and that quietly threw
 * away the thing attachments are for: a resident photographs water damage so
 * somebody else can look closely at it, and 1000px on the long edge does not
 * survive being looked closely at. The stored file is the only copy, so what is
 * discarded on upload is discarded permanently.
 *
 * The one exception is a photo above the server's cap, which cannot be stored
 * at all. Shrinking it just enough to fit beats refusing it outright and
 * leaving the resident with no way to report what they are looking at — but it
 * happens on the way past the limit, not to every photo on principle.
 *
 * PDFs cannot be resized without a library this project is not taking on, so
 * they pass through and the server's 5MB cap is what holds them.
 */
export async function prepareUpload(file, { maxBytes = ATTACHMENT_MAX_BYTES } = {}) {
  if (file.type === 'application/pdf') return file;
  if (file.size <= maxBytes) return file;

  for (const settings of FALLBACKS) {
    const { blob } = await compressImage(file, settings);
    if (blob.size <= maxBytes) return renamed(file, blob);
  }

  // Still too big at 1600px: hand back the smallest attempt and let the server
  // reject it with its own message, rather than inventing a second vocabulary
  // for the same refusal.
  const { blob } = await compressImage(file, FALLBACKS[FALLBACKS.length - 1]);
  return renamed(file, blob);
}

/**
 * THE EXTENSION FOLLOWS THE FORMAT. compressImage re-encodes to JPEG whatever
 * went in, so a rescued "pipe-leak.png" would be a JPEG still called .png.
 * Nothing breaks — browsers obey the content-type — but a resident who saves it
 * gets a file their computer opens by luck rather than by name.
 */
function renamed(file, blob) {
  const type = blob.type || file.type;
  const extension = type === 'image/jpeg' ? 'jpg' : type.split('/')[1];
  const name = file.name.replace(/\.[^.]+$/, '') || 'photo';
  return new File([blob], `${name}.${extension}`, { type });
}

export function humanSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
