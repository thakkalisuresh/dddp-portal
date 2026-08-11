/**
 * Attachments on notices and comments.
 *
 * The upload path this borrows from is payment proofs (lib/proof.js): validate
 * before anything costs money, compress on the phone rather than on the wire,
 * soft-delete so moderation leaves a trace. What is different is WHO uploads.
 * A proof is one resident sending one image to the treasurer. An attachment is
 * published to everyone in the building the moment it lands, and on comments
 * the uploader is a resident rather than a committee member. So the caps here
 * are about restraint, not just cost: a small number of small files.
 */

import { fail } from './errors.js';

/**
 * One ceiling for everything, and it is not the proofs' 2MB.
 *
 * The first version reused the payment-proof pipeline wholesale, which resizes
 * to 1000px at quality 0.7 — right for a UPI receipt, which is large text on a
 * plain background and only has to be read once by the treasurer. It is wrong
 * for the photographs this feature exists to carry. A damp patch, a crack, a
 * meter dial: those are evidence somebody may need to look INTO, and at
 * 750x1000 they cannot. Nor is there a second copy to fall back on — whatever
 * is stored is the only one there will ever be.
 *
 * 25MB takes a phone photo at full resolution (3-8MB) and a scanned AGM
 * booklet, with room left over. It also sits well inside the 100MB a Worker
 * will accept as a request body, so the limit a resident meets is this one,
 * with a message, rather than the platform's, without.
 */
export const MAX_BYTES = 25 * 1024 * 1024;
export const MAX_IMAGE_BYTES = MAX_BYTES;
export const MAX_PDF_BYTES = MAX_BYTES;

/**
 * Above this, the committee hears about it on Telegram as it happens.
 *
 * Deliberately BELOW the cap rather than at it. An alert that only fires on
 * rejection tells you about the uploads that cost nothing; the ones worth
 * knowing about are the ones that succeeded and are now sitting in R2. The gap
 * between 20 and 25 is the warning track.
 */
export const ALERT_BYTES = 20 * 1024 * 1024;

export const ACCEPTED = {
  'image/jpeg': MAX_IMAGE_BYTES,
  'image/png': MAX_IMAGE_BYTES,
  'image/webp': MAX_IMAGE_BYTES,
  'application/pdf': MAX_PDF_BYTES,
};

/** Big enough that somebody should be told, without having to be refused. */
export const isLargeUpload = (bytes) => Number(bytes) > ALERT_BYTES;

/**
 * A thumbnail is made in the browser, so the server treats it as a claim to be
 * checked rather than a fact. It must be an image, and it must be small — a
 * "thumbnail" arriving at 4MB is either a bug or somebody using the field to
 * store a second full-size file outside the per-parent cap.
 */
export const MAX_THUMB_BYTES = 512 * 1024;

export function validateThumb({ type, size }) {
  if (!type?.startsWith('image/') || !ACCEPTED[type]) return false;
  return Number.isFinite(size) && size > 0 && size <= MAX_THUMB_BYTES;
}

/**
 * How many files may hang off one parent.
 *
 * A notice gets five because "here are the three quotes plus the current
 * contract" is a real committee post. A comment gets two because a reply is a
 * remark with evidence attached, and a resident who needs more than two photos
 * is describing something that deserves its own notice.
 */
export const MAX_PER_NOTICE = 5;
export const MAX_PER_COMMENT = 2;

/**
 * '150KB', '2MB', '4.5MB' — one decimal, and never a pointless '.0'.
 *
 * Anything under a kilobyte reads as '<1KB' rather than rounding to '0KB',
 * which looks like a broken upload sitting next to a file that opens fine.
 */
const humanBytes = (n) => {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1).replace(/\.0$/, '')}MB`;
  return n < 1024 ? '<1KB' : `${Math.round(n / 1024)}KB`;
};

/** Reject an upload before it costs anything. */
export function validateAttachment({ type, size }) {
  const cap = ACCEPTED[type];
  if (!cap) {
    return { ok: false, message: 'Attach a photo (JPEG, PNG or WebP) or a PDF.' };
  }
  if (!Number.isFinite(size) || size <= 0) {
    return { ok: false, message: 'That file appears to be empty.' };
  }
  if (size > cap) {
    // The limit is named, because "too large" without a number leaves the
    // uploader guessing whether to retry or give up.
    return {
      ok: false,
      message: type === 'application/pdf'
        ? `That PDF is ${humanBytes(size)}. The limit is ${humanBytes(cap)}.`
        : `That photo is ${humanBytes(size)}. The limit is ${humanBytes(cap)}.`,
    };
  }
  return { ok: true };
}

/**
 * A filename safe to store and to send back in a header.
 *
 * The uploader's name is kept because "quote-shalimar.pdf" tells a resident
 * what they are about to open and "file.pdf" does not. Everything structural
 * is stripped: directory separators, control characters, and leading dots that
 * would produce a hidden file on whatever the resident downloads it to.
 */
export function safeFilename(name, fallback = 'attachment') {
  const base = String(name ?? '').split(/[/\\]/).pop() ?? '';
  const cleaned = base
    // Control characters, quotes and backslashes: all of them would break
    // the Content-Disposition header this name is later written into.
    .replace(/[\u0000-\u001f\u007f"'\\]/g, '')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 120);
  return cleaned || fallback;
}

/**
 * R2 keys are grouped by parent so everything for one notice can be found — and
 * removed — together. The random suffix keeps two residents who both upload
 * "IMG_0001.jpg" from colliding; unlike proofs there is no content hash here,
 * because the same photo posted to two different notices is two attachments.
 */
export function r2Key({ noticeId, commentId }, filename) {
  const parent = noticeId ? `notice/${noticeId}` : `comment/${commentId}`;
  const stamp = new Date().toISOString().slice(0, 10);
  const nonce = crypto.randomUUID().slice(0, 8);
  return `attachments/${parent}/${stamp}-${nonce}-${safeFilename(filename)}`;
}

/** What the browser is told about an attachment. Never the R2 key. */
export function shapeAttachments(rows = []) {
  return rows
    .filter((r) => !r.deleted_at)
    .map((r) => ({
      id: r.id,
      filename: r.filename,
      contentType: r.content_type,
      bytes: r.bytes,
      size: humanBytes(r.bytes),
      isImage: r.content_type !== 'application/pdf',
      url: `/api/attachments/${r.id}`,
      // Falls back to the full image when there is no thumbnail: attachments
      // uploaded before 0019 have none, and neither does an image already
      // smaller than a thumbnail would have been. The board renders the same
      // either way rather than carrying two cases.
      thumbUrl: r.thumb_key ? `/api/attachments/${r.id}/thumb` : `/api/attachments/${r.id}`,
      hasThumb: Boolean(r.thumb_key),
    }));
}

/**
 * Refuse the upload that would take a parent past its cap.
 *
 * Counted in the database rather than trusted from the client, because the
 * client sends one file per request and cannot see the others in flight.
 */
export async function assertRoom(env, { noticeId, commentId }) {
  const [column, id, cap] = noticeId
    ? ['notice_id', noticeId, MAX_PER_NOTICE]
    : ['comment_id', commentId, MAX_PER_COMMENT];

  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM attachments WHERE ${column} = ? AND deleted_at IS NULL`
  ).bind(id).first();

  if ((row?.n ?? 0) >= cap) {
    fail('DDP-ATTACH-002', { [column]: id, cap });
  }
}
