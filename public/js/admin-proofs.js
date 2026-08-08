/**
 * The treasurer's review queue — screen 08.
 *
 * Two sections, because most residents pay and never upload anything. That is
 * the normal case, not an edge case: the second list is reconciled straight
 * against the bank statement using the unique paise, with no UTR required.
 */

import { api, ApiError } from './api.js';
import { renderNav } from './nav.js';
import { trackPage } from './track.js';
import { $, el, esc, renderGodBanner, showError, setChildren } from './ui.js';
import { money, periodLabel } from './i18n.js';

const main = $('#main');

trackPage('/admin/proofs');
init();

async function init() {
  try {
    const me = await api.me();
    $('#who').innerHTML = `Admin <span>· ${esc(me.name)}</span>`;
    renderGodBanner(me, { onExit: async () => { await api.god.exit(); location.reload(); } });
    renderNav(me, '/admin/proofs');
    await load();
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) { location.href = '/login'; return; }
    showError(main, err);
  }
}

async function load() {
  const q = await api.admin.proofs();
  render(q);
}

function render(q) {
  setChildren(main,
    el('div', { class: 'sect' },
      el('div', { class: 'stack', style: 'gap:var(--s-1)' },
        el('h2', {}, 'Payment proofs'),
        el('p', { class: 'small muted' },
          `${q.awaiting.length} waiting · ${q.exactMatches.length} match exactly`)),
      el('span', { class: 'spacer' }),
      q.exactMatches.length
        // Exact matches are the bulk of a month; only exceptions need thought.
        ? el('button', {
            class: 'btn btn--sm', type: 'button',
            onclick: async (e) => {
              e.target.disabled = true;
              e.target.textContent = 'Approving…';
              for (const id of q.exactMatches) await api.admin.approveProof(id).catch(() => {});
              await load();
            },
          }, `Approve ${q.exactMatches.length} matching`)
        : null),

    ...(q.awaiting.length
      ? q.awaiting.map(proofRow)
      : [el('p', { class: 'muted', style: 'padding:var(--s-4)' }, 'Nothing waiting for review.')]),

    el('div', { class: 'sect' },
      el('div', { class: 'stack', style: 'gap:var(--s-1)' },
        el('h3', {}, 'Tapped Pay, no screenshot'),
        el('p', { class: 'small muted' },
          'Match the paise against the bank statement. No screenshot or reference needed.'))),

    ...(q.claimedNoProof.length
      ? q.claimedNoProof.map(claimedRow)
      : [el('p', { class: 'muted', style: 'padding:var(--s-4)' }, 'Nobody outstanding.')])
  );
}

function proofRow(p) {
  const mismatch = !p.matches && !p.unreadable;
  return el('div', { class: `qrow ${mismatch ? 'qrow--bad' : ''}` },
    el('img', {
      class: 'qthumb', src: `/api/proof/${p.proofId}/image`, alt: `Screenshot from flat ${p.flat}`,
      loading: 'lazy',
    }),
    el('div', { class: 'qmeta' },
      el('b', {}, `Flat ${p.flat} · ${p.name ?? ''}`),
      el('div', { class: mismatch ? 'bad' : '' },
        p.unreadable
          ? `Billed ${money(p.billed)} · amount not readable`
          : `Claimed ${money(p.claimedAmount)} · Billed ${money(p.billed)}` +
            (mismatch ? ` · short by ${money(Math.max(0, p.billed - p.claimedAmount))}` : '')),
      p.utr ? el('div', {}, `UTR ${p.utr}`) : null),
    el('div', { class: 'qact' },
      el('a', { class: 'btn btn--sm btn--quiet', href: `/api/proof/${p.proofId}/image`, target: '_blank' }, 'Open'),
      el('button', {
        class: 'btn btn--sm', type: 'button',
        onclick: async () => { await api.admin.approveProof(p.proofId); await load(); },
      }, 'Approve'),
      el('button', {
        class: 'btn btn--sm btn--quiet', type: 'button',
        onclick: async () => { await api.admin.rejectProof(p.proofId); await load(); },
      }, 'Reject')));
}

function claimedRow(b) {
  return el('div', { class: 'qrow' },
    el('div', { class: 'qmeta' },
      el('b', {}, `Flat ${b.flat} · ${b.name ?? ''}`),
      el('div', {}, `${periodLabel(b.period)} · ${money(b.billed)}`)),
    el('div', { class: 'qact' },
      el('button', {
        class: 'btn btn--sm', type: 'button',
        onclick: async () => { await api.admin.markPaid(b.billId); await load(); },
      }, 'Mark paid')));
}
