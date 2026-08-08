/**
 * Who a resident contacts when something is wrong.
 *
 * One definition, because this was previously written out by hand in three
 * places — the login page, the dashboard footer and the public committee list —
 * and a single correction to the treasurer's number left two of them stale.
 * Committee members change at every AGM, so this will be edited again.
 *
 * The public committee list on the server (functions/lib/public.js) is
 * deliberately separate: it is published to anyone who visits, so what appears
 * there is a decision, not a copy of this.
 */

export const TREASURER = {
  name: 'Mukesh',
  role: 'Treasurer',
  phone: '+91 98464 66511',
};

/** 'Mukesh (Treasurer) — +91 98464 66511' */
export function treasurerLine() {
  return `${TREASURER.name} (${TREASURER.role}) — ${TREASURER.phone}`;
}

/** Digits only, with country code, for a wa.me or tel: link. */
export function dialable(phone = TREASURER.phone) {
  return phone.replace(/[^\d]/g, '');
}
