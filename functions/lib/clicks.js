/**
 * Click capture — off by default, expires on its own.
 *
 * This is the one piece of instrumentation in the portal that records how a
 * person behaves rather than what they did. It exists because "the button
 * doesn't work for me" is otherwise unanswerable, and it is deliberately
 * awkward to leave running:
 *
 *   - a superadmin must switch it on explicitly
 *   - it switches itself off after a fixed window
 *   - it records element identity and visible label ONLY, never field values
 *   - rows live in their own table and can be dropped wholesale
 *
 * See docs/PRIVACY.md.
 */

import { fail } from './errors.js';

export const MAX_WINDOW_HOURS = 24;
export const DEFAULT_WINDOW_HOURS = 2;

/** Off unless explicitly on AND still inside its window. */
export function isCaptureOn(setting, now = new Date().toISOString()) {
  if (!setting || setting.value !== 'on') return false;
  if (!setting.expires_at) return false;      // an switch with no expiry is treated as off
  return setting.expires_at > now;
}

export function captureWindow(hours) {
  const requested = Number(hours);
  const capped = Number.isFinite(requested) && requested > 0
    ? Math.min(requested, MAX_WINDOW_HOURS)
    : DEFAULT_WINDOW_HOURS;
  return {
    hours: capped,
    expiresAt: new Date(Date.now() + capped * 3600_000).toISOString(),
  };
}

/** Fields whose text must never be recorded, whatever the element is. */
const SENSITIVE = /password|passwd|pin|otp|secret|token/i;

/**
 * Reduce a click to element identity plus visible label.
 *
 * The label is what makes a log readable ("Approve" beats "button.btn"), and
 * it is also where a careless implementation leaks data — so anything typed by
 * a person is dropped, and a password field is dropped entirely.
 */
export function sanitiseClick({ tag, id, classes, label, name, type, page }) {
  const safeTag = String(tag ?? '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 20);
  if (!safeTag) return null;

  // Never record anything about a credential field, not even that it was clicked.
  if (SENSITIVE.test(`${id ?? ''} ${name ?? ''} ${type ?? ''} ${label ?? ''}`)) return null;

  const safeId = String(id ?? '').replace(/[^\w-]/g, '').slice(0, 40);
  const safeClass = String(classes ?? '')
    .split(/\s+/).filter(Boolean).slice(0, 3).join('.').replace(/[^\w.-]/g, '').slice(0, 60);

  let target = safeTag;
  if (safeId) target += `#${safeId}`;
  if (safeClass) target += `.${safeClass}`;

  // A typed value is never a label. Inputs contribute their identity only.
  const isField = ['input', 'textarea', 'select'].includes(safeTag);
  const safeLabel = isField ? null : String(label ?? '').trim().replace(/\s+/g, ' ').slice(0, 80) || null;

  return {
    target,
    label: safeLabel,
    page: String(page ?? '').slice(0, 120),
  };
}

export function validateBatch(events) {
  if (!Array.isArray(events)) fail('DDP-NOTICE-003', { reason: 'clicks must be an array' });
  if (events.length > 100) fail('DDP-NOTICE-004', { reason: 'batch too large' });
  return events.map(sanitiseClick).filter(Boolean);
}
