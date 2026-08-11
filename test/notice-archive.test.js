import { describe, it, expect } from 'vitest';
import { purgeNotice, getNotice } from '../functions/lib/notices.js';

/**
 * Withdrawing keeps everything and shows it to the committee; purging destroys
 * it and is the superadmin's alone. The rule that matters most here is the one
 * separating the two: a live notice can never be purged in a single step.
 */

const admin = { id: 2, relationship: 'owner', role: 'admin' };
const superadmin = { id: 1, relationship: 'owner', role: 'superadmin' };
const resident = { id: 3, relationship: 'owner', role: 'owner' };

/** A D1 stand-in that records what it was asked to run. */
function fakeDb({ notice, attachments = [], comments = [] }) {
  const ran = [];
  return {
    ran,
    DB: {
      prepare(sql) {
        ran.push(sql.replace(/\s+/g, ' ').trim());
        return {
          bind: () => ({
            first: async () => (/FROM notices/.test(sql) ? notice : null),
            all: async () => ({
              results: /FROM attachments/.test(sql) ? attachments
                : /FROM comments/.test(sql) ? comments : [],
            }),
            run: async () => ({}),
          }),
        };
      },
    },
  };
}

describe('purging a notice', () => {
  it('refuses one that is still live', async () => {
    const env = fakeDb({ notice: { id: 5, title: 'AGM', active: 1 } });
    await expect(purgeNotice(env, 5)).rejects.toThrow(/DDP-NOTICE-005/);
  });

  it('refuses one that does not exist', async () => {
    const env = fakeDb({ notice: null });
    await expect(purgeNotice(env, 99)).rejects.toThrow(/DDP-NOTICE-001/);
  });

  it('returns the R2 keys for the caller to remove, thumbnails included', async () => {
    const env = fakeDb({
      notice: { id: 5, title: 'Terrace quotes', active: 0 },
      attachments: [
        { id: 1, r2_key: 'attachments/notice/5/a.pdf', thumb_key: null },
        { id: 2, r2_key: 'attachments/comment/9/b.jpg', thumb_key: 'attachments/comment/9/b.jpg.thumb.jpg' },
        { id: 3, r2_key: null, thumb_key: null },   // soft-deleted; nothing left
      ],
    });
    const result = await purgeNotice(env, 5);
    // A thumbnail is a legible copy of the same photograph, so a purge that
    // left it behind would not be one.
    expect(result.keys).toEqual([
      'attachments/notice/5/a.pdf',
      'attachments/comment/9/b.jpg',
      'attachments/comment/9/b.jpg.thumb.jpg',
    ]);
    expect(result.title).toBe('Terrace quotes');
  });

  it('deletes children before parents, so no foreign key is left dangling', async () => {
    const env = fakeDb({ notice: { id: 5, title: 'x', active: 0 } });
    await purgeNotice(env, 5);

    const deletes = env.ran.filter((sql) => sql.startsWith('DELETE'));
    expect(deletes[0]).toMatch(/DELETE FROM attachments/);
    expect(deletes[1]).toMatch(/DELETE FROM comments/);
    expect(deletes[2]).toMatch(/DELETE FROM notices/);
  });

  it('takes the replies\' attachments too, not only the notice\'s own', async () => {
    const env = fakeDb({ notice: { id: 5, title: 'x', active: 0 } });
    await purgeNotice(env, 5);
    const [attachmentDelete] = env.ran.filter((sql) => sql.startsWith('DELETE FROM attachments'));
    expect(attachmentDelete).toMatch(/comment_id IN \(SELECT id FROM comments WHERE notice_id = \?\)/);
  });
});

describe('reading a withdrawn notice', () => {
  const withdrawn = { id: 5, title: 'x', body: 'y', active: 0, scope: 'all' };

  it('is refused to a resident even when asked for explicitly', async () => {
    const env = fakeDb({ notice: withdrawn });
    expect(await getNotice(env, 5, { viewer: resident, includeWithdrawn: true })).toBeNull();
  });

  it('is refused to the committee unless the archive asks for it', async () => {
    const env = fakeDb({ notice: withdrawn });
    expect(await getNotice(env, 5, { viewer: admin })).toBeNull();
  });

  it('opens for the committee from the archive', async () => {
    for (const viewer of [admin, superadmin]) {
      const env = fakeDb({ notice: withdrawn });
      const notice = await getNotice(env, 5, { viewer, includeWithdrawn: true });
      expect(notice, viewer.role).not.toBeNull();
      expect(notice.id).toBe(5);
    }
  });

  it('still applies scope to a withdrawn notice', async () => {
    const env = fakeDb({ notice: { ...withdrawn, scope: 'owners' } });
    const tenantAdminless = { id: 9, relationship: 'tenant', role: 'owner' };
    expect(await getNotice(env, 5, { viewer: tenantAdminless, includeWithdrawn: true })).toBeNull();
  });
});
