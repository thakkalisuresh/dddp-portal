/**
 * Notices and comments — screen 18.
 *
 * Every comment shows a real name and flat. In a building where everyone meets
 * in the lift, attribution is the moderation system; nothing heavier is needed
 * (plan §4f).
 */

import { api, ApiError } from './api.js';
import { trackPage, trackAction } from './track.js';
import { $, el, esc, renderGodBanner, showError } from './ui.js';
import { dayLabel } from './i18n.js';

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

    const id = new URLSearchParams(location.search).get('id');
    if (id) await renderOne(Number(id));
    else await renderList();
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) { location.href = '/login.html'; return; }
    showError(main, err);
  }
}

async function renderList() {
  const { notices } = await api.notices();
  main.replaceChildren(
    el('h1', {}, 'Notices'),
    ...(notices.length
      ? notices.map((n) =>
          el('div', { class: `notice ${n.kind === 'event' ? 'notice--event' : ''}` },
            el('h3', {}, n.title),
            el('p', { class: 'muted small' }, n.body),
            el('p', { class: 'small muted', style: 'margin-top:var(--s-2)' },
              dayLabel(n.postedAt),
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
      el('p', { class: 'label' }, dayLabel(n.postedAt)),
      el('h1', {}, n.title),
      el('p', {}, n.body)),
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
      el('span', { class: 'comment__when' }, dayLabel(c.createdAt))),
    el('p', { style: 'margin-top:var(--s-1)' }, c.body ?? ''),
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

function composer(noticeId) {
  const box = el('textarea', { class: 'input', 'aria-label': 'Your reply', maxlength: '1200' });
  const status = el('div');

  return el('div', { class: 'stack', style: 'margin-top:var(--s-4)' },
    el('p', { class: 'label' }, 'Add a reply'),
    box,
    status,
    el('button', {
      class: 'btn', type: 'button',
      onclick: async () => {
        status.replaceChildren();
        try {
          await api.postComment(noticeId, box.value);
          location.reload();
        } catch (err) { showError(status, err); }
      },
    }, 'Post'),
    // Attribution is stated up front, because it is the moderation system.
    el('p', { class: 'small muted' }, 'Your name and flat are shown with your reply.'));
}
