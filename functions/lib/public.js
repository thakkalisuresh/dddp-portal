/**
 * The public site's data — everything reachable without logging in.
 *
 * The rule for this module: it must never leak anything a passer-by shouldn't
 * see. Notices are public by nature, but comments are not (they carry names
 * and flat numbers), and nothing here touches bills or residents.
 */

import { fail } from './errors.js';

export const MAX_MESSAGE = 2000;
export const CONTACT_RATE_PER_HOUR = 5;

/**
 * The committee is deliberately hard-coded rather than read from `owners`.
 * The old site published names and flat numbers of committee members on an
 * indexable page; keeping this list separate means adding a resident never
 * silently publishes them.
 */
export const COMMITTEE = [
  { role: 'President', name: 'Sekharan', flat: '5A' },
  { role: 'Secretary', name: 'Adv. Joy Vettiyadan', flat: '10A' },
  { role: 'Treasurer', name: 'Mukesh', flat: '13A', phone: '+91 98464 66511' },
  { role: 'Gas In-charge', name: 'Hari', flat: '13E' },
];

export const AMENITIES = [
  'Swimming pool', 'Green parks', '24×7 security', 'Power backup',
  'Club house', 'Children\'s play area', 'Sports ground', 'Jogging park',
];

/**
 * Carried across from the old site, which published them and which residents
 * still go looking for. Sunday is deliberately worded as a restriction rather
 * than a closure: somebody with a gas smell on a Sunday should not read this
 * and conclude there is nobody to call.
 */
export const OFFICE_HOURS = [
  { days: 'Monday to Friday', hours: '9:00 – 18:00' },
  { days: 'Saturday', hours: '10:00 – 16:00' },
  { days: 'Sunday', hours: 'Emergencies only' },
];

/**
 * Served to the contact form rather than duplicated in the browser, so the list
 * the visitor picks from and the list the server accepts cannot drift apart.
 *
 * Deliberately short. A long dropdown gets skimmed and the first option wins,
 * which is how every message ends up filed under whatever happens to be at the
 * top. "Something else" is last for the same reason.
 */
export const MESSAGE_SUBJECTS = [
  'Gas bill or payment',
  'Meter reading',
  'Maintenance',
  'Security',
  'Something else',
];

/** Notices only — never comments, which carry residents' names and flats. */
export async function publicNotices(env, { limit = 12 } = {}) {
  const rows = await env.DB.prepare(
    `SELECT id, title, body, kind, event_date, posted_at
       FROM notices WHERE active = 1
      ORDER BY posted_at DESC LIMIT ?`
  ).bind(limit).all();

  return (rows.results ?? []).map((n) => ({
    id: n.id,
    title: n.title,
    body: n.body,
    kind: n.kind,
    eventDate: n.event_date,
    postedAt: n.posted_at,
  }));
}

export function validateMessage({ name, body, email, phone, subject }) {
  const cleanName = String(name ?? '').trim();
  const cleanBody = String(body ?? '').trim();

  if (!cleanName) return { ok: false, message: 'Please give your name.' };
  if (!cleanBody) return { ok: false, message: 'Please write your message.' };
  if (cleanBody.length > MAX_MESSAGE) {
    return { ok: false, message: `Keep it under ${MAX_MESSAGE} characters.` };
  }
  // Not a validator so much as a typo check — a wrong address just means the
  // committee can't reply, so this warns rather than blocks anything else.
  const cleanEmail = String(email ?? '').trim();
  if (cleanEmail && !/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(cleanEmail)) {
    return { ok: false, message: 'That email address looks wrong. Check it, or leave it blank.' };
  }

  // Anything not on the list becomes null rather than an error. The subject is
  // a filing aid for the committee, not something the sender should be able to
  // fail at — and a message rejected over its dropdown is a message lost.
  const cleanSubject = String(subject ?? '').trim();

  return {
    ok: true,
    value: {
      name: cleanName,
      body: cleanBody,
      email: cleanEmail || null,
      phone: String(phone ?? '').trim() || null,
      subject: MESSAGE_SUBJECTS.includes(cleanSubject) ? cleanSubject : null,
    },
  };
}

export async function submitMessage(env, input, fingerprint) {
  const check = validateMessage(input);
  if (!check.ok) fail('DDP-NOTICE-003', { reason: check.message });

  const since = new Date(Date.now() - 3600_000).toISOString();
  const recent = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM message_attempts WHERE fingerprint = ? AND at > ?'
  ).bind(fingerprint, since).first();
  if ((recent?.n ?? 0) >= CONTACT_RATE_PER_HOUR) fail('DDP-NOTICE-004', { fingerprint });

  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO messages (name, email, phone, subject, body, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(check.value.name, check.value.email, check.value.phone,
           check.value.subject, check.value.body, now),
    env.DB.prepare('INSERT INTO message_attempts (fingerprint, at) VALUES (?, ?)')
      .bind(fingerprint, now),
  ]);

  return { received: true };
}

/** A coarse per-sender key. Not identification — just flood control. */
export function fingerprintOf(request) {
  return request.headers.get('cf-connecting-ip')
    || request.headers.get('x-forwarded-for')
    || 'unknown';
}
