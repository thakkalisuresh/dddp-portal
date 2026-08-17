/**
 * The treasurer's review queue — screen 08.
 *
 * Two sections, because most residents pay and never upload anything. That is
 * the normal case, not an edge case: the second list is reconciled straight
 * against the bank statement by amount and payer name, with no UTR to go on.
 */

import { api, ApiError } from './api.js';
import { renderNav } from './nav.js';
import { trackPage } from './track.js';
import { $, el, esc, renderViewBanner, showError, setChildren, statusChip, foldedSection } from './ui.js';
import { money, periodLabel } from './i18n.js';

const main = $('#main');

/**
 * Show a screenshot over the page.
 *
 * The old "Open" link was target="_blank" onto the raw image, which leaves the
 * treasurer on a bare picture in a new tab with nothing to press to get back —
 * on a phone that reads as a dead end. Reviewing a proof means looking at the
 * image and then acting on the row, so the image belongs over the queue rather
 * than away from it.
 *
 * Closes on Escape, on the backdrop, and on the button: three ways out, because
 * the complaint was that there were none.
 */
function lightbox(src, caption) {
  const close = () => {
    document.removeEventListener('keydown', onKey);
    overlay.remove();
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };

  const overlay = el('div', {
    class: 'lightbox',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-label': caption || 'Payment screenshot',
    style: 'position:fixed;inset:0;z-index:100;display:flex;flex-direction:column;'
         + 'align-items:center;justify-content:center;gap:var(--s-3);padding:var(--s-4);'
         + 'background:rgba(0,0,0,.82);overflow:auto',
    // Only the backdrop itself, so a click on the image does not close it.
    onclick: (e) => { if (e.target === overlay) close(); },
  },
    el('img', {
      src,
      alt: caption || 'Payment screenshot',
      style: 'max-width:min(100%,900px);max-height:78vh;object-fit:contain;'
           + 'border-radius:var(--radius);background:#fff',
    }),
    el('div', { style: 'display:flex;gap:var(--s-2);align-items:center;flex-wrap:wrap;justify-content:center' },
      caption ? el('span', { style: 'color:#fff;font-size:var(--text-sm)' }, caption) : null,
      el('button', { class: 'btn btn--sm', type: 'button', onclick: close }, 'Close'),
      el('a', { class: 'btn btn--sm btn--quiet', href: src, target: '_blank', rel: 'noopener' }, 'Open in new tab')));

  document.addEventListener('keydown', onKey);
  document.body.append(overlay);
  overlay.querySelector('button')?.focus();
}

trackPage('/admin/proofs');
init();

async function init() {
  try {
    const me = await api.me();
    $('#who').innerHTML = `Admin <span>· ${esc(me.name)}</span>`;
    renderViewBanner(me, { onExit: async () => { await api.god.exit(); location.reload(); } });
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
          'Match the amount and the payer name against the bank statement.'))),

    ...(q.claimedNoProof.length
      ? q.claimedNoProof.map(claimedRow)
      : [el('p', { class: 'muted', style: 'padding:var(--s-4)' }, 'Nobody outstanding.')]),

    el('div', { class: 'sect' },
      el('div', { class: 'stack', style: 'gap:var(--s-1)' },
        el('h3', {}, 'Already decided'),
        el('p', { class: 'small muted' },
          'The last 50 approvals and rejections, so a decision can be checked afterwards.'))),

    ...((q.decided ?? []).length
      ? q.decided.map(decidedRow)
      : [el('p', { class: 'muted', style: 'padding:var(--s-4)' }, 'Nothing decided yet.')]),

    // Moved off the admin console's Archive tab, which was one bin holding two
    // unrelated things — withdrawn notices and stored proof images. Nobody goes
    // looking for archived things in general; they go looking for THIS flat's
    // screenshot, and this is the screen they are already on when they do.
    foldedSection('Stored images', null, proofArchive)
  );
}

/**
 * Every proof image still in the bucket, and the ones whose image is gone.
 *
 * The distinction is the point: an image is deleted after 24 months but the
 * reference and the fingerprint are kept, because deleting THOSE would destroy
 * the duplicate check — the same screenshot could then be used again on a
 * different bill, which is the one thing the guard exists to stop.
 */
async function proofArchive() {
  const { proofs, stored } = await api.admin.proofArchive();

  return el('div', { class: 'stack', style: 'padding:var(--s-4)' },
    el('p', { class: 'small muted' },
      `${stored} stored. Images are deleted after 24 months; the reference and image `
      + 'fingerprint are kept, because deleting those would destroy the duplicate check.'),
    el('div', { class: 'thumbs' },
      ...proofs.map((p) =>
        el('div', { class: 'pcard' },
          p.deleted_at
            ? el('div', { class: 'gone' }, 'Image deleted')
            : el('img', { src: `/api/proof/${p.id}/image`, alt: `Proof from ${p.flat}`, loading: 'lazy' }),
          el('div', { class: 'b' },
            `${p.flat} · ${periodLabel(p.period)}`,
            el('div', { class: 'muted' },
              `${p.parsed_amount != null ? money(p.parsed_amount) : 'unread'} · ${p.status}`),
            p.deleted_at
              ? el('div', { class: 'muted' }, 'reference kept')
              : el('button', {
                  class: 'linkish', type: 'button', style: 'margin-top:var(--s-1)',
                  onclick: async () => {
                    if (!confirm(`Delete the image for ${p.flat}? The reference is kept.`)) return;
                    await api.admin.deleteProof(p.id);
                    await load();
                  },
                }, 'Delete image'))))));
}

function decidedRow(p) {
  const src = `/api/proof/${p.proofId}/image`;
  const caption = `Flat ${p.flat} · ${periodLabel(p.period)}`;
  const when = p.reviewedAt ? new Date(p.reviewedAt).toLocaleDateString() : '';
  return el('div', { class: 'qrow' },
    el('img', {
      class: 'qthumb', src, alt: `Screenshot from flat ${p.flat}`, loading: 'lazy',
      style: 'cursor:zoom-in', title: 'Click to enlarge',
      onclick: () => lightbox(src, caption),
    }),
    el('div', { class: 'qmeta' },
      el('b', {}, `Flat ${p.flat} · ${p.name ?? ''}`),
      el('div', {},
        p.claimedAmount == null
          ? `Billed ${money(p.billed)} · amount not readable`
          : `Claimed ${money(p.claimedAmount)} · Billed ${money(p.billed)}`),
      // Who decided it, not just what was decided: a rejection with no name
      // attached is not a trail anyone can follow back.
      el('div', { class: 'small muted' },
        [p.status === 'approved' ? 'Approved' : 'Rejected',
         p.reviewer ? `by ${p.reviewer}` : null,
         when || null].filter(Boolean).join(' '))),
    el('div', { class: 'qact' }, statusChip(p.status)));
}

function proofRow(p) {
  const mismatch = !p.matches && !p.unreadable;
  const src = `/api/proof/${p.proofId}/image`;
  const caption = `Flat ${p.flat} · ${periodLabel(p.period)}`;
  return el('div', { class: `qrow ${mismatch ? 'qrow--bad' : ''}` },
    el('img', {
      class: 'qthumb', src, alt: `Screenshot from flat ${p.flat}`,
      loading: 'lazy',
      // The thumbnail is the obvious thing to press, so make it the control.
      style: 'cursor:zoom-in',
      title: 'Click to enlarge',
      onclick: () => lightbox(src, caption),
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
      el('button', {
        class: 'btn btn--sm btn--quiet', type: 'button',
        onclick: () => lightbox(src, caption),
      }, 'View'),
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
