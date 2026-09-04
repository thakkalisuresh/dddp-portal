/**
 * Self-service password reset by emailed code.
 *
 * A six-digit code is what someone will actually type from a phone, and six
 * digits is only 20 bits. So the security does not come from the code — it
 * comes from everything around it, and every one of these is load-bearing:
 *
 *   short expiry        a code is useless 15 minutes later
 *   hard attempt limit  5 wrong guesses burns it, so 10^6 is never explored
 *   single use          success consumes it immediately
 *   issue rate limit    3 an hour, so an attacker cannot mint fresh targets
 *   hashed at rest      a leaked database does not hand over live codes
 *
 * Remove any one and the others stop being sufficient. The attempt limit in
 * particular is what makes six digits defensible at all: without it, an
 * automated guesser walks the space in minutes.
 *
 * Pure, with one exception: `refuseCurrentPassword` has to hash to do its
 * job. Everything else is decision logic over rows, so all of it is testable.
 */

import { fail } from './errors.js';
import { verifyPassword, DEFAULT_ITERATIONS } from './crypto.js';
import { checkPassword } from '../../public/js/password-rules.js';

export const CODE_LENGTH = 6;
export const EXPIRY_MINUTES = 15;
export const MAX_ATTEMPTS = 5;
export const MAX_PER_HOUR = 3;

/**
 * A uniformly random numeric code.
 *
 * Rejection sampling rather than `% 1000000`: the modulo of a byte stream is
 * biased toward low values, and a code generator with a predictable skew is
 * worth less than its digit count suggests.
 */
export function generateCode(random = crypto) {
  let out = '';
  while (out.length < CODE_LENGTH) {
    const bytes = new Uint8Array(CODE_LENGTH * 2);
    random.getRandomValues(bytes);
    for (const b of bytes) {
      if (b >= 250) continue;          // 250..255 would bias 0..5
      out += String(b % 10);
      if (out.length === CODE_LENGTH) break;
    }
  }
  return out;
}

/** Codes are compared digit-for-digit, so normalise what people paste. */
export function normaliseCode(input) {
  return String(input ?? '').replace(/\D/g, '');
}

export function expiryFrom(now = new Date()) {
  return new Date(now.getTime() + EXPIRY_MINUTES * 60_000).toISOString();
}

/**
 * May this account be sent another code?
 *
 * Counts recent issues rather than recent failures: the thing being limited is
 * mail to a resident's inbox, which an attacker who knows a mobile number
 * could otherwise trigger endlessly.
 */
export function canIssue(recent, now = new Date()) {
  const hourAgo = new Date(now.getTime() - 3600_000).toISOString();
  const inWindow = recent.filter((r) => r.created_at > hourAgo);
  if (inWindow.length >= MAX_PER_HOUR) {
    return {
      ok: false,
      retryAfterMinutes: Math.max(1, Math.ceil(
        (new Date(inWindow[inWindow.length - 1].created_at).getTime() + 3600_000 - now.getTime())
        / 60_000)),
    };
  }
  return { ok: true };
}

/**
 * Is this reset row still usable? Returns a reason rather than a boolean so
 * the caller can say something true without saying something useful to an
 * attacker.
 */
export function resetState(row, now = new Date()) {
  if (!row) return { usable: false, reason: 'none' };
  if (row.used_at) return { usable: false, reason: 'used' };
  if (row.attempts >= MAX_ATTEMPTS) return { usable: false, reason: 'burned' };
  if (new Date(row.expires_at) <= now) return { usable: false, reason: 'expired' };
  return { usable: true, remaining: MAX_ATTEMPTS - row.attempts };
}

/**
 * What to tell someone whose code did not work.
 *
 * "Expired" and "wrong" are worth distinguishing — they lead to different
 * actions and neither reveals whether the account exists, since you only get
 * here holding a code that was sent to that account's own inbox. "Burned" is
 * named explicitly so nobody keeps guessing against a dead row.
 */
export function failureMessage(reason, remaining) {
  switch (reason) {
    case 'expired':
      return 'That code has expired. Ask for a new one.';
    case 'used':
      return 'That code has already been used. Ask for a new one.';
    case 'burned':
      return 'Too many wrong attempts. Ask for a new code.';
    case 'none':
      return 'No reset is in progress for that number. Ask for a code first.';
    default:
      return remaining > 0
        ? `That code is not right. ${remaining} ${remaining === 1 ? 'try' : 'tries'} left.`
        : 'Too many wrong attempts. Ask for a new code.';
  }
}

/* ── temporary passwords, and when they stop working (B10) ────────────────── */

/**
 * How long an issued temporary password lasts, by who issued it and why.
 *
 * These differ because the two messages are read at different speeds. A
 * superadmin reset goes to somebody who is locked out and waiting, and who will
 * use it within minutes; a short window costs them nothing and costs anyone
 * reading the thread a year later everything. A roster invite goes in bulk to
 * people who were not expecting it, some of whom are travelling — anything
 * short there turns the cutover into a re-send exercise.
 */
export const TEMP_PW_HOURS = 24;
export const INVITE_PW_HOURS = 72;

export function tempPasswordExpiry(hours = TEMP_PW_HOURS, now = new Date()) {
  return new Date(now.getTime() + hours * 3600_000).toISOString();
}

/**
 * Has this account's temporary password run out?
 *
 * Two guards, and both are the point rather than defensiveness:
 *
 * `must_change_pw` gates the whole check, so this can never expire a password
 * the resident chose. That flag means "this credential was handed to you"; it is
 * cleared the moment they pick their own, which is what makes an expiry unable
 * to strand anybody.
 *
 * A NULL `pw_expires_at` never expires. Every row predating migration 0023 has
 * one, and some of those are sitting on temporary passwords issued weeks ago —
 * reading NULL as "expired long ago" would lock all of them out on deploy.
 */
export function tempPasswordState(owner, now = new Date()) {
  if (!owner?.must_change_pw) return { expired: false };
  if (!owner.pw_expires_at) return { expired: false };
  return { expired: new Date(owner.pw_expires_at) <= now };
}

/**
 * What an expired temporary password says. It must not read as "wrong
 * password": the resident typed exactly what they were sent, and telling them
 * otherwise sends them back to the person who sent it instead of to `/forgot`.
 *
 * WHY IT ASKS WHETHER THERE IS AN ADDRESS. `/forgot` emails a code, so it can
 * only help somebody who has an address on file. The unconditional version of
 * this message sent everyone there, and for an account with no email that is a
 * closed loop: `/forgot` answers with the same neutral reply it gives an
 * unknown number, the resident waits for a code that was never sent, and the
 * only signal is a DDP-AUTH-011 nobody is watching for.
 *
 * That loop caught the population it could least afford to. A roster invite is
 * the one temporary password issued in bulk, `parseRoster` only picks up an
 * address when the paste carries a header naming the column, and B5 is the
 * count of residents who have none at all — so "expired invite, no address on
 * file" is the ordinary case here, not the edge one.
 *
 * The committee rather than a name, matching the line already under the login
 * form: committee members change at every AGM, and the published list on the
 * home page is the one copy that has to be right.
 */
export function expiredPasswordMessage(hasEmail = true) {
  const opener = 'That temporary password has expired. ';
  return hasEmail
    ? opener + 'Use "Forgotten your password?" below to email yourself a new code.'
    : opener + 'There is no email address on your account, so a code cannot be sent to you — '
             + 'reach out to the committee for a new password.';
}

/**
 * The single gate every new password passes through — onboarding, the profile
 * change, and the reset-with-code path all end up here.
 *
 * `user` is what the policy needs to judge it: `role` picks the tier, and
 * name/mobile/email/flat are what it must not contain. Passing nothing
 * applies the owner tier with no personal blocklist, which is the safe
 * default for a caller that genuinely has no account in hand.
 *
 * The rules themselves live in public/js/password-rules.js so the browser can
 * apply the same ones before a round trip.
 */
export function validateNewPassword(pw, user = {}) {
  const password = String(pw ?? '');
  const problem = checkPassword(password, user);
  if (problem) {
    // publicMessage reaches the resident via guard(); length and role are for
    // the log. The password itself is never recorded, here or anywhere.
    fail(problem.code, {
      publicMessage: problem.message,
      length: password.length,
      role: user.role ?? 'owner',
    });
  }
  return password;
}

/**
 * Refuses a new password that is the one the account already holds.
 *
 * THE HOLE THIS CLOSES. A temporary password is issued, the resident logs in
 * with it, and `must_change_pw` sends them to the forced-change screen — which
 * then accepted the temporary password back as their permanent one. Nothing
 * compared the candidate against the stored hash, so the forced change could
 * be satisfied by retyping what had just been read out over the phone. The
 * credential the system deliberately sends in the clear became the credential
 * the account keeps, and `must_change_pw` went to 0 recording that a change
 * had happened.
 *
 * WHY IT IS A HASH COMPARISON AND NOT A STRING ONE. On the forced path the
 * old plaintext is never submitted — the screen does not ask for it, precisely
 * because the resident just typed it at login. The stored hash is the only
 * copy of the old password in reach, so the check costs one PBKDF2 derive.
 * That is why it runs AFTER validateNewPassword: a candidate that fails a
 * cheap composition rule should not pay for a derive first.
 *
 * WHY IT LEAKS NOTHING. Every caller has already proved it holds this
 * credential — a live session, or a verified reset code. Telling them the
 * password is the one they already have tells them what they just typed.
 *
 * The wording splits on `must_change_pw` because the two cases send the
 * resident somewhere different: "that is the temporary one" means look at the
 * message again, "that is already yours" means you have nothing to do.
 *
 * Throws rather than passing when the hash columns are absent. A guard whose
 * inputs a caller forgot to SELECT would silently approve every password on
 * that path, which is the exact failure this function exists to end.
 */
export async function refuseCurrentPassword(candidate, owner = {}) {
  if (!owner.pw_hash || !owner.pw_salt) {
    // Fatal, so it alerts. The resident gets a 500 and their old password
    // still works, which is the safe side of a guard that cannot run.
    fail('DDP-SYS-001', 'refuseCurrentPassword: caller did not SELECT pw_hash/pw_salt');
  }

  const same = await verifyPassword(String(candidate ?? ''), owner.pw_hash, owner.pw_salt,
                                    owner.pw_iterations ?? DEFAULT_ITERATIONS);
  if (!same) return;

  fail('DDP-AUTH-017', {
    publicMessage: owner.must_change_pw
      ? 'That is the temporary password you were sent. Choose a different one.'
      : 'That is already your password. Choose a different one.',
    temporary: Boolean(owner.must_change_pw),
    role: owner.role ?? 'owner',
  });
}

/**
 * The email a resident receives.
 *
 * No link. A reset link in an email is a bearer token that survives in inboxes,
 * forwards and mail scanners — some of which follow links automatically and
 * would consume the reset. A typed code cannot be spent by a machine that
 * merely reads the message.
 */
export function resetEmail({ code, name, flat }) {
  return {
    subject: `Diamond Park — your password reset code is ${code}`,
    text: [
      `Hello${name ? ` ${name}` : ''},`,
      '',
      `Your password reset code for flat ${flat} is:`,
      '',
      `    ${code}`,
      '',
      `It expires in ${EXPIRY_MINUTES} minutes and can be used once.`,
      '',
      'Enter it at https://diamondpark.pages.dev/forgot',
      '',
      'If you did not ask for this, you can ignore it. Your password has not',
      'changed, and nobody can use this code without your email.',
      '',
      'DD Diamond Park Residents\' Welfare Association',
    ].join('\n'),
  };
}

/**
 * The email carrying a temporary password the superadmin has just issued.
 *
 * Distinct from `resetEmail` because it carries a live credential rather than a
 * code that only works on one page, and the two must not converge: this one has
 * to say plainly that the next step is choosing their own, and it cannot claim
 * to be single-use, because it is not — it is an ordinary password that happens
 * to expire.
 *
 * No link, for the same reason as `resetEmail`: mail scanners follow links, and
 * a link that carries a working password is worse than one that carries a code.
 */
export function tempPasswordEmail({ password, name, flat, hours = TEMP_PW_HOURS }) {
  return {
    subject: 'Diamond Park — a temporary password for your account',
    text: [
      `Hello${name ? ` ${name}` : ''},`,
      '',
      `A temporary password has been set for flat ${flat}:`,
      '',
      `    ${password}`,
      '',
      `It expires in ${hours} hours. Log in at https://diamondpark.pages.dev`,
      'and you will be asked to choose your own password straight away.',
      '',
      'If you did not ask for this, tell the committee — somebody has reset',
      'your account. Your old password no longer works either way.',
      '',
      'DD Diamond Park Residents\' Welfare Association',
    ].join('\n'),
  };
}

/**
 * The reply to "I forgot my password". One string, always.
 *
 * TAKES NO ARGUMENTS ON PURPOSE. The first version accepted a masked address
 * so the page could say "a code is on its way to pr***@example.com" — which
 * meant the reply differed for a real account and turned the endpoint into a
 * resident directory: try a mobile number, read whether somebody lives here.
 *
 * A parameter-less function cannot leak what it is never given. The unit test
 * that was supposed to catch this compared neutralReply(null) with
 * neutralReply(null) and passed while the endpoint leaked.
 *
 * The cost is real: someone with several addresses is not told which inbox to
 * open. That is a worse experience for a handful of people, against
 * enumeration of every flat in the building by anyone with a phone.
 */
export function neutralReply() {
  return {
    ok: true,
    message: 'If that number belongs to a resident with an email on file, '
           + 'a code is on its way. Check the address on your account.',
  };
}
