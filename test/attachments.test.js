import { describe, it, expect } from 'vitest';
import {
  validateAttachment, validateThumb, safeFilename, shapeAttachments, assertRoom, isLargeUpload,
  MAX_THUMB_BYTES,
  MAX_BYTES, MAX_IMAGE_BYTES, MAX_PDF_BYTES, ALERT_BYTES, MAX_PER_NOTICE, MAX_PER_COMMENT,
} from '../functions/lib/attachments.js';
import { canSeeAttachment } from '../functions/lib/notices.js';

const owner = { id: 1, relationship: 'owner', role: 'owner' };
const tenant = { id: 2, relationship: 'tenant', role: 'owner' };
const admin = { id: 3, relationship: 'owner', role: 'admin' };
const superadmin = { id: 4, relationship: 'owner', role: 'superadmin' };

describe('what may be attached', () => {
  it('accepts the three image types and PDF', () => {
    for (const type of ['image/jpeg', 'image/png', 'image/webp', 'application/pdf']) {
      expect(validateAttachment({ type, size: 1000 }).ok, type).toBe(true);
    }
  });

  it('refuses anything else, including things that look harmless', () => {
    for (const type of ['text/plain', 'image/svg+xml', 'application/zip', 'text/html', '']) {
      expect(validateAttachment({ type, size: 1000 }).ok, type).toBe(false);
    }
  });

  it('refuses an empty file', () => {
    expect(validateAttachment({ type: 'image/png', size: 0 }).ok).toBe(false);
  });

  it('holds everything to one 25MB ceiling', () => {
    expect(MAX_BYTES).toBe(25 * 1024 * 1024);
    expect(MAX_IMAGE_BYTES).toBe(MAX_BYTES);
    expect(MAX_PDF_BYTES).toBe(MAX_BYTES);
    for (const type of ['image/png', 'application/pdf']) {
      expect(validateAttachment({ type, size: MAX_BYTES }).ok, type).toBe(true);
      expect(validateAttachment({ type, size: MAX_BYTES + 1 }).ok, type).toBe(false);
    }
  });

  it('names the limit, so the uploader knows whether to retry', () => {
    const { message } = validateAttachment({ type: 'application/pdf', size: 30 * 1024 * 1024 });
    expect(message).toContain('30MB');
    expect(message).toContain('25MB');
  });

  it('leaves room for a photo straight off a phone', () => {
    // The measured case: a 3024x4032 shot is about 7MB. Storing originals is
    // pointless if the common one is refused.
    expect(validateAttachment({ type: 'image/jpeg', size: 7.3 * 1024 * 1024 }).ok).toBe(true);
  });
});

describe('when the committee is told about an upload', () => {
  it('stays quiet below the threshold', () => {
    expect(isLargeUpload(ALERT_BYTES)).toBe(false);
    expect(isLargeUpload(7.3 * 1024 * 1024)).toBe(false);   // an ordinary phone photo
  });

  it('fires above it', () => {
    expect(isLargeUpload(ALERT_BYTES + 1)).toBe(true);
    expect(isLargeUpload(22 * 1024 * 1024)).toBe(true);
  });

  it('warns before it refuses, so the alert is about files that are now stored', () => {
    // A rejected upload costs nothing; the ones worth a Telegram message are
    // the ones sitting in R2. That only works while ALERT sits under MAX.
    expect(ALERT_BYTES).toBeLessThan(MAX_BYTES);
    expect(validateAttachment({ type: 'image/jpeg', size: ALERT_BYTES + 1 }).ok).toBe(true);
  });
});

describe('thumbnails', () => {
  it('accepts a small image', () => {
    expect(validateThumb({ type: 'image/jpeg', size: 30 * 1024 })).toBe(true);
  });

  it('refuses a PDF, which cannot be a thumbnail', () => {
    expect(validateThumb({ type: 'application/pdf', size: 1000 })).toBe(false);
  });

  it('refuses anything not on the accepted list', () => {
    expect(validateThumb({ type: 'image/svg+xml', size: 1000 })).toBe(false);
    expect(validateThumb({ type: 'text/html', size: 1000 })).toBe(false);
  });

  it('refuses a full-size file smuggled in as a thumbnail', () => {
    // The browser makes this part, so the field is a claim, not a fact. Without
    // a ceiling it is a second upload slot outside the per-parent cap.
    expect(validateThumb({ type: 'image/jpeg', size: MAX_THUMB_BYTES })).toBe(true);
    expect(validateThumb({ type: 'image/jpeg', size: MAX_THUMB_BYTES + 1 })).toBe(false);
    expect(validateThumb({ type: 'image/jpeg', size: 4 * 1024 * 1024 })).toBe(false);
  });

  it('refuses an empty one', () => {
    expect(validateThumb({ type: 'image/jpeg', size: 0 })).toBe(false);
  });

  it('points the board at the thumbnail when there is one', () => {
    const [a] = shapeAttachments([{
      id: 5, filename: 'leak.jpg', content_type: 'image/jpeg', bytes: 3_000_000,
      thumb_key: 'attachments/notice/1/x.thumb.jpg', deleted_at: null,
    }]);
    expect(a.thumbUrl).toBe('/api/attachments/5/thumb');
    expect(a.url).toBe('/api/attachments/5');
    expect(a.hasThumb).toBe(true);
  });

  it('falls back to the full image for attachments uploaded before 0019', () => {
    const [a] = shapeAttachments([{
      id: 6, filename: 'old.jpg', content_type: 'image/jpeg', bytes: 900,
      thumb_key: null, deleted_at: null,
    }]);
    expect(a.thumbUrl).toBe('/api/attachments/6');
    expect(a.hasThumb).toBe(false);
  });

  it('still never leaks a key', () => {
    const shaped = shapeAttachments([{
      id: 7, filename: 'x.jpg', content_type: 'image/jpeg', bytes: 10,
      thumb_key: 'attachments/notice/1/secret.thumb.jpg', deleted_at: null,
    }]);
    expect(JSON.stringify(shaped)).not.toContain('secret');
  });
});

describe('filenames', () => {
  it('keeps a name a resident will recognise', () => {
    expect(safeFilename('quote-shalimar.pdf')).toBe('quote-shalimar.pdf');
  });

  it('drops any path in front of it', () => {
    expect(safeFilename('../../etc/passwd')).toBe('passwd');
    expect(safeFilename('C:\\Users\\me\\agm.pdf')).toBe('agm.pdf');
  });

  it('strips quotes and control characters that would break the header', () => {
    expect(safeFilename('a"b\u0000c.pdf')).toBe('abc.pdf');
  });

  it('refuses to produce a hidden file', () => {
    expect(safeFilename('...hidden')).toBe('hidden');
  });

  it('falls back when nothing usable is left', () => {
    expect(safeFilename('')).toBe('attachment');
    expect(safeFilename(null)).toBe('attachment');
    expect(safeFilename('"""')).toBe('attachment');
  });
});

describe('what the browser is told', () => {
  const rows = [
    { id: 7, filename: 'agm.pdf', content_type: 'application/pdf', bytes: 2_100_000, deleted_at: null },
    { id: 8, filename: 'leak.jpg', content_type: 'image/jpeg', bytes: 153_600, deleted_at: null },
    { id: 9, filename: 'gone.png', content_type: 'image/png', bytes: 100, deleted_at: '2026-08-10T00:00:00Z' },
  ];

  it('never leaks the R2 key', () => {
    const shaped = shapeAttachments(rows);
    expect(JSON.stringify(shaped)).not.toContain('r2');
    expect(shaped[0]).not.toHaveProperty('r2_key');
  });

  it('drops deleted files', () => {
    expect(shapeAttachments(rows).map((a) => a.id)).toEqual([7, 8]);
  });

  it('gives a size a resident on mobile data can act on', () => {
    const [pdf, jpg] = shapeAttachments(rows);
    expect(pdf.size).toBe('2MB');
    expect(jpg.size).toBe('150KB');
  });

  it('never rounds a small file down to 0KB', () => {
    const [tiny] = shapeAttachments([
      { id: 1, filename: 'a.pdf', content_type: 'application/pdf', bytes: 69, deleted_at: null },
    ]);
    expect(tiny.size).toBe('<1KB');
  });

  it('marks which ones can be shown inline', () => {
    const [pdf, jpg] = shapeAttachments(rows);
    expect(pdf.isImage).toBe(false);
    expect(jpg.isImage).toBe(true);
  });
});

describe('how many may hang off one parent', () => {
  const envWith = (n) => ({ DB: { prepare: () => ({ bind: () => ({ first: async () => ({ n }) }) }) } });

  it('allows a notice up to five', async () => {
    await expect(assertRoom(envWith(MAX_PER_NOTICE - 1), { noticeId: 1 })).resolves.toBeUndefined();
    await expect(assertRoom(envWith(MAX_PER_NOTICE), { noticeId: 1 })).rejects.toThrow(/DDP-ATTACH-002/);
  });

  it('allows a comment up to two', async () => {
    await expect(assertRoom(envWith(MAX_PER_COMMENT - 1), { commentId: 1 })).resolves.toBeUndefined();
    await expect(assertRoom(envWith(MAX_PER_COMMENT), { commentId: 1 })).rejects.toThrow(/DDP-ATTACH-002/);
  });
});

/**
 * The regression this pins: serving used hasRole(session,'admin') as a bypass,
 * and hasRole reads the ACTOR. An admin using view-as was therefore served an
 * owners-only attachment while inside a tenant's session.
 */
describe('who may be served an attachment', () => {
  const openNotice = { active: 1, scope: 'all' };
  const ownersOnly = { active: 1, scope: 'owners' };

  it('serves an all-scoped file to everybody', () => {
    for (const viewer of [owner, tenant, admin]) {
      expect(canSeeAttachment(openNotice, viewer)).toBe(true);
    }
  });

  it('keeps an owners-only file from a tenant', () => {
    expect(canSeeAttachment(ownersOnly, tenant)).toBe(false);
  });

  it('serves an owners-only file to an owner and to an admin', () => {
    expect(canSeeAttachment(ownersOnly, owner)).toBe(true);
    expect(canSeeAttachment(ownersOnly, admin)).toBe(true);
  });

  it('stops serving to residents once the notice is withdrawn', () => {
    for (const viewer of [owner, tenant]) {
      expect(canSeeAttachment({ active: 0, scope: 'all' }, viewer), viewer.role).toBe(false);
    }
  });

  it('still serves a withdrawn notice to the committee, which is the archive', () => {
    expect(canSeeAttachment({ active: 0, scope: 'all' }, admin)).toBe(true);
    expect(canSeeAttachment({ active: 0, scope: 'all' }, superadmin)).toBe(true);
  });

  it('does not let view-as carry an admin into a withdrawn notice', () => {
    // The subject during impersonation is the resident, whose own role is
    // 'owner'. If this ever passes, the actor is being read again.
    expect(canSeeAttachment({ active: 0, scope: 'all' }, { ...owner, role: 'owner' })).toBe(false);
  });

  it('applies scope to withdrawn files too', () => {
    // A tenant is refused for two independent reasons here; neither may lapse.
    expect(canSeeAttachment({ active: 0, scope: 'owners' }, tenant)).toBe(false);
  });

  it('refuses when there is no parent notice at all', () => {
    expect(canSeeAttachment(null, admin)).toBe(false);
    expect(canSeeAttachment(undefined, owner)).toBe(false);
  });
});
