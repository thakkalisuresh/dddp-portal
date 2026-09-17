/**
 * Who is signed in — god mode only.
 *
 * Every person holding a live session, which of their devices has the portal
 * open right now, today's logins, and a way to sign any of it out. The states
 * come from functions/lib/presence.js; this only draws them.
 *
 * Loads once and on Refresh, never on a timer: a panel left open all day
 * should not read the sessions table every minute.
 */

import { api } from './api.js';
import { el, setChildren, showError, askFirst } from './ui.js';

const STATE = {
  online: { label: 'online', chip: 'chip--paid' },
  away:   { label: 'away', chip: 'chip--awaiting' },
  idle:   { label: 'signed in', chip: 'chip--neutral' },
};

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** "2026-09-16 21:40:12 IST" → "16 Sep 21:40". The year is noise on a live list. */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function short(ist) {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})/.exec(ist ?? '');
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[4]}:${m[5]}` : (ist ?? '—');
}

let filter = 'open';   // open | all
let query = '';
let latest = null;

export function renderSessions() {
  const box = el('section', { class: 'panel stack', id: 'who-panel' },
    el('p', { class: 'muted small' }, 'Checking who is signed in…'));
  load(box);
  return box;
}

async function load(box) {
  try {
    latest = await api.god.sessions();
    paint(box);
  } catch (err) {
    showError(box, err);
  }
}

function paint(box) {
  const s = latest;
  const visible = s.people.filter((p) => {
    if (filter === 'open' && p.state === 'idle') return false;
    if (!query) return true;
    return `${p.flat} ${p.name}`.toLowerCase().includes(query.toLowerCase());
  });

  const search = el('input', {
    class: 'input', placeholder: 'Flat or name', value: query, style: 'max-width:200px',
    'aria-label': 'Search signed-in people',
    oninput: (e) => {
      query = e.target.value;
      paint(box);
      box.querySelector('#who-search')?.focus();
    },
    id: 'who-search',
  });

  const tab = (key, text) => el('button', {
    class: `btn btn--sm ${filter === key ? '' : 'btn--quiet'}`, type: 'button',
    'aria-pressed': String(filter === key),
    onclick: () => { filter = key; paint(box); },
  }, text);

  setChildren(box,
    el('div', { class: 'row row--between', style: 'flex-wrap:wrap;gap:var(--s-3)' },
      el('div', {},
        el('p', { class: 'label' }, "Who's signed in"),
        el('p', { class: 'small muted' }, `all times IST · generated ${s.generatedAt}`)),
      el('button', { class: 'btn btn--sm btn--quiet', type: 'button', onclick: () => load(box) },
        'Refresh')),

    el('div', { class: 'tiles' },
      tile('Online now', s.online, 'portal open on screen', s.online ? 'live' : null),
      tile('Away', s.away, 'open in the background'),
      tile('Signed in', s.signedIn, `${plural(s.devices, 'device')} still logged in`),
      tile('Logins today', s.logins.count, `by ${plural(s.logins.people, 'person', 'people')}`)),

    el('div', { class: 'row', style: 'flex-wrap:wrap;gap:var(--s-2)' },
      tab('open', `Online or away (${s.online + s.away})`),
      tab('all', `Everyone signed in (${s.signedIn})`),
      search),

    el('div', {},
      ...(visible.length
        ? visible.map((p) => personRow(p, box))
        : [el('p', { class: 'muted small', style: 'padding:var(--s-3) 0' },
            filter === 'open' ? 'Nobody has the portal open right now.' : 'Nobody matches.')])),

    loginsList(s.logins));
}

function tile(label, value, note, tone) {
  return el('div', { class: `tile${tone ? ` tile--${tone}` : ''}` },
    el('span', { class: 'label' }, label),
    el('strong', { class: 'tile__num' }, String(value)),
    el('span', { class: 'tile__note' }, note));
}

function chip(state) {
  const s = STATE[state] ?? STATE.idle;
  return el('span', { class: `chip ${s.chip}` }, s.label);
}

function personRow(p, box) {
  const slot = el('div');
  const others = p.sessions.filter((d) => !d.current);
  const hasCurrent = p.sessions.length !== others.length;
  const role = p.role !== 'owner' ? p.role : p.relationship;

  const everywhere = others.length
    ? el('button', {
        class: 'btn btn--sm btn--quiet', type: 'button',
        onclick: async () => {
          const what = hasCurrent
            ? `Sign yourself out of ${plural(others.length, 'other device')}?`
            : `Sign out ${p.flat} · ${p.name} on ${others.length === 1 ? 'their device' : `all ${others.length} devices`}? `
              + 'They will need their password to get back in.';
          if (!await askFirst(slot, what, 'Yes, sign out')) return;
          await signOut(slot, box, p.id, null);
        },
      }, hasCurrent ? 'Sign out other devices' : 'Sign out everywhere')
    : null;

  return el('div', { class: 'who' },
    el('div', { class: 'row row--between', style: 'flex-wrap:wrap;gap:var(--s-2)' },
      el('div', { class: 'row', style: 'flex-wrap:wrap;gap:var(--s-2)' },
        el('strong', { class: 'who__name' }, `${p.flat} · ${p.name}`),
        el('span', { class: 'small muted' }, role),
        chip(p.state),
        el('span', { class: 'small muted' },
          `${plural(p.sessions.length, 'device')}`
          + (p.state === 'idle' && p.lastSeenAt ? ` · last seen ${short(p.lastSeenAt)}` : ''))),
      everywhere),
    ...p.sessions.map((d) => deviceRow(p, d, slot, box)),
    slot);
}

function deviceRow(p, d, slot, box) {
  const tags = [
    d.current ? el('span', { class: 'chip chip--neutral' }, 'this browser') : null,
    d.viewing ? el('span', { class: 'chip chip--awaiting' },
      `viewing ${d.viewing}${d.mode === 'impersonate_rw' ? '' : ' read-only'}`) : null,
    d.sharedDevice ? el('span', { class: 'chip chip--neutral' }, 'shared device') : null,
  ];
  const ends = d.sharedDevice ? 'ends when the browser closes, or ' : 'expires ';

  return el('div', { class: 'who__device' },
    el('div', {},
      el('div', { class: 'row', style: 'flex-wrap:wrap;gap:var(--s-2)' },
        el('span', { class: 'small' }, d.device ?? 'device not recorded'),
        chip(d.state), ...tags),
      el('div', { class: 'tile__note' },
        [d.lastSeenAt ? `last seen ${short(d.lastSeenAt)}` : null,
         `signed in ${short(d.signedInAt)}`,
         `${ends}${short(d.expiresAt)}`].filter(Boolean).join(' · '))),
    d.current
      ? el('span', { class: 'tile__note' }, 'use Sign out')
      : el('button', {
          class: 'btn btn--sm btn--quiet', type: 'button',
          onclick: async () => {
            if (!await askFirst(slot,
              `Sign ${p.flat} · ${p.name} out of ${d.device ?? 'this device'}?`, 'Yes, sign out')) return;
            await signOut(slot, box, p.id, d.id);
          },
        }, 'Sign out'));
}

async function signOut(slot, box, ownerId, sessionId) {
  try {
    const r = await api.god.signOut(ownerId, sessionId);
    await load(box);
    // The row was redrawn; say it where the panel starts instead.
    box.prepend(el('div', { class: 'note note--good', role: 'status' },
      `Signed out of ${plural(r.signedOut, 'device')}.`));
  } catch (err) {
    showError(slot, err);
  }
}

function loginsList(l) {
  const rows = l.rows;
  return el('details', { class: 'panel-sub' },
    el('summary', {}, `Logins today · ${l.count}`),
    rows.length
      ? el('div', {}, ...rows.map((r) => el('div', { class: 'who__login' },
          el('span', { class: 'tile__note' }, r.at.slice(11, 16)),
          el('strong', {}, r.flat),
          el('span', { class: 'small' }, `${r.name}${r.device ? ` · ${r.device}` : ''}`))))
      : el('p', { class: 'muted small' }, 'Nobody has logged in yet today.'));
}
