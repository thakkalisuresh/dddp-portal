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
}

/** Explicit, named actions only — never a generic click handler. */
export function trackAction(name, detail) {
  send('action', name, detail);
}

function send(kind, name, detail) {
  // Fire-and-forget: logging must never interrupt what a resident was doing.
  api.trackActivity({ kind, name, detail }).catch(() => {});
}
