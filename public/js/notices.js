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
import { $, el, esc, renderViewBanner, showError, setChildren } from './ui.js';
import { stampLabel } from './i18n.js';
import { renderMarkdown } from './markdown.js';
import { prepareUpload, makeThumbnail } from './compress.js';

const main = $('#main');

/**
 * Two flags, because the committee member split what used to be one question.
 *
 * `isAdmin` is the MODERATOR: hides a reply, removes somebody else's photo.
 * `isCommittee` is the wider READER: an admin, the superadmin, or a committee
 * member, all of whom see a hidden comment's text and who hid it.
 *
 * Collapsing these back into one flag would either hand a committee member a
 * Hide button the server refuses — the worst kind, since it looks like it
 * worked until the page reloads — or blank out the hidden replies they were
 * deliberately given. Neither is a display detail.
 */
let isAdmin = false;
let isCommittee = false;

trackPage('/notices');
init();

async function init() {
  try {
    const me = await api.me();
    isAdmin = me.role === 'admin' || me.role === 'superadmin';
    isCommittee = isAdmin || me.role === 'committee';
    $('#who').innerHTML = `Flat ${esc(me.flat)} <span>· ${esc(me.name)}</span>`;
    renderViewBanner(me, { onExit: async () => { await api.god.exit(); location.reload(); } });
    renderNav(me, '/notices');

    const id = new URLSearchParams(location.search).get('id');
    if (id) await renderOne(Number(id));
    else await renderList();
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) { location.href = '/login'; return; }
    showError(main, err);
  }
}

/**
 * Whether the admin controls are showing. Deliberately not remembered across
 * loads: the default state of a notice board is reading it.
 */
let manageOpen = false;

/**
 * The toggle, rendered on BOTH views — and that is the whole fix for a bug
 * that made the admin's editor unreachable.
 *
 * Opening a notice is a full page load (the list links to
 * `/notices.html?id=N`), so `manageOpen` is false every time a notice page
 * starts, by the design stated above. The toggle used to be rendered only by
 * renderList, which meant an admin on a notice page had a flag that was always
 * false and no control anywhere to flip it — and the bar is gated on
 * `isAdmin && manageOpen`. An admin could therefore never edit or withdraw a
 * notice, on a board that is now the ONLY place either is possible: the
 * console's notice section was deliberately emptied when this moved here.
 * Committee members were unaffected, which is why it survived review.
 *
 * `rerender` is what makes it work on both. The toggle mutates module state,
 * so whoever draws it has to say how to draw itself again; hardcoding
 * renderList() would have thrown a reader back to the board on every click.
 */
function manageToggle(rerender) {
  return el('p', {},
    el('button', {
      class: 'linkish', type: 'button',
      'aria-expanded': String(manageOpen),
      onclick: () => { manageOpen = !manageOpen; rerender(); },
    }, manageOpen ? 'Done managing' : 'Manage notices'));
}

/**
 * Withdrawn notices, kept rather than destroyed — moved here from the admin
 * console's Archive tab.
 *
 * Archive was one bin holding two unrelated things: withdrawn notices and
 * deleted proof images. Nobody wants to see archived things in general; they
 * want THIS notice they took down. So it belongs beside the notices, and the
 * proof half belongs beside the proofs.
 *
 * The cost of the split, stated because it is real: the restore/delete
 * permission rule now lives in two files instead of one. Restoring is an
 * admin's call because withdrawing already is, and an undo that needs a more
 * senior person than the do is a trap; destroying stays the superadmin's alone.
 */
function withdrawnNotices() {
  const wrap = el('div', { class: 'stack' }, el('p', { class: 'muted small' }, 'Loading…'));

  api.admin.noticeArchive().then(({ notices }) => {
    setChildren(wrap,
      el('p', { class: 'label' }, 'Withdrawn'),
      el('p', { class: 'muted small' },
        'Off the board but kept, with their replies and files. Restoring puts one '
        + 'back in front of residents.'),
      ...(notices.length
        ? notices.map((n) =>
            el('div', { class: 'row row--between', style: 'padding:var(--s-2) 0' },
              el('div', {},
                el('b', {}, n.title),
                el('div', { class: 'small muted' },
                  // `=== 1`, not `> 1` like the two counts below: nothing
                  // guards zero here, and a withdrawn notice with no replies
                  // is the common case — `> 1` would print "0 reply".
                  `${stampLabel(n.postedAt)} · ${n.commentCount} repl${n.commentCount === 1 ? 'y' : 'ies'}`
                  + (n.attachmentCount ? ` · ${n.attachmentCount} file${n.attachmentCount > 1 ? 's' : ''}` : ''))),
              el('button', {
                class: 'btn btn--sm btn--quiet', type: 'button',
                onclick: async () => {
                  await api.admin.updateNotice(n.id, { active: true });
                  await renderList();
                },
              }, 'Restore')))
        : [el('p', { class: 'muted small' }, 'Nothing withdrawn.')]));
  }).catch((err) => showError(wrap, err));

  return wrap;
}

async function renderList() {
  const { notices } = await api.notices();
  // setChildren, NOT the native replaceChildren: the admin link below is a
  // `cond ? node : null`, and the native method stringifies null, so a RESIDENT
  // — the one person who never sees the link — got the word "null" printed
  // above the notices. Reported from the live site on 2026-08-12. The helper
  // exists for exactly this and its docstring already recorded the same bug
  // shipping once before, on the public homepage.
  setChildren(main,
    el('h1', {}, 'Notices'),
    // MANAGING A NOTICE HAPPENS ON THE NOTICE BOARD NOW, not in the admin
    // console. An admin used to read notices here and manage them somewhere
    // else — two places for one set of objects — and the "+ Post a notice"
    // link that used to sit here was an apology for the split rather than a
    // fix for it.
    //
    // Behind a deliberate toggle, though, and closed by default. Reading and
    // withdrawing are different acts, and this repo keeps them apart on purpose
    // (the superadmin gate on contact requests; 5302314 moving five methods out
    // of the god object). Merging the destination must not merge the gesture:
    // nobody should withdraw a notice while scrolling past it.
    isAdmin ? manageToggle(renderList) : null,
    // A committee member has no admin console to be sent to — this board is the
    // whole of their job, so their form is unconditional. An admin's is behind
    // the toggle, because they have the rest of the console and do not need a
    // composer in front of them every time they come to read.
    (isCommittee && !isAdmin) || (isAdmin && manageOpen) ? noticeComposer() : null,
    isAdmin && manageOpen ? withdrawnNotices() : null,
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
                      n.commentCount
                        ? `${n.commentCount} repl${n.commentCount > 1 ? 'ies' : 'y'}`
                        : 'Reply'))
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

  // setChildren, NOT the native replaceChildren, now that a `cond ? node :
  // null` is passed at this level: the native method stringifies null and
  // prints the word to the one person who never sees the control. That exact
  // bug reached the live board on 2026-08-12 and renderList carries the note.
  setChildren(main,
    el('p', {}, el('a', { class: 'linkish', href: '/notices.html' }, '← All notices')),
    // The same toggle the board has, for the same reason it is a toggle there:
    // reading a notice and withdrawing it are different acts. Without it an
    // admin has no way to reach the bar below, because a notice page always
    // starts with manageOpen false.
    isAdmin ? manageToggle(() => renderOne(id)) : null,
    el('div', { class: 'stack', style: 'gap:var(--s-2)' },
      el('p', { class: 'label' }, stampLabel(n.postedAt)),
      el('h1', {}, n.title),
      // The full notice is the one place formatting is honoured. The list
      // preview stays plain text: three clamped lines of a bulleted agenda is
      // not a summary of anything.
      el('div', { class: 'prose' }, ...renderMarkdown(n.body)),
      attachmentList(n.attachments, isAdmin || Boolean(n.canManage)),
      // `canManage` comes from the server, which computed it with the same
      // function the PATCH route enforces. Asking the client to work it out
      // from a role would put a second, weaker copy of the rule here. Who
      // sees the bar and when is manageBar's own business, documented there.
      (n.canManage && !isAdmin) || (isAdmin && manageOpen) ? manageBar(n) : null),
    el('hr', { class: 'rule' }),
    el('p', { class: 'label' }, n.comments.length
      ? `${n.comments.length} repl${n.comments.length > 1 ? 'ies' : 'y'}`
      : 'No replies yet'),
    list,
    n.allowComments ? composer(id) : el('p', { class: 'small muted' }, 'Replies are closed for this notice.')
  );
}

function commentRow(c) {
  // Reading a hidden reply is a committee read; UNHIDING it is a moderation
  // act, and the button below stays with the admins. The server agrees on
  // both halves — it sends the text to a committee member and refuses them
  // the hide endpoint.
  if (c.hidden && !isCommittee) return el('div');
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
 *
 * @param canRemove  who may take a file down. Defaults to the admins, which is
 *   the answer for every file on a REPLY — a resident's photograph, removable
 *   only as a moderation decision. A notice's own files pass the poster in as
 *   well, so a committee member can undo their own mis-upload.
 */
function attachmentList(attachments = [], canRemove = isAdmin) {
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
          canRemove
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

/** The scope select, shared by the composer and the edit form. */
function scopeSelect(current = 'all') {
  const sel = el('select', { class: 'input', 'aria-label': 'Who can see this' },
    el('option', { value: 'all' }, 'Everyone in the building'),
    el('option', { value: 'owners' }, 'Owners only — hidden from tenants'));
  sel.value = current;
  return sel;
}

/**
 * Post a notice, from the board itself.
 *
 * WHY IT IS COLLAPSED. This form sits above the notices for the handful of
 * people who can post, and those same people read the board far more often
 * than they write to it. Open by default it would push every notice down a
 * screen for the readers who need them most.
 *
 * The attach-after-post order is the one api.attach documents: the notice is
 * created first, so a failed upload leaves a notice with a missing file — which
 * can be retried — rather than a half-written notice nobody can see.
 */
function noticeComposer() {
  const title = el('input', { class: 'input', type: 'text', 'aria-label': 'Title', maxlength: '120' });
  const body  = el('textarea', { class: 'input', 'aria-label': 'Notice', rows: '6' });
  const scope = scopeSelect();
  const event = el('input', { class: 'input', type: 'date', 'aria-label': 'Event date' });
  const isEvent = el('input', { type: 'checkbox' });
  const replies = el('input', { type: 'checkbox' });
  const status = el('div');
  const chosen = el('p', { class: 'small muted' });

  const picker = el('input', {
    type: 'file', class: 'input', 'aria-label': 'Attach photos or a PDF',
    accept: 'image/jpeg,image/png,image/webp,application/pdf', multiple: true,
    onchange: () => {
      const files = [...picker.files].slice(0, MAX_FILES);
      chosen.replaceChildren(files.length ? files.map((f) => f.name).join(', ') : '');
    },
  });

  const post = el('button', {
    class: 'btn', type: 'button',
    onclick: async () => {
      status.replaceChildren();
      if (!title.value.trim() || !body.value.trim()) {
        status.replaceChildren(el('p', { class: 'small' }, 'A notice needs a title and a body.'));
        return;
      }
      // Held down for the whole round trip, uploads included. Every file is a
      // separate request, so the window in which an impatient second tap posts
      // the notice twice is much wider than a single POST would make it.
      post.disabled = true;
      try {
        const { id } = await api.admin.addNotice({
          title: title.value.trim(),
          body: body.value.trim(),
          kind: isEvent.checked ? 'event' : 'notice',
          eventDate: isEvent.checked && event.value ? event.value : null,
          allowComments: replies.checked,
          scope: scope.value,
        });

        const files = [...picker.files].slice(0, MAX_FILES);
        for (const [i, file] of files.entries()) {
          status.replaceChildren(el('p', { class: 'small muted' },
            `Uploading ${i + 1} of ${files.length}…`));
          const ready = await prepareUpload(file);
          await api.attach('notice', id, ready, await makeThumbnail(ready));
        }
        location.href = `/notices.html?id=${id}`;
      } catch (err) {
        showError(status, err);
        post.disabled = false;
      }
    },
  }, 'Post notice');

  const form = el('div', { class: 'stack', hidden: true },
    el('p', { class: 'label' }, 'Title'), title,
    el('p', { class: 'label' }, 'Notice'), body,
    el('p', { class: 'small muted' },
      'Lists, bold and links are honoured on the notice page.'),
    el('p', { class: 'label' }, 'Who can see this'), scope,
    el('label', { class: 'row', style: 'gap:var(--s-2)' }, isEvent, 'This is an event'),
    event,
    el('label', { class: 'row', style: 'gap:var(--s-2)' }, replies, 'Allow replies'),
    picker, chosen, status, post);

  const toggle = el('button', {
    class: 'linkish', type: 'button',
    onclick: () => {
      form.hidden = !form.hidden;
      toggle.textContent = form.hidden ? '+ Post a notice' : 'Cancel';
      if (!form.hidden) title.focus();
    },
  }, '+ Post a notice');

  return el('div', { class: 'stack', style: 'margin-bottom:var(--s-4)' }, toggle, form);
}

/**
 * Edit or withdraw a notice you posted.
 *
 * The ONE editor for a notice, for both roles. A committee member gets it
 * unconditionally on a notice they posted — this board is the whole of their
 * job. An admin gets it behind the `Manage notices` toggle, so opening a
 * notice to read it does not put Withdraw under the reader's thumb. Keeping
 * the admin's copy here rather than in the console is deliberate: two sets of
 * the same controls would mean two places to fix the day one of them is wrong.
 *
 * WITHDRAW, NOT DELETE. `active = 0` is the same soft withdrawal the console
 * performs: the notice, its replies and its files go to the archive, where the
 * committee can still read them. Nothing on this page destroys anything, and
 * permanent deletion stays where it is, behind the superadmin.
 */
function manageBar(n) {
  const title = el('input', { class: 'input', type: 'text', maxlength: '120', 'aria-label': 'Title' });
  const body  = el('textarea', { class: 'input', rows: '6', 'aria-label': 'Notice' });
  const scope = scopeSelect(n.scope);
  const replies = el('input', { type: 'checkbox' });
  const status = el('div');
  title.value = n.title;
  body.value = n.body;
  replies.checked = Boolean(n.allowComments);

  const save = el('button', {
    class: 'btn', type: 'button',
    onclick: async () => {
      status.replaceChildren();
      save.disabled = true;
      try {
        await api.admin.updateNotice(n.id, {
          title: title.value.trim(),
          body: body.value.trim(),
          scope: scope.value,
          allowComments: replies.checked,
        });
        location.reload();
      } catch (err) {
        showError(status, err);
        save.disabled = false;
      }
    },
  }, 'Save changes');

  const withdraw = el('button', {
    class: 'linkish small', type: 'button',
    onclick: async () => {
      // Asks, because it takes the notice off everybody's board at once. It is
      // reversible by an admin from the archive, and the wording says so rather
      // than implying a deletion this button cannot perform.
      if (!confirm('Withdraw this notice? It leaves the board for everyone and '
                 + 'moves to the committee archive.')) return;
      try {
        await api.admin.updateNotice(n.id, { active: false });
        location.href = '/notices.html';
      } catch (err) {
        showError(status, err);
      }
    },
  }, 'Withdraw');

  const form = el('div', { class: 'stack', hidden: true },
    el('p', { class: 'label' }, 'Title'), title,
    el('p', { class: 'label' }, 'Notice'), body,
    el('p', { class: 'label' }, 'Who can see this'), scope,
    el('label', { class: 'row', style: 'gap:var(--s-2)' }, replies, 'Allow replies'),
    status, save);

  const edit = el('button', {
    class: 'linkish small', type: 'button',
    onclick: () => {
      form.hidden = !form.hidden;
      edit.textContent = form.hidden ? 'Edit' : 'Cancel';
    },
  }, 'Edit');

  return el('div', { class: 'stack', style: 'margin-top:var(--s-3)' },
    el('div', { class: 'row', style: 'gap:var(--s-3)' }, edit, withdraw),
    // The number to quote when something is wrong with this notice — the same
    // id the audit log records at notice.create and the Telegram line carries
    // on publish, so a report, a log row and a message all name one thing.
    //
    // IN HERE, not on the notice, because this block is the role-gated one:
    // the server computes canManage with the function the PATCH route
    // enforces, so a resident's copy of the page never renders it. Not a
    // secret either way — the id is in the URL of every notice anyone opens —
    // simply not something the board should show the people reading it.
    el('p', { class: 'small muted' }, `Notice #${n.id}`),
    form);
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
