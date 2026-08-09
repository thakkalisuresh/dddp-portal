/**
 * Sending email, via the Gmail API.
 *
 * Gmail rather than a mail service because the OAuth plumbing already exists
 * for the nightly Drive backup — same client, same refresh-token exchange, one
 * extra scope (`gmail.send`). A new provider would mean a new account, a new
 * key, and a second thing to notice had stopped working.
 *
 * Everything funnels through sendEmail() so swapping providers later is one
 * function, not a search. If that day comes, the free tiers worth looking at
 * are Brevo and Resend; the caller contract below is deliberately generic.
 *
 * Gmail's free send limit is ~500/day, against a building of 52 flats where a
 * password reset is a rare event. Volume is not the constraint here.
 */

import { refreshAccessToken } from './backup.js';

export function mailConfigured(env) {
  return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
    && env.GOOGLE_REFRESH_TOKEN && env.MAIL_FROM);
}

/**
 * RFC 2822, base64url.
 *
 * The subject is encoded rather than passed through: a rupee sign or a
 * Malayalam character in a raw header produces a mangled subject line in most
 * clients, and the reset subject carries neither today but will the moment
 * anything here is translated.
 */
export function buildRawMessage({ to, from, subject, text }) {
  const encodedSubject = /^[\x20-\x7E]*$/.test(subject)
    ? subject
    : `=?UTF-8?B?${btoa(unescape(encodeURIComponent(subject)))}?=`;

  const headers = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${encodedSubject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
  ];

  // The body is base64 too, so a long line or a non-ASCII character cannot
  // break the message the way raw 8-bit text through SMTP can.
  const body = btoa(unescape(encodeURIComponent(text)));
  const raw = `${headers.join('\r\n')}\r\n\r\n${body}`;

  return btoa(unescape(encodeURIComponent(raw)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Send one message. Returns true only on a delivery Gmail accepted.
 *
 * Never throws on a send failure: a password reset that 500s tells the person
 * asking that something is broken, and the neutral reply exists precisely so
 * the endpoint reveals nothing. The failure is recorded instead.
 */
export async function sendEmail(env, { to, subject, text }) {
  if (!mailConfigured(env)) return { sent: false, reason: 'not-configured' };

  try {
    const token = await refreshAccessToken(env);
    const res = await fetch(
      'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          raw: buildRawMessage({ to, from: env.MAIL_FROM, subject, text }),
        }),
      }
    );

    if (!res.ok) {
      // Status only. Gmail's error bodies can echo the address back, and this
      // string ends up in a log the whole committee can read.
      return { sent: false, reason: `gmail-${res.status}` };
    }
    return { sent: true };
  } catch (err) {
    return { sent: false, reason: err?.code ?? 'threw' };
  }
}
