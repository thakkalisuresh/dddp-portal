/**
 * Notices and comments — screen 18.
 *
 * Every comment shows a real name and flat. In a building where everyone meets
 * in the lift, attribution is the moderation system; nothing heavier is needed
 * (plan §4f).
 */

import { api, ApiError } from './api.js';
import { renderNav } from './nav.js';
import { trackPage, trackAction } from './track.js';
import { $, el, esc, renderGodBanner, showError } from './ui.js';
import { stampLabel } from './i18n.js';
import { renderMarkdown } from './markdown.js';
import { prepareUpload, makeThumbnail } from './compress.js';

const main = $('#main');
let isAdmin = false;

trackPage('/notices');
init();

async function init() {
  try {
    const me = await api.me();
    isAdmin = me.role === 'admin' || me.role === 'superadmin';
    $('#who').innerHTML = `Flat ${esc(me.flat)} <span>· ${esc(me.name)}</span>`;
    renderGodBanner(me, { onExit: async () => { await api.god.exit(); location.reload(); } });
    renderNav(me, '/notices');

    const id = new URLSearchParams(location.search).get('id');
    if (id) await renderOne(Number(id));
    else await renderList();
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) { location.href = '/login'; return; }
    showError(main, err);
  }
}

async function renderList() {
  const { notices } = await api.notices();
  main.replaceChildren(
    el('h1', {}, 'Notices'),
    // The publish form lives in the admin console, which an admin standing on
    // the notice board has no way of guessing. This is the only route to it
    // from the page they are actually on when they decide to post something.
    isAdmin
      ? el('p', {},
          el('a', { class: 'linkish', href: '/admin/#notices' }, '+ Post a notice'))
      : null,
    ...(notices.length
      ? notices.map((n) =>
          el('div', { class: `notice ${n.kind === 'event' ? 'notice--event' : ''}` },
            // The heading is the link, and it is a link on EVERY notice — the
            // preview below is clamped to three lines, so a long announcement
            // with replies switched off would otherwise be unreadable in full.
            el('h3', {},
              el('a', { class: 'plain', href: `/notices.html?id=${n.id}` }, n.title)),
            el('p', { class: 'muted small notice__body' }, n.body),
            el('p', { class: 'small muted', style: 'margin-top:var(--s-2)' },
              stampLabel(n.postedAt),
              // Said on the board, because a notice whose point is the attached
              // agenda looks like a notice with nothing in it until you open it.
              n.attachmentCount
                ? ` · 📎 ${n.attachmentCount} file${n.attachmentCount > 1 ? 's' : ''}`
                : '',
              n.allowComments
                ? el('span', {}, ' · ',
                    el('a', { class: 'linkish', href: `/notices.html?id=${n.id}` },
                      n.commentCount ? `${n.commentCount} replies` : 'Reply'))
                : null)))
      : [el('p', { class: 'muted' }, 'Nothing posted yet.')])
  );
}

async function renderOne(id) {
  trackAction('notice:open', { id });
  const n = await api.notice(id);
  const list = el('div', { class: 'stack', style: 'gap:0' });
  const draw = () => list.replaceChildren(...n.comments.map(commentRow));
  draw();

  main.replaceChildren(
    el('p', {}, el('a', { class: 'linkish', href: '/notices.html' }, '← All notices')),
    el('div', { class: 'stack', style: 'gap:var(--s-2)' },
      el('p', { class: 'label' }, stampLabel(n.postedAt)),
      el('h1', {}, n.title),
      // The full notice is the one place formatting is honoured. The list
      // preview stays plain text: three clamped lines of a bulleted agenda is
      // not a summary of anything.
      el('div', { class: 'prose' }, ...renderMarkdown(n.body)),
      attachmentList(n.attachments)),
    el('hr', { class: 'rule' }),
    el('p', { class: 'label' }, n.comments.length ? `${n.comments.length} replies` : 'No replies yet'),
    list,
    n.allowComments ? composer(id) : el('p', { class: 'small muted' }, 'Replies are closed for this notice.')
  );
}

function commentRow(c) {
  if (c.hidden && !isAdmin) return el('div');
  return el('div', { class: `comment ${c.hidden ? 'comment--hidden' : ''}` },
    el('div', { class: 'comment__head' },
      el('span', { class: 'comment__who' },
        c.name ?? '—', el('span', { class: 'muted' }, ` · ${c.flat ?? ''}`)),
      el('span', { class: 'comment__when' }, stampLabel(c.createdAt))),
    el('p', { class: 'comment__body', style: 'margin-top:var(--s-1)' }, c.body ?? ''),
    attachmentList(c.attachments),
    isAdmin
      ? el('button', {
          class: 'linkish', type: 'button', style: 'margin-top:var(--s-2)',
          onclick: async () => {
            await api.admin.setCommentHidden(c.id, !c.hidden);
            location.reload();
          },
        }, c.hidden ? `Unhide (hidden by ${c.hiddenBy ?? 'an admin'})` : 'Hide')
      : null);
}

/**
 * Files hanging off a notice or a reply.
 *
 * Images are shown, because a photo of a leaking pipe IS the message and
 * making somebody tap through to it wastes the one glance they will give it.
 * Everything else is a link carrying its filename and size — a resident on
 * mobile data deciding whether to open a 4MB scan needs to know it is 4MB
 * before they tap, not after.
 *
 * Loading is lazy: a thread can carry a dozen photographs and none of them are
 * why the reader opened it.
 */
function attachmentList(attachments = []) {
  if (!attachments.length) return null;

  return el('div', { class: 'attachments' },
    ...attachments.map((a) =>
      el('div', { class: 'attachment' },
        // The board shows the thumbnail; the link opens the full-quality file.
        // Without this a thread with three photographs pulled up to 75MB down a
        // mobile connection just to render, and the resident who wanted to look
        // closely at one of them still had to tap.
        a.isImage
          ? el('a', { href: a.url, target: '_blank', rel: 'noopener' },
              el('img', {
                class: 'attachment__image', src: a.thumbUrl ?? a.url,
                alt: a.filename, loading: 'lazy', decoding: 'async',
              }))
          : null,
        el('div', { class: 'row', style: 'gap:var(--s-2); align-items:baseline' },
          el('a', { class: 'linkish', href: a.url, target: '_blank', rel: 'noopener' },
            a.isImage ? a.filename : `📎 ${a.filename}`),
          el('span', { class: 'small muted' }, a.size),
          isAdmin
            ? el('button', {
                class: 'linkish small', type: 'button',
                onclick: async () => {
                  // Irreversible, and on somebody else's contribution — so it
                  // asks, unlike hiding a comment, which can be undone.
                  if (!confirm(`Remove ${a.filename}? This cannot be undone.`)) return;
                  await api.admin.deleteAttachment(a.id);
                  location.reload();
                },
              }, 'Remove')
            : null))));
}

function composer(noticeId) {
  const box = el('textarea', { class: 'input', 'aria-label': 'Your reply', maxlength: '1200' });
  const status = el('div');
  const chosen = el('p', { class: 'small muted' });

  const picker = el('input', {
    type: 'file', class: 'input', 'aria-label': 'Attach photos or a PDF',
    accept: 'image/jpeg,image/png,image/webp,application/pdf',
    multiple: true,
    onchange: () => {
      const files = [...picker.files].slice(0, MAX_FILES);
      chosen.replaceChildren(files.length
        ? `${files.length} file${files.length > 1 ? 's' : ''}: ${files.map((f) => f.name).join(', ')}`
        : '');
    },
  });

  const post = el('button', {
    class: 'btn', type: 'button',
    onclick: async () => {
      status.replaceChildren();
      // Disabled for the whole round trip. Attaching runs a second request per
      // file, so the window in which an impatient second tap posts a duplicate
      // reply is much wider here than it was for a plain comment.
      post.disabled = true;
      try {
        const { id } = await api.postComment(noticeId, box.value);

        const files = [...picker.files].slice(0, MAX_FILES);
        for (const [i, file] of files.entries()) {
          status.replaceChildren(el('p', { class: 'small muted' },
            `Uploading ${i + 1} of ${files.length}…`));
          const ready = await prepareUpload(file);
          await api.attach('comment', id, ready, await makeThumbnail(ready));
        }
        location.reload();
      } catch (err) {
        showError(status, err);
        post.disabled = false;
      }
    },
  }, 'Post');

  return el('div', { class: 'stack', style: 'margin-top:var(--s-4)' },
    el('p', { class: 'label' }, 'Add a reply'),
    box,
    picker,
    chosen,
    el('p', { class: 'small muted' },
      `Up to ${MAX_FILES} photos or PDFs, 25MB each. Photos keep their full `
      + 'quality, so anyone can zoom in.'),
    status,
    post,
    // Attribution is stated up front, because it is the moderation system.
    el('p', { class: 'small muted' }, 'Your name and flat are shown with your reply.'));
}

/** Matches MAX_PER_COMMENT on the server, which is the one that is enforced. */
const MAX_FILES = 2;
