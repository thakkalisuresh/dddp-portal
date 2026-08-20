/**
 * Sending email, via the Gmail API.
 *
 * Gmail rather than a mail service because the OAuth plumbing already exists
 * for the nightly Drive backup — same refresh-token exchange, one extra scope
 * (`gmail.send`). A new provider would mean a new account, a new key, and a
 * second thing to notice had stopped working.
 *
 * Same plumbing, not necessarily the same account. This path deliberately uses
 * the SHARED `GOOGLE_` credentials, which belong to the association: a reset
 * code arriving from a committee member's personal address is a worse email
 * than one arriving from the association's, and it changes whose inbox the
 * replies land in. The backup overrides these with `GOOGLE_BACKUP_*` and is
 * free to be somebody's personal Drive; see backupCredentials() in backup.js.
 *
 * Everything funnels through sendEmail() so swapping providers later is one
 * function, not a search. If that day comes, the free tiers worth looking at
 * are Brevo and Resend; the caller contract below is deliberately generic.
 *
 * Gmail's free send limit is ~500/day, against a building of 99 flats where a
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
 *
 * Pass `html` and the message becomes `multipart/alternative` carrying BOTH
 * bodies — never HTML alone. `text` therefore stays required: it is the only
 * thing a client that will not render HTML has to show.
 *
 * With no `html` the output is byte-for-byte what it was before this function
 * learned about HTML at all: same headers, same order, same single base64
 * body. Every existing caller is on that path.
 */
export function buildRawMessage({ to, from, subject, text, html }) {
  const encodedSubject = /^[\x20-\x7E]*$/.test(subject)
    ? subject
    : `=?UTF-8?B?${btoa(unescape(encodeURIComponent(subject)))}?=`;

  const headers = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${encodedSubject}`,
    'MIME-Version: 1.0',
  ];

  let raw;
  if (html) {
    // A fresh boundary per message. It could not collide even if it were
    // fixed — both parts are base64, and `=_` cannot occur inside base64
    // output except as trailing padding — but a random one means nothing here
    // depends on that argument staying true.
    const boundary = `=_dddp_${crypto.randomUUID()}`;
    headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);

    // Least-preferred first: `alternative` means clients show the LAST part
    // they can render, so text has to come before html or nobody sees the
    // HTML at all.
    raw = [
      headers.join('\r\n'),
      '',
      mimePart(boundary, 'text/plain', text),
      mimePart(boundary, 'text/html', html),
      `--${boundary}--`,
    ].join('\r\n');
  } else {
    headers.push(
      'Content-Type: text/plain; charset="UTF-8"',
      'Content-Transfer-Encoding: base64',
    );
    // The body is base64 too, so a long line or a non-ASCII character cannot
    // break the message the way raw 8-bit text through SMTP can.
    raw = `${headers.join('\r\n')}\r\n\r\n${base64(text)}`;
  }

  return btoa(unescape(encodeURIComponent(raw)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** UTF-8 in, base64 out. `btoa` rejects non-ASCII without the round trip. */
function base64(s) {
  return btoa(unescape(encodeURIComponent(s)));
}

/**
 * One `multipart/alternative` part, headers and body, no trailing CRLF.
 *
 * Wrapped at 76 columns, which the single-part path above does not bother
 * with. That path only ever carries a few hundred characters of plain text
 * and its exact bytes are load-bearing for the callers that predate this;
 * an HTML body is thousands of characters, well past the 998-octet line
 * limit an MTA is allowed to enforce, and a line broken by somebody else is
 * a corrupted body.
 */
function mimePart(boundary, type, body) {
  return [
    `--${boundary}`,
    `Content-Type: ${type}; charset="UTF-8"`,
    'Content-Transfer-Encoding: base64',
    '',
    wrap76(base64(body)),
  ].join('\r\n');
}

function wrap76(s) {
  return (s.match(/.{1,76}/g) ?? []).join('\r\n');
}

/**
 * A token to spend across a batch of sends.
 *
 * ONE SEND IS TWO SUBREQUESTS — a token refresh and the send itself — because
 * sendEmail() refreshes on every call and nothing caches the result. A
 * Cloudflare request on the free plan gets 50 (docs/COSTS.md), so a loop that
 * mails the building runs out at the twenty-fifth flat. Minting once here and
 * passing it to each send makes a batch of N cost N+1 instead of 2N.
 *
 * Never throws, and reports failure in sendEmail's own vocabulary, so a caller
 * can hand the reason straight to the same error path it already has for a
 * send that did not happen.
 */
export async function mailToken(env) {
  if (!mailConfigured(env)) return { ok: false, reason: 'not-configured' };
  try {
    return { ok: true, token: await refreshAccessToken(env) };
  } catch (err) {
    return { ok: false, reason: err?.code ?? 'threw' };
  }
}

/**
 * Send one message. Returns true only on a delivery Gmail accepted.
 *
 * Never throws on a send failure: a password reset that 500s tells the person
 * asking that something is broken, and the neutral reply exists precisely so
 * the endpoint reveals nothing. The failure is recorded instead.
 *
 * `html` is optional and additive: `text` is still what a caller must supply,
 * and it is still what gets delivered on its own when there is no HTML to
 * offer. See renderEmail() in email-template.js for producing the pair.
 *
 * `token` is likewise optional. Omit it and this refreshes its own, which is
 * what every caller sending a single message should keep doing. Pass one from
 * mailToken() only on a path that sends in bulk, where the refresh per message
 * is what exhausts the subrequest budget.
 *
 * A token that has expired mid-batch comes back as `gmail-401`, not as a
 * silent failure: mint a fresh one and retry that message.
 */
export async function sendEmail(env, { to, subject, text, html }, token = null) {
  if (!mailConfigured(env)) return { sent: false, reason: 'not-configured' };

  try {
    const auth = token ?? await refreshAccessToken(env);
    const res = await fetch(
      'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${auth}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          raw: buildRawMessage({ to, from: env.MAIL_FROM, subject, text, html }),
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
