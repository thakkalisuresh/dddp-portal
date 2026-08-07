/**
 * Page views and client-side errors.
 *
 * NOT every click. Logging keystroke-level behaviour on a residents' portal
 * would mean recording individuals' activity in detail for very little
 * debugging value, and the rows add up fast. What actually answers "what did
 * this person do?" is: which pages they opened, which actions they took
 * (already audited server-side), and which errors they hit. That is what this
 * sends. See docs/PRIVACY.md.
 */

import { api } from './api.js';

let started = false;
let clickQueue = [];
let flushTimer = null;

export function trackPage(name = location.pathname) {
  if (started) return;
  started = true;
  send('page', name);

  // A browser error a resident hits is invisible server-side, and is usually
  // the thing that made them ring the treasurer.
  window.addEventListener('error', (e) => {
    send('client-error', e.message?.slice(0, 120) ?? 'error', {
      source: e.filename, line: e.lineno,
    });
  });
  window.addEventListener('unhandledrejection', (e) => {
    send('client-error', String(e.reason?.message ?? e.reason).slice(0, 120));
  });

  maybeStartClickCapture();
}

/**
 * Click capture, only while a superadmin has switched it on.
 *
 * The server re-checks the switch on every batch, so a page left open after
 * the window closes stops being recorded — this check just avoids sending in
 * the first place. Nothing typed is ever captured; see functions/lib/clicks.js.
 */
async function maybeStartClickCapture() {
  let state;
  try {
    state = await api.captureState();
  } catch {
    return;
  }
  if (!state?.on) return;

  document.addEventListener('click', (event) => {
    const el = event.target?.closest?.('button, a, [role="button"], input, select, textarea, summary, label');
    if (!el) return;

    clickQueue.push({
      tag: el.tagName,
      id: el.id || null,
      classes: el.className?.toString?.() ?? null,
      name: el.name || null,
      type: el.type || null,
      // Never el.value — the server drops field labels too, but not sending
      // them at all means a typed mobile number never leaves the device.
      label: ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)
        ? null
        : (el.textContent ?? '').slice(0, 120),
      page: location.pathname,
    });

    // Batched: one request per burst, not one per click.
    clearTimeout(flushTimer);
    flushTimer = setTimeout(flushClicks, 2500);
    if (clickQueue.length >= 25) flushClicks();
  }, { capture: true, passive: true });

  addEventListener('pagehide', flushClicks);
}

function flushClicks() {
  if (!clickQueue.length) return;
  const batch = clickQueue.splice(0, 100);
  api.sendClicks(batch).catch(() => {});
}

/** Explicit, named actions only — never a generic click handler. */
export function trackAction(name, detail) {
  send('action', name, detail);
}

function send(kind, name, detail) {
  // Fire-and-forget: logging must never interrupt what a resident was doing.
  api.trackActivity({ kind, name, detail }).catch(() => {});
}
