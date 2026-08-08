/**
 * Upload a payment screenshot — screen 06.
 *
 * The mismatch case is the one worth designing carefully: telling the resident
 * at upload that their screenshot shows ₹150 against a ₹329 bill saves the
 * treasurer's evening, and saves the resident a week of thinking they've paid.
 */

import { api, ApiError } from './api.js';
import { renderNav } from './nav.js';
import { trackPage } from './track.js';
import { $, el, esc, renderGodBanner, showError } from './ui.js';
import { money, periodLabel } from './i18n.js';
import { compressImage, humanSize } from './compress.js';

const main = $('#main');
let bill = null;
let chosen = null;

trackPage('/proof');
init();

async function init() {
  try {
    const me = await api.me();
    $('#who').innerHTML = `Flat ${esc(me.flat)} <span>· ${esc(me.name)}</span>`;
    renderGodBanner(me, { onExit: async () => { await api.god.exit(); location.reload(); } });
    renderNav(me, '/proof');

    bill = me.bill;
    if (!bill) { main.replaceChildren(el('div', { class: 'note note--good' }, 'You have no bill to pay.')); return; }
    if (bill.settled) {
      main.replaceChildren(el('div', { class: 'note note--good' },
        'This bill is already settled. Nothing to upload.'));
      return;
    }
    render();
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) { location.href = '/login'; return; }
    showError(main, err);
  }
}

function render() {
  const status = el('div');
  const previewSlot = el('div');
  const submitSlot = el('div');

  const input = el('input', {
    type: 'file', accept: 'image/*', capture: 'environment',
    id: 'file', class: 'visually-hidden',
    onchange: async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      status.replaceChildren(el('p', { class: 'small muted' }, 'Preparing your image…'));
      try {
        const result = await compressImage(file);
        chosen = result.blob;
        previewSlot.replaceChildren(preview(file, result));
        submitSlot.replaceChildren(submitButton(status, submitSlot));
        status.replaceChildren();
      } catch {
        showError(status, { message: "That image couldn't be read. Try taking the screenshot again." });
      }
    },
  });

  main.replaceChildren(
    el('div', { class: 'stack', style: 'gap:var(--s-2)' },
      el('p', { class: 'label' }, periodLabel(bill.period)),
      el('h1', {}, `Upload proof of ${money(bill.total)}`),
      el('p', { class: 'muted small' },
        'A photo or screenshot from your UPI app. The treasurer checks it against the bank statement.')),
    input,
    el('label', { class: 'drop', for: 'file', style: 'cursor:pointer;display:block' },
      el('strong', { style: 'font-family:var(--font-ui)' }, 'Choose a screenshot'),
      el('p', { class: 'small muted', style: 'margin-top:var(--s-2)' },
        'It is resized on your phone before uploading, so it stays quick on mobile data.')),
    status,
    previewSlot,
    submitSlot
  );
}

function preview(file, result) {
  const url = URL.createObjectURL(result.blob);
  return el('div', { class: 'preview' },
    el('img', { src: url, alt: 'Your screenshot', onload: () => URL.revokeObjectURL(url) }),
    el('div', { class: 'stack', style: 'gap:var(--s-1)' },
      el('strong', { style: 'font-family:var(--font-ui);font-size:var(--text-sm)' }, file.name),
      el('p', { class: 'small muted' },
        result.compressed
          ? `${humanSize(result.originalSize)} → ${humanSize(result.blob.size)}`
          : humanSize(result.blob.size)),
      el('label', { class: 'linkish', for: 'file', style: 'cursor:pointer' }, 'Choose another')));
}

function submitButton(status, slot) {
  const button = el('button', { class: 'btn btn--block btn--lg', type: 'button' }, 'Submit for approval');

  button.addEventListener('click', async () => {
    button.disabled = true;
    button.textContent = 'Uploading…';
    try {
      const result = await api.uploadProof(bill.id, chosen);
      slot.replaceChildren();
      status.replaceChildren(outcome(result));
    } catch (err) {
      button.disabled = false;
      button.textContent = 'Submit for approval';
      showError(status, err);
    }
  });

  return el('div', { class: 'stack' }, button,
    el('p', { class: 'small muted', style: 'text-align:center' },
      'The treasurer checks this against the bank statement.'));
}

function outcome(result) {
  const { assessment, parsed } = result;

  const readback = el('div', { class: 'stack', style: 'gap:0;margin-top:var(--s-3)' },
    parsed.amount != null
      ? el('div', { class: 'kv' }, el('span', {}, 'Amount read'), el('strong', {}, money(parsed.amount)))
      : null,
    parsed.utr ? el('div', { class: 'kv' }, el('span', {}, 'Reference'), el('strong', {}, parsed.utr)) : null,
    parsed.date ? el('div', { class: 'kv' }, el('span', {}, 'Date'), el('strong', {}, parsed.date)) : null);

  if (assessment.verdict === 'match') {
    return el('div', { class: 'stack' },
      el('div', { class: 'note note--good' },
        el('strong', {}, 'Received. '),
        'The treasurer will confirm it shortly — you don\'t need to do anything else.',
        readback),
      el('a', { class: 'btn btn--ghost btn--block', href: '/dashboard' }, 'Back to your bill'));
  }

  // A mismatch is surfaced now rather than discovered by the treasurer days later.
  return el('div', { class: 'stack' },
    el('div', { class: assessment.verdict === 'unreadable' ? 'note note--warn' : 'note note--bad' },
      el('strong', {}, assessment.message),
      assessment.verdict === 'short'
        ? el('p', { style: 'margin-top:var(--s-2)' },
            `You may need to pay the remaining ${money(assessment.short)}.`)
        : null,
      readback),
    el('a', { class: 'btn btn--block', href: '/dashboard' }, 'Back to your bill'));
}
