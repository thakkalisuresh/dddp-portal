/**
 * Polls — the resident's half.
 *
 * Design and every decision behind it: docs/POLLS-PLAN.md.
 *
 * Two rules shape this screen more than anything else:
 *
 *   1. NOTHING ABOUT THE COUNT IS RENDERED THAT THE SERVER DID NOT SEND. The
 *      payload simply has no `result` until the viewer may see one, so there is
 *      nothing to hide, blur or conditionally skip. A hidden element is
 *      readable in devtools; an absent one is not.
 *
 *   2. SELECTING IS NOT VOTING. A tap highlights; Submit commits. A mis-tap on
 *      a phone must not become a cast vote, and the confirmation names the
 *      FLAT, because the flat is what voted.
 */

import { api, ApiError } from './api.js';
import { renderNav } from './nav.js';
import { trackPage, trackAction } from './track.js';
import { $, el, esc, renderViewBanner, showError, setChildren } from './ui.js';
import { deadlineLabel, closesIn, stampLabel } from './i18n.js';
// The SAME rules the Worker enforces, not a second copy of them.
import { validatePoll, deliveryWarnings, MAX_OPTIONS } from './poll-rules.js';

const main = $('#main');

/** The option ids tapped but not yet submitted. Never the cast vote. */
let picked = [];
/** True while the committee has the edit form open on this poll. */
let editingPoll = false;
/** True while changing a vote already cast. */
let editing = false;
let current = null;

trackPage('/polls');
init();

async function init() {
  try {
    const me = await api.me();
    $('#who').innerHTML = `Flat ${esc(me.flat)} <span>· ${esc(me.name)}</span>`;
    renderViewBanner(me, { onExit: async () => { await api.god.exit(); location.reload(); } });
    renderNav(me, '/notices');

    const params = new URLSearchParams(location.search);
    const id = params.get('id');
    if (params.get('new')) showComposer(me);
    else if (id) await showPoll(Number(id));
    else await showList();
  } catch (err) {
    showError(main, err);
  }
}

/* ── the list ──────────────────────────────────────────────────────────── */

async function showList() {
  const { polls } = await api.polls();
  if (!polls.length) {
    setChildren(main, el('p', { class: 'muted' }, 'There are no polls right now.'));
    return;
  }
  setChildren(main,
    el('h1', { class: 'screen' }, 'Polls'),
    el('p', { class: 'muted' }, 'One vote per flat. The vote belongs to the owner.'),
    el('div', { class: 'stack' }, ...polls.map(pollRow)));
}

function pollRow(p) {
  // The status line says one of three things and never a count. "Your flat
  // hasn't voted" is about the reader alone — it is the only nudge that can be
  // shown without revealing how many others have.
  const status = p.closed
    ? (p.published ? 'Result published' : 'Voting closed')
    : closesIn(p.closesAt);

  return el('a', { class: 'card', href: `/polls?id=${p.id}` },
    el('div', { class: 'row--between' },
      el('span', { class: 'chip chip--neutral' }, 'Poll'),
      p.closed
        ? null
        : p.voted
          ? el('span', { class: 'chip chip--paid' }, 'Voted')
          : p.canVote
            ? el('span', { class: 'chip chip--awaiting' }, 'Your flat hasn’t voted')
            : null),
    el('h2', { class: 'poll__title' }, p.title),
    el('p', { class: 'small' }, status),
    p.closed ? null : el('p', { class: 'small' }, deadlineLabel(p.closesAt)));
}

/* ── one poll ──────────────────────────────────────────────────────────── */

async function showPoll(id) {
  current = await api.poll(id);
  picked = [];
  editing = false;
  // Not reset by draw(), so without this line opening a second poll would land
  // in the edit form left open on the first one.
  if (current?.id !== id) editingPoll = false;
  draw();
}

function draw() {
  const p = current;
  // Voting mode until a vote is committed, and again while it is being changed.
  const voted = p.myVotes.length > 0;
  const voting = p.canVote && (!voted || editing);
  if (editing && !picked.length) picked = [...p.myVotes];

  setChildren(main,
    el('a', { class: 'linkish', href: '/polls' }, '‹ All polls'),
    el('p', { class: 'label' }, p.closed ? 'Voting closed' : closesIn(p.closesAt)),
    el('h1', { class: 'screen' }, p.title),
    el('p', { class: 'small' },
      `${p.closed ? 'Closed' : 'Closes'} ${deadlineLabel(p.closesAt)}`),
    el('p', { class: 'notice__body' }, p.body),
    noticeCard(p),

    // A tenant on a poll the committee chose to show them. Said plainly rather
    // than by greying a control with no explanation beside it.
    !p.canVote && !p.closed
      ? note('You can follow this, but the vote is your flat’s owner’s.')
      : null,

    el('div', { class: 'stack' }, ...p.options.map((o) => option(o, { voting, p }))),

    voting ? submitBar(p, voted) : null,
    !voting && voted && !p.closed ? castNote(p) : null,
    !p.closed && !p.result ? note('Results are not shown while voting is open.') : null,

    // Rendered only when the server sent one. There is no `else` here on
    // purpose — see the header.
    p.result ? results(p) : null,
    p.closed && !p.result ? note('The committee has not published this result.') : null,

    p.canManage ? manageBar(p) : null);
}

function option(o, { voting, p }) {
  const chosen = voting ? picked.includes(o.id) : p.myVotes.includes(o.id);
  const attrs = {
    class: 'option', 'aria-pressed': String(chosen),
    ...(voting ? {} : { 'aria-disabled': 'true' }),
  };
  const body = el('span', { class: 'option__text' },
    el('span', { class: 'option__title' }, o.label),
    !voting && p.myVotes.includes(o.id)
      ? el('span', { class: 'option__sub' }, el('b', {}, 'Your flat voted for this.'))
      : null);

  if (!voting) return el('div', attrs, el('span', { class: 'option__dot' }), body);

  const btn = el('button', { type: 'button', ...attrs },
    el('span', { class: 'option__dot' }), body);
  btn.addEventListener('click', () => {
    if (p.multi) {
      picked = picked.includes(o.id)
        ? picked.filter((x) => x !== o.id)
        // Refuse the pick that would exceed the ceiling rather than silently
        // dropping an earlier one — the server would refuse it too.
        : picked.length >= p.maxChoices ? picked : [...picked, o.id];
    } else {
      picked = [o.id];
    }
    draw();
  });
  return btn;
}

function submitBar(p, voted) {
  const remaining = p.multi ? p.maxChoices - picked.length : 0;
  const submit = el('button', { class: 'btn btn--block', type: 'button' },
    voted ? 'Change my flat’s vote' : 'Submit my flat’s vote');
  submit.disabled = !picked.length;

  submit.addEventListener('click', async () => {
    submit.disabled = true;
    try {
      await api.vote(p.id, picked);
      trackAction('poll.vote');
      await showPoll(p.id);
    } catch (err) {
      submit.disabled = false;
      showError(main, err instanceof ApiError ? err : new Error('That vote could not be recorded.'));
    }
  });

  const cancel = editing
    ? el('button', { class: 'btn btn--ghost btn--block', type: 'button' },
        'Keep the vote I already cast')
    : null;
  cancel?.addEventListener('click', () => { editing = false; picked = []; draw(); });

  return el('div', { class: 'stack' },
    submit,
    !picked.length ? el('p', { class: 'small' }, 'Choose an option first.') : null,
    p.multi && picked.length
      ? el('p', { class: 'small' },
          remaining > 0
            ? `You may pick ${remaining} more.`
            : `That is the most this poll allows.`)
      : null,
    cancel);
}

function castNote(p) {
  const change = el('button', { class: 'btn btn--quiet btn--block', type: 'button' },
    'Change this vote');
  change.addEventListener('click', () => { editing = true; picked = [...p.myVotes]; draw(); });
  return el('div', { class: 'stack' },
    note('Your flat’s vote is recorded. You can change it until voting closes; '
      + 'whoever votes last for the flat is the vote that counts.', 'note--good'),
    change);
}

function results(p) {
  const total = p.result.flats;
  const top = Math.max(0, ...p.result.options.map((o) => o.votes));
  return el('div', { class: 'stack' },
    el('hr', { class: 'rule' }),
    el('p', { class: 'small' },
      `${total} of ${p.result.flatsTotal} flat${p.result.flatsTotal === 1 ? '' : 's'} voted`),
    ...p.result.options.map((o) => el('div', { class: 'result' },
      el('div', { class: 'result__head' },
        el('span', { class: 'result__name' }, o.label),
        el('span', { class: 'result__n' }, `${o.votes} ${o.votes === 1 ? 'flat' : 'flats'}`)),
      el('div', { class: 'result__track' },
        el('div', {
          class: `result__bar ${o.votes === top && top > 0 ? 'is-top' : ''}`,
          style: `width:${total ? Math.round((o.votes / total) * 100) : 0}%`,
        })))),
    // Reported, never resolved. These polls are advisory; inventing a
    // tie-break would be the portal claiming an authority nobody gave it.
    p.result.tied ? note('This poll is tied. The committee will decide from here.') : null);
}


/* ── putting a question to the building ────────────────────────────────── */

/**
 * IST has no daylight saving, so this is arithmetic rather than a timezone
 * library — the same reasoning as functions/lib/time.js.
 */
const IST_OFFSET_MS = 5.5 * 3600_000;

/**
 * The datetime-local field, read as the BUILDING'S clock.
 *
 * The control hands back a bare wall-clock string with no zone and the browser
 * would read it in its own. Right by accident for a committee member in
 * Thrissur; silently wrong for one typing from Dubai, who would set a deadline
 * in the wrong country. The building's clock is the only one that means
 * anything for when a poll shuts.
 */
function istFieldToIso(value) {
  if (!value) return null;
  const ms = Date.parse(`${value}:00.000Z`) - IST_OFFSET_MS;
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

const draft = {
  title: '', body: '',
  // {label}. An option is an option — the poll's description carries whatever
  // context the choice needs, and a second line under every one of them was a
  // form to fill in twice for a question that reads fine without it.
  options: [{ label: '' }, { label: '' }],
  multi: false, maxChoices: 2, closesAt: '', showTenants: false,
};

/**
 * One option: what it is, and the note underneath.
 *
 * Shared by the composer and the edit form, so the two cannot drift into
 * offering different fields for the same row.
 */
function optionRow(list, i, { onChange, onRemove }) {
  const o = list[i];
  const label = el('input', {
    class: 'input', value: o.label ?? '', placeholder: `Option ${i + 1}`, style: 'flex:1',
  });
  label.addEventListener('input', () => { o.label = label.value; onChange(); });

  const remove = list.length > 2
    ? el('button', {
        class: 'btn btn--quiet btn--sm', type: 'button',
        'aria-label': `Remove option ${i + 1}`, onclick: () => onRemove(i),
      }, 'Remove')
    : null;

  return el('div', { class: 'row row--between', style: 'gap:var(--s-2);align-items:center' },
    label, remove);
}

/** The draft's options as the API wants them: trimmed, and empties dropped. */
const packOptions = (list) => list
  .filter((o) => (o.label ?? '').trim())
  .map((o) => ({ label: o.label.trim() }));

function showComposer(me) {
  const feedback = el('div', {});
  const noticeNote = el('p', { class: 'small' });
  const noticePicker = el('select', { class: 'input' },
    el('option', { value: '' }, 'No — this poll stands on its own'));
  noticePicker.addEventListener('change', () => {
    draft.noticeId = noticePicker.value;
    check();
  });

  // Filled from the board the committee already reads. A notice that another
  // poll has claimed is offered but labelled, so the refusal is legible before
  // the server gives it — one notice, one poll.
  api.notices().then(({ notices }) => {
    for (const n of notices) {
      noticePicker.append(el('option', { value: String(n.id) },
        `${n.title}${n.scope === 'owners' ? ' (owners only)' : ''}`
        + `${n.pollId ? ' — already has a poll' : ''}`));
    }
  }).catch(() => {});
  const closesNote = el('p', { class: 'small' });
  const post = el('button', { class: 'btn btn--block', type: 'button' }, 'Post the poll');

  const field = (label, key, tag = 'input', extra = {}) => {
    const input = el(tag, { class: 'input', value: draft[key], ...extra });
    if (tag === 'textarea') input.value = draft[key];
    input.addEventListener('input', () => { draft[key] = input.value; check(); });
    return el('label', { class: 'stack', style: 'gap:var(--s-2)' },
      el('span', { class: 'label' }, label), input);
  };

  const optionsBox = el('div', { class: 'stack', style: 'gap:var(--s-2)' });
  const typeBox = el('div', { class: 'stack', style: 'gap:var(--s-2)' });
  const ruleLine = el('p', { class: 'small' });

  function drawOptions() {
    setChildren(optionsBox,
      el('span', { class: 'label' }, 'Options'),
      ...draft.options.map((_, i) => optionRow(draft.options, i, {
        onChange: check,
        onRemove: (n) => { draft.options.splice(n, 1); drawOptions(); check(); },
      })),
      draft.options.length < MAX_OPTIONS
        ? el('button', {
            class: 'btn btn--ghost btn--sm', type: 'button',
            onclick: () => {
              draft.options.push({ label: '' });
              drawOptions();
              check();
              // Focused so the count in the rule line moves as they type,
              // rather than after they go hunting for the new box.
              optionsBox.querySelectorAll('input')[draft.options.length - 1]?.focus();
            },
          }, 'Add an option')
        : el('p', { class: 'small' }, `${MAX_OPTIONS} options is the maximum.`));
  }

  function drawType() {
    const pick = (multi, label) => {
      const b = el('button', {
        class: 'filter', type: 'button', 'aria-pressed': String(draft.multi === multi),
        onclick: () => { draft.multi = multi; drawType(); check(); },
      }, label);
      return b;
    };
    const cap = el('input', {
      class: 'input', type: 'number', min: '2', max: String(MAX_OPTIONS - 1),
      value: String(draft.maxChoices), style: 'width:90px',
    });
    cap.addEventListener('input', () => { draft.maxChoices = cap.value; check(); });

    setChildren(typeBox,
      el('span', { class: 'label' }, 'How can a flat answer?'),
      el('div', { class: 'filters' },
        pick(false, 'Pick one option'), pick(true, 'Pick several options')),
      draft.multi
        ? el('label', { class: 'row row--between', style: 'gap:var(--s-3);align-items:center' },
            el('span', { class: 'small' }, 'At most how many?'), cap)
        : null,
      ruleLine);
  }

  /** The rule in the words the voter will meet it in, not the setting's name. */
  function drawRule() {
    const filled = draft.options.filter((o) => (o.label ?? '').trim()).length;
    const blanks = draft.options.length - filled;
    const of = filled ? ` of the ${filled} option${filled === 1 ? '' : 's'}` : '';
    const cap = Number(draft.maxChoices);
    let text = !draft.multi
      ? `Each flat chooses one${of}.`
      : Number.isInteger(cap) && cap >= 1
        ? `Each flat may tick up to ${cap}${of}.`
        : `Each flat may tick more than one${of}.`;
    if (blanks) {
      text += ` ${blanks} empty ${blanks === 1 ? 'box is' : 'boxes are'} not counted.`;
    }
    ruleLine.textContent = text;
  }

  function check() {
    drawRule();

    // Said as it is chosen rather than discovered later. The person creating
    // the poll is the one who would never see the mismatch, because they can
    // open both halves.
    const opt = noticePicker.selectedOptions[0];
    const chosen = draft.noticeId ? opt?.textContent.trim() ?? '' : '';
    noticeNote.textContent = !draft.noticeId
      ? 'Residents will see the question and nothing behind it.'
      : /owners only/.test(chosen) && draft.showTenants
        ? 'That notice is owners-only, but this poll is set to show tenants. '
          + 'They will see the poll without the notice.'
        : 'The poll will link to that notice, and the notice will link back.';
    const closesAt = istFieldToIso(draft.closesAt);
    const verdict = validatePoll({
      title: draft.title, body: draft.body, multi: draft.multi,
      maxChoices: draft.multi ? Number(draft.maxChoices) : null,
      options: packOptions(draft.options),
      closesAt, now: new Date().toISOString(),
    });

    closesNote.textContent = closesAt
      ? `${closesIn(closesAt)} · ${deadlineLabel(closesAt)}`
      : '';

    const warnings = verdict.ok && closesAt
      ? deliveryWarnings({
          createdAt: new Date().toISOString(), closesAt, recipients: me.mailableOwners ?? 0,
        })
      : [];

    setChildren(feedback,
      !verdict.ok ? note(verdict.message, 'note--warn') : null,
      ...warnings.map((w) => note(w)),
      verdict.ok && !warnings.length ? note('Ready to post.', 'note--good') : null);
    post.disabled = !verdict.ok;
  }

  post.addEventListener('click', async () => {
    post.disabled = true;
    try {
      const { id } = await api.admin.addPoll({
        title: draft.title.trim(), body: draft.body.trim(),
        multi: draft.multi,
        maxChoices: draft.multi ? Number(draft.maxChoices) : null,
        showTenants: draft.showTenants,
        closesAt: istFieldToIso(draft.closesAt),
        noticeId: draft.noticeId ? Number(draft.noticeId) : null,
        options: packOptions(draft.options),
      });
      trackAction('poll.create');
      location.href = `/polls?id=${id}`;
    } catch (err) {
      post.disabled = false;
      showError(feedback, err);
    }
  });

  const closes = el('input', { class: 'input', type: 'datetime-local', value: draft.closesAt });
  closes.addEventListener('input', () => { draft.closesAt = closes.value; check(); });

  const tenants = el('input', { type: 'checkbox' });
  tenants.addEventListener('change', () => { draft.showTenants = tenants.checked; check(); });

  setChildren(main,
    el('a', { class: 'linkish', href: '/notices' }, '‹ Notices'),
    el('h1', { class: 'screen' }, 'New poll'),
    el('p', { class: 'muted' }, 'One vote per flat. Owners vote; you choose who may watch.'),
    field('The question', 'title', 'input',
      { placeholder: 'Terrace waterproofing — which quote?' }),
    field('What it is about', 'body', 'textarea', { rows: '3' }),
    optionsBox,
    typeBox,
    el('div', { class: 'stack', style: 'gap:var(--s-2)' },
      el('span', { class: 'label' }, 'Is this about a notice?'),
      noticePicker, noticeNote),
    el('label', { class: 'stack', style: 'gap:var(--s-2)' },
      el('span', { class: 'label' }, 'Closes — the building’s time (IST)'),
      closes, closesNote),
    el('label', { class: 'checkline' }, tenants,
      el('span', {},
        el('b', {}, 'Let tenants read this poll'),
        el('span', { class: 'small', style: 'display:block' },
          'They still cannot vote. Leave it off for anything with money or a vote attached.'))),
    feedback,
    post,
    el('p', { class: 'small' },
      'Owners are emailed when it opens, halfway through if their flat has not '
      + 'voted, and again if you publish the result.'));

  drawOptions();
  drawType();
  check();
}


/* ── the committee's controls ──────────────────────────────────────────── */

/**
 * Close, publish, and — for the superadmin alone — the ballot.
 *
 * Rendered from `canManage`, which the SERVER decided, so a control never
 * appears for somebody the server would then refuse. An admin manages any
 * poll; a committee member manages the ones they posted.
 *
 * There is no Reopen. Revealing the count to the committee and then accepting
 * more votes is the one action that would make every result arguable
 * afterwards, and it is absent from the API as well as from here.
 */
function manageBar(p) {
  const act = (label, run, cls = 'btn btn--quiet btn--block') => {
    const b = el('button', { class: cls, type: 'button' }, label);
    b.addEventListener('click', async () => {
      b.disabled = true;
      try { await run(); await showPoll(p.id); }
      catch (err) { b.disabled = false; showError(main, err); }
    });
    return b;
  };

  return el('div', { class: 'stack' },
    el('hr', { class: 'rule' }),
    el('p', { class: 'label' }, 'Committee'),

    // Editing only while the poll is open. A closed poll is a record, and the
    // server refuses the PATCH — so offering the form here would be offering a
    // control that fails, which is worse than not offering one.
    !p.closed
      ? (editingPoll ? editForm(p) : act('Edit this poll', async () => { editingPoll = true; }))
      : null,

    !p.closed
      ? act('Close voting now', () => api.admin.closePoll(p.id))
      : p.published
        ? el('div', { class: 'stack' },
            note('Published. Every resident who could vote can see the count.', 'note--good'),
            act('Unpublish the result', () => api.admin.unpublishPoll(p.id)))
        : act('Publish this result to residents',
              () => api.admin.publishPoll(p.id), 'btn btn--block'),

    // Superadmin only. Not gated on a role read from /api/me but on the
    // server's own answer: the route is 403 for everybody else, so a button
    // rendered in error would fail loudly rather than leak anything.
    p.closed && p.canOpenBallot ? ballotPanel(p) : null);
}


/**
 * Editing an open poll.
 *
 * WHAT IS ON THIS FORM IS WHAT THE SERVER WILL ACCEPT. Title, description and
 * tenant visibility always; the options and the answer shape only while nothing
 * has voted.
 *
 * `optionsFrozen` is a BOOLEAN from the server and not a vote count, because
 * the count is the turnout and no admin may see it. The form is told it may not
 * edit; it is not told how many made that true.
 *
 * The closing time is here too. Bringing it forward is a real committee act and
 * they can already close early; pushing it back is the useful direction, and
 * the server moves the midpoint reminder with it unless that letter has gone.
 */
function editForm(p) {
  // A boolean from the server, deliberately not a count — see getPoll.
  const frozen = Boolean(p.optionsFrozen);
  const patch = {};

  // A working copy. Edits must not touch what is on screen until Save, or
  // Cancel would leave the reader looking at changes the server never took.
  const opts = p.options.map((o) => ({ label: o.label }));
  const optionsBox = el('div', { class: 'stack', style: 'gap:var(--s-2)' });
  const drawOpts = () => setChildren(optionsBox,
    el('span', { class: 'label' }, 'Options'),
    ...opts.map((_, i) => optionRow(opts, i, {
      onChange: () => { patch.options = packOptions(opts); },
      onRemove: (n) => { opts.splice(n, 1); patch.options = packOptions(opts); drawOpts(); },
    })),
    opts.length < MAX_OPTIONS
      ? el('button', {
          class: 'btn btn--ghost btn--sm', type: 'button',
          onclick: () => { opts.push({ label: '' }); drawOpts(); },
        }, 'Add an option')
      : null);
  if (!frozen) drawOpts();

  const line = (label, key, value, extra = {}) => {
    const input = el(extra.tag === 'textarea' ? 'textarea' : 'input',
      { class: 'input', ...(extra.attrs ?? {}) });
    input.value = value ?? '';
    input.addEventListener('input', () => { patch[key] = input.value; });
    return el('label', { class: 'stack', style: 'gap:var(--s-2)' },
      el('span', { class: 'label' }, label), input);
  };

  const tenants = el('input', { type: 'checkbox' });
  tenants.checked = Boolean(p.showTenants);
  tenants.addEventListener('change', () => { patch.showTenants = tenants.checked; });

  const save = el('button', { class: 'btn btn--block', type: 'button' }, 'Save changes');
  const cancel = el('button', { class: 'btn btn--ghost btn--block', type: 'button' }, 'Cancel');
  const errors = el('div', {});

  save.addEventListener('click', async () => {
    save.disabled = true;
    try {
      // istFieldToIso, so a closing time typed here means the same thing it
      // means on the composer: the building's clock, whoever is typing.
      if (patch.closesAt !== undefined) patch.closesAt = istFieldToIso(patch.closesAt);
      await api.admin.updatePoll(p.id, patch);
      editingPoll = false;
      await showPoll(p.id);
    } catch (err) {
      save.disabled = false;
      setChildren(errors, note(err?.message ?? 'That change could not be saved.', 'note--warn'));
    }
  });
  cancel.addEventListener('click', () => { editingPoll = false; draw(); });

  return el('div', { class: 'stack' },
    line('The question', 'title', p.title),
    line('What it is about', 'body', p.body, { tag: 'textarea', attrs: { rows: '3' } }),
    line('Closes — the building’s time (IST)', 'closesAt', isoToIstField(p.closesAt),
      { attrs: { type: 'datetime-local' } }),
    el('label', { class: 'checkline' }, tenants,
      el('span', {}, el('b', {}, 'Let tenants read this poll'))),
    frozen ? note('The options froze when the first vote was cast. The question, '
      + 'the description and the closing time can still change.') : optionsBox,
    errors, save, cancel);
}

/** The inverse of istFieldToIso: an instant, as the IST wall clock. */
function isoToIstField(iso) {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  return new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 16);
}

/**
 * The ballot, behind a deliberate press.
 *
 * Never fetched on render. Opening it is written to the activity log, and a
 * record that fills up every time somebody views a closed poll is a record
 * nobody can read. It has to be an act.
 */
function ballotPanel(p) {
  const wrap = el('div', { class: 'stack' });
  const open = el('button', { class: 'btn btn--quiet btn--block', type: 'button' },
    'Open the ballot — records who voted for what');

  open.addEventListener('click', async () => {
    open.disabled = true;
    try {
      const { ballot } = await api.admin.pollBallot(p.id);
      setChildren(wrap,
        note('Opening the ballot is recorded. This exists for a disputed count, '
          + 'not for curiosity.', 'note--warn'),
        el('table', { class: 'table' },
          el('thead', {}, el('tr', {},
            el('th', {}, 'Flat'), el('th', {}, 'Voted for'), el('th', {}, 'When'))),
          el('tbody', {}, ...ballot.map((b) => el('tr', {},
            // The flat and the person both: the flat is what voted, and which
            // of its owners cast it is what a dispute actually asks.
            el('td', {}, b.flat, el('div', { class: 'small' }, b.cast_by)),
            el('td', {}, b.choice),
            el('td', { class: 'small' }, stampLabel(b.cast_at)))))));
    } catch (err) {
      // A 403 here is the ordinary case for an admin who is not the
      // superadmin, and it is not worth a red banner.
      setChildren(wrap, note('The ballot cannot be opened from this account.'));
    }
  });

  setChildren(wrap, open);
  return wrap;
}


/**
 * The notice this poll is about.
 *
 * A card rather than a bare link: a voter has to decide whether what is behind
 * it is worth leaving the vote for, and "see the notice" tells them nothing
 * while the title and the file count do.
 *
 * Absent entirely when the server sent no `notice` — which covers both a poll
 * that stands alone and a poll whose notice this reader may not open. The
 * server decides which; the screen cannot tell the two apart, and should not.
 */
function noticeCard(p) {
  if (!p.notice) return null;
  const files = p.notice.attachmentCount;
  return el('a', { class: 'card card--linked', href: `/notices?id=${p.notice.id}` },
    el('p', { class: 'small muted' }, 'The notice behind this poll'),
    el('b', {}, p.notice.title),
    files
      ? el('p', { class: 'small muted' }, `${files} file${files > 1 ? 's' : ''} attached`)
      : null);
}

const note = (text, extra = '') =>
  el('div', { class: `note ${extra}` }, el('p', {}, text));
