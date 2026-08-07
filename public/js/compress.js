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

export function humanSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
