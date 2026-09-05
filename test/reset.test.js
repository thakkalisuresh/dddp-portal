import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  generateCode, normaliseCode, canIssue, resetState, failureMessage,
  validateNewPassword, resetEmail, neutralReply, refuseCurrentPassword,
  refusePastPassword, HISTORY_DEPTH,
  CODE_LENGTH, MAX_ATTEMPTS, MAX_PER_HOUR, EXPIRY_MINUTES,
  tempPasswordState, tempPasswordExpiry, expiredPasswordMessage, tempPasswordEmail,
  TEMP_PW_HOURS, INVITE_PW_HOURS,
  generateLinkToken, linkHash, resetLinkUrl,
} from '../functions/lib/reset.js';
import { buildRawMessage } from '../functions/lib/mailer.js';
import { hashPassword, generateOneTimePassword } from '../functions/lib/crypto.js';

const iso = (minsAgo, now = Date.now()) => new Date(now - minsAgo * 60_000).toISOString();

/* ── the code itself ─────────────────────────────────────────────────────── */

describe('the code', () => {
  it('is six digits', () => {
    for (let i = 0; i < 50; i++) {
      expect(generateCode()).toMatch(new RegExp(`^\\d{${CODE_LENGTH}}$`));
    }
  });

  it('is not biased toward low digits', () => {
    // Six digits is only 20 bits, so the entropy it does have has to be real.
    // `% 10` over raw bytes over-produces 0-5; rejection sampling does not.
    const counts = new Array(10).fill(0);
    for (let i = 0; i < 2000; i++) for (const c of generateCode()) counts[+c] += 1;
    const expected = (2000 * CODE_LENGTH) / 10;
    for (const [digit, n] of counts.entries()) {
      expect(Math.abs(n - expected) / expected, `digit ${digit}`).toBeLessThan(0.2);
    }
  });

  it('does not repeat itself', () => {
    const seen = new Set(Array.from({ length: 500 }, () => generateCode()));
    expect(seen.size).toBeGreaterThan(495);
  });

  it('accepts a code however someone pastes it', () => {
    expect(normaliseCode(' 123 456 ')).toBe('123456');
    expect(normaliseCode('123-456')).toBe('123456');
  });
});

/* ── the controls that make six digits defensible ────────────────────────── */

describe('the attempt limit', () => {
  const live = { attempts: 0, used_at: null, expires_at: iso(-EXPIRY_MINUTES) };

  it('allows a usable code', () => {
    expect(resetState(live)).toMatchObject({ usable: true, remaining: MAX_ATTEMPTS });
  });

  it('burns the code after enough wrong guesses', () => {
    // Without this, 10^6 is walkable by a script in minutes.
    expect(resetState({ ...live, attempts: MAX_ATTEMPTS }))
      .toMatchObject({ usable: false, reason: 'burned' });
  });

  it('refuses an expired code', () => {
    expect(resetState({ ...live, expires_at: iso(1) }))
      .toMatchObject({ usable: false, reason: 'expired' });
  });

  it('refuses a code that was already spent', () => {
    expect(resetState({ ...live, used_at: iso(1) }))
      .toMatchObject({ usable: false, reason: 'used' });
  });

  it('refuses when no reset was ever requested', () => {
    expect(resetState(null)).toMatchObject({ usable: false, reason: 'none' });
  });
});

describe('the issue rate limit', () => {
  it('allows the first few', () => {
    expect(canIssue([{ created_at: iso(10) }]).ok).toBe(true);
  });

  it('stops an attacker filling a resident inbox', () => {
    const recent = Array.from({ length: MAX_PER_HOUR }, (_, i) => ({ created_at: iso(i * 5) }));
    const v = canIssue(recent);
    expect(v.ok).toBe(false);
    expect(v.retryAfterMinutes).toBeGreaterThan(0);
  });

  it('forgets requests older than an hour', () => {
    const old = Array.from({ length: 10 }, (_, i) => ({ created_at: iso(61 + i) }));
    expect(canIssue(old).ok).toBe(true);
  });
});

describe('the new password', () => {
  it('rejects anything short', () => {
    expect(() => validateNewPassword('short1')).toThrow(/DDP-AUTH-008/);
    expect(() => validateNewPassword('')).toThrow(/DDP-AUTH-008/);
  });

  it('accepts a reasonable one unchanged', () => {
    expect(validateNewPassword('correct horse battery')).toBe('correct horse battery');
  });

  it('rejects letters alone, and counts a space as the symbol', () => {
    expect(() => validateNewPassword('onlyletters')).toThrow(/DDP-AUTH-013/);
    // The passphrase above passes on its spaces — that is deliberate, and is
    // what stops the rule pushing everyone toward the symbol row.
    expect(validateNewPassword('two blue lemons')).toBe('two blue lemons');
    expect(validateNewPassword('onlyletters7')).toBe('onlyletters7');
  });

  it('refuses a password built out of the resident', () => {
    const user = { name: 'Anoop Nair', mobile: '+919876543210', flat: 'B-402' };
    expect(() => validateNewPassword('anoop12345', user)).toThrow(/DDP-AUTH-015/);
    expect(() => validateNewPassword('xxnair99xx', user)).toThrow(/DDP-AUTH-015/);
    expect(() => validateNewPassword('x543210xx1', user)).toThrow(/DDP-AUTH-015/);
    expect(() => validateNewPassword('reallyb-402', user)).toThrow(/DDP-AUTH-015/);
    // A different resident's details are not this resident's problem.
    expect(validateNewPassword('anoop12345', { name: 'Priya Menon' })).toBe('anoop12345');
  });

  it('refuses the passwords everyone tries first', () => {
    expect(() => validateNewPassword('mypassword1')).toThrow(/DDP-AUTH-015/);
    expect(() => validateNewPassword('diamondpark1')).toThrow(/DDP-AUTH-015/);
  });

  it('holds admins to a longer minimum and a capital', () => {
    const admin = { role: 'admin', name: 'Priya Menon' };
    // Fine for an owner, too short for an admin.
    expect(validateNewPassword('rutabaga7')).toBe('rutabaga7');
    expect(() => validateNewPassword('rutabaga7', admin)).toThrow(/DDP-AUTH-008/);
    expect(() => validateNewPassword('rutabaga wagon', admin)).toThrow(/DDP-AUTH-014/);
    expect(validateNewPassword('Rutabaga wagon', admin)).toBe('Rutabaga wagon');
    // A superadmin is held to the same bar as an admin.
    expect(() => validateNewPassword('rutabaga7', { role: 'superadmin' })).toThrow(/DDP-AUTH-008/);
  });

  it('reports length before content, so nobody fixes the wrong thing', () => {
    // Short AND missing a number: the length is what they must hear first.
    expect(() => validateNewPassword('abc')).toThrow(/DDP-AUTH-008/);
  });

  it('carries wording specific to the tier that refused it', () => {
    // guard() surfaces detail.publicMessage; a fixed table cannot know which
    // minimum applied.
    expect(() => validateNewPassword('short1', { role: 'admin' }))
      .toThrow(/DDP-AUTH-008/);
    try {
      validateNewPassword('short1', { role: 'admin' });
    } catch (err) {
      expect(err.detail.publicMessage).toMatch(/12 characters/);
      expect(err.detail.role).toBe('admin');
    }
  });
});

/* ── what the endpoint gives away ────────────────────────────────────────── */

describe('the reply reveals nothing about who lives here', () => {
  // The version of this test that shipped first compared neutralReply(null)
  // with neutralReply(null) — the same call twice — and asserted they matched.
  // It passed while the live endpoint answered "a code is on its way to
  // pr***@example.com" for real accounts and omitted that for unknown ones,
  // which is a resident directory for anyone with a phone.
  //
  // The repair was structural: the function now takes no arguments, so there
  // is nothing to vary. These assertions verify that property rather than
  // re-checking one value against itself.
  it('takes no arguments, so nothing about the account can reach the reply', () => {
    expect(neutralReply.length).toBe(0);
  });

  it('ignores anything a careless caller passes', () => {
    const leaky = neutralReply('priya@example.com', { flat: '4B' });
    expect(JSON.stringify(leaky)).not.toMatch(/priya|example\.com|4B/);
  });

  it('is byte-identical however it is called', () => {
    const calls = [neutralReply(), neutralReply(null), neutralReply('x@y.com')];
    const rendered = calls.map((c) => JSON.stringify(c));
    expect(new Set(rendered).size).toBe(1);
  });

  it('never asserts that an account exists', () => {
    expect(neutralReply().message).toMatch(/^If that number belongs/);
  });

  it('distinguishes expired from wrong, since both are safe to say', () => {
    // You only reach these holding a code sent to that account's own inbox,
    // so neither leaks anything — and they lead to different actions.
    expect(failureMessage('expired')).toMatch(/expired/i);
    expect(failureMessage('wrong', 3)).toMatch(/3 tries left/);
    expect(failureMessage('wrong', 1)).toMatch(/1 try left/);
    expect(failureMessage('burned')).toMatch(/too many/i);
  });
});

/* ── the email ───────────────────────────────────────────────────────────── */

describe('the email', () => {
  const mail = resetEmail({ code: '123456', name: 'Priya', flat: '4B' });

  it('puts the code in the subject, so it is readable from a notification', () => {
    expect(mail.subject).toContain('123456');
  });

  it('NEVER carries the code in a URL, with or without a link', () => {
    // Revised 2026-09-04. This used to assert no link at all. A link is now
    // deliberate — see generateLinkToken() — but the rule it was protecting
    // survives intact and is what is asserted here: the thing a resident types
    // must never be the thing in the query string. A code in a URL is a code
    // in browser history, in the Referer sent to anything the landing page
    // loads, and in every proxy log between the resident and Cloudflare.
    const withLink = resetEmail({ code: '481902', name: 'Priya', flat: '3B',
                                  link: resetLinkUrl('a'.repeat(64)) });
    for (const body of [mail.text, mail.html, withLink.text, withLink.html]) {
      for (const url of body.match(/https?:\/\/\S+/g) ?? []) {
        expect(url).not.toContain('481902');
        expect(url).not.toMatch(/[?&](code|pw|password)=/);
      }
    }
  });

  it('offers the link and the typed code as two ways through the same reset', () => {
    const m = resetEmail({ code: '481902', name: 'Priya', flat: '3B',
                           link: resetLinkUrl('b'.repeat(64)) });
    expect(m.html).toContain('Reset my password');
    expect(m.text).toContain(`forgot?t=${'b'.repeat(64)}`);
    // The code is still in the letter for a client that eats the link.
    expect(m.text).toContain('481902');
    expect(m.html).toContain('481902');
  });

  it('says how long it lasts and that it is single use', () => {
    expect(mail.text).toContain(`${EXPIRY_MINUTES} minutes`);
    expect(mail.text).toMatch(/once/);
  });

  it('tells someone who did not ask that they need do nothing', () => {
    expect(mail.text).toMatch(/did not ask/i);
  });
});

describe('the raw message', () => {
  const raw = buildRawMessage({
    to: 'a@b.com', from: 'ddp@gmail.com', subject: 'Hello', text: 'Body',
  });
  const decoded = () => atob(raw.replace(/-/g, '+').replace(/_/g, '/'));

  it('is base64url, as the Gmail API requires', () => {
    expect(raw).not.toMatch(/[+/=]/);
  });

  it('carries the headers Gmail needs', () => {
    const d = decoded();
    expect(d).toContain('From: ddp@gmail.com');
    expect(d).toContain('To: a@b.com');
    expect(d).toContain('Subject: Hello');
  });

  it('encodes a non-ASCII subject rather than mangling it', () => {
    // Nothing here needs it today, but the moment any of this is translated
    // a raw header would arrive as gibberish in most clients.
    const ml = buildRawMessage({
      to: 'a@b.com', from: 'x@y.com', subject: 'പാസ്‌വേഡ് ₹329', text: 'x',
    });
    const d = atob(ml.replace(/-/g, '+').replace(/_/g, '/'));
    expect(d).toMatch(/Subject: =\?UTF-8\?B\?/);
  });

  it('survives a body with non-ASCII characters', () => {
    const ml = buildRawMessage({ to: 'a@b.com', from: 'x@y.com', subject: 'x', text: 'ഹലോ ₹75' });
    const d = atob(ml.replace(/-/g, '+').replace(/_/g, '/'));
    const body = d.split('\r\n\r\n')[1];
    expect(decodeURIComponent(escape(atob(body)))).toBe('ഹലോ ₹75');
  });
});

/* ── temporary passwords expire (B10) ────────────────────────────────────── */

describe('an issued temporary password stops working', () => {
  const hoursAgo = (h) => new Date(Date.now() - h * 3600_000).toISOString();
  const inHours = (h) => new Date(Date.now() + h * 3600_000).toISOString();

  it('expires one that is past its deadline', () => {
    expect(tempPasswordState({ must_change_pw: 1, pw_expires_at: hoursAgo(1) }).expired).toBe(true);
  });

  it('allows one still inside its window', () => {
    expect(tempPasswordState({ must_change_pw: 1, pw_expires_at: inHours(1) }).expired).toBe(false);
  });

  it('NEVER expires a password the resident chose', () => {
    // The whole check hangs off must_change_pw. Without this gate the column
    // would eventually lock out somebody whose own password predates it — the
    // one outcome this feature must not produce.
    expect(tempPasswordState({ must_change_pw: 0, pw_expires_at: hoursAgo(500) }).expired).toBe(false);
  });

  it('treats a NULL deadline as "never expires", not as "expired long ago"', () => {
    // Every row predating migration 0023 has NULL here, and some are sitting on
    // a temporary password issued weeks back. Reading NULL as expired would
    // lock all of them out on deploy — including the four committee accounts.
    expect(tempPasswordState({ must_change_pw: 1, pw_expires_at: null }).expired).toBe(false);
    expect(tempPasswordState({ must_change_pw: 1 }).expired).toBe(false);
  });

  it('expires exactly at the deadline rather than a moment after', () => {
    const now = new Date('2026-08-12T10:00:00.000Z');
    expect(tempPasswordState({ must_change_pw: 1, pw_expires_at: now.toISOString() }, now).expired)
      .toBe(true);
  });

  it('survives a row with no owner at all', () => {
    expect(tempPasswordState(null).expired).toBe(false);
    expect(tempPasswordState(undefined).expired).toBe(false);
  });

  it('issues a superadmin reset for 24 hours and a roster invite for longer', () => {
    // The gap is the decision: a reset is read within minutes by someone locked
    // out, an invite goes to 99 people who were not expecting it.
    expect(TEMP_PW_HOURS).toBe(24);
    expect(INVITE_PW_HOURS).toBeGreaterThan(TEMP_PW_HOURS);
  });

  it('computes the deadline from the hours it is given', () => {
    const now = new Date('2026-08-12T10:00:00.000Z');
    expect(tempPasswordExpiry(24, now)).toBe('2026-08-13T10:00:00.000Z');
    expect(tempPasswordExpiry(72, now)).toBe('2026-08-15T10:00:00.000Z');
  });

  it('does not tell the resident they typed it wrong', () => {
    // They typed exactly what they were sent. "Wrong password" sends them back
    // to whoever sent it; this has to send them to /forgot.
    const m = expiredPasswordMessage();
    expect(m).toMatch(/expired/i);
    expect(m).toMatch(/forgotten your password/i);
    expect(m).not.toMatch(/incorrect|wrong/i);
  });

  it('does NOT send an account with no address to /forgot', () => {
    // The closed loop this exists to end: /forgot emails a code, so with no
    // address on file it answers with the same neutral reply an unknown number
    // gets. The resident waits for a code nobody sent, and the only trace is a
    // DDP-AUTH-011 alert. Expired roster invites are mostly this case — the
    // invite is the one temporary password issued in bulk, and B5 is the count
    // of residents with no address at all.
    const m = expiredPasswordMessage(false);
    expect(m).toMatch(/expired/i);
    expect(m).not.toMatch(/forgotten your password/i);
    expect(m).toMatch(/committee/i);
    expect(m).not.toMatch(/incorrect|wrong/i);
  });

  it('still says the password expired first, whichever way out it offers', () => {
    // The opener is the part that stops them retyping it, so it must not vary.
    for (const m of [expiredPasswordMessage(true), expiredPasswordMessage(false)]) {
      expect(m.startsWith('That temporary password has expired.')).toBe(true);
    }
  });

  it('defaults to the /forgot wording, so an un-updated caller stays correct', () => {
    expect(expiredPasswordMessage()).toBe(expiredPasswordMessage(true));
  });
});

describe('the email carrying a temporary password', () => {
  const mail = tempPasswordEmail({ password: 'tiger-lamp-42', name: 'Priya', flat: '4B' });

  it('carries the password and the flat it belongs to', () => {
    expect(mail.text).toContain('tiger-lamp-42');
    expect(mail.text).toContain('4B');
  });

  it('says how long it lasts', () => {
    expect(mail.text).toContain(`${TEMP_PW_HOURS} hours`);
  });

  it('does NOT claim to be single use, because it is not', () => {
    // It is an ordinary password that happens to expire. The reset-CODE email
    // says "once" and is right to; converging the two copy would be a lie.
    expect(mail.text).not.toMatch(/\bonce\b|single use/i);
  });

  it('keeps the password out of the subject line', () => {
    // The reset code is deliberately IN its subject so it can be read from a
    // lock-screen notification. A working password must not be — a notification
    // is visible to anyone holding the handset.
    expect(mail.subject).not.toContain('tiger-lamp-42');
  });

  it('NEVER carries the temporary password in a URL', () => {
    // The sharper half of the same rule. The reset code dies in 15 minutes;
    // this is a live credential good for 24 hours, so a copy left in browser
    // history or a proxy log stays useful for as long as the password does.
    const withLink = tempPasswordEmail({ password: 'tuck-amber-91', name: 'Priya',
                                         flat: '3B', link: resetLinkUrl('c'.repeat(64)) });
    for (const body of [mail.text, mail.html, withLink.text, withLink.html]) {
      for (const url of body.match(/https?:\/\/\S+/g) ?? []) {
        expect(url).not.toContain('tuck-amber-91');
        expect(url).not.toMatch(/[?&](code|pw|password)=/);
      }
    }
  });

  it('tells somebody who did not ask that their account was reset', () => {
    // The opposite advice from the reset-code mail, and deliberately: an
    // unexpected code is ignorable, an unexpected password change is not.
    expect(mail.text).toMatch(/did not ask/i);
    expect(mail.text).toMatch(/tell the committee/i);
  });

  it('says the next step is choosing their own', () => {
    // Whitespace collapsed before matching. renderText wraps at 72 columns, so
    // a phrase asserted verbatim against the plain-text body passes or fails
    // on where the wrap happens to fall — which is layout, not meaning.
    const flat = (t) => t.replace(/\s+/g, ' ');
    expect(flat(mail.text)).toMatch(/choose your own/i);
    // And says it on the button too, when there is a link to put it on.
    expect(tempPasswordEmail({ password: 'x', name: 'Priya', flat: '3B',
                               link: resetLinkUrl('d'.repeat(64)) }).html)
      .toContain('Choose my password');
  });
});

/* ── reusing the password you already have ───────────────────────────────── */

describe('refuseCurrentPassword', () => {
  // Low, so the suite is not paying the production cost thirty times over.
  const ITER = 1000;
  const rowFor = async (password, extra = {}) => {
    const { hash, salt, iterations } = await hashPassword(password, ITER);
    return { pw_hash: hash, pw_salt: salt, pw_iterations: iterations, ...extra };
  };
  const refusal = async (pw, row) => {
    try {
      await refuseCurrentPassword(pw, row);
    } catch (err) {
      return err;
    }
    return null;
  };

  it('allows a genuinely different password', async () => {
    const row = await rowFor('harbour-lime-9182');
    await expect(refuseCurrentPassword('quiet-otter-4471', row)).resolves.toBeUndefined();
  });

  it('refuses the temporary password being kept as the permanent one', async () => {
    // The bug this closes: the forced first-login change accepted the very
    // password that was read out over the phone, and cleared must_change_pw
    // as though something had happened.
    const temp = 'pine-4417';
    const row = await rowFor(temp, { must_change_pw: 1 });

    const err = await refusal(temp, row);
    expect(err?.code).toBe('DDP-AUTH-017');
    expect(err.detail.publicMessage).toMatch(/temporary password/i);
    expect(err.detail.temporary).toBe(true);
  });

  it('refuses an admin keeping the strong temporary form', async () => {
    const temp = generateOneTimePassword({ strong: true });
    const row = await rowFor(temp, { must_change_pw: 1, role: 'admin' });
    expect((await refusal(temp, row))?.code).toBe('DDP-AUTH-017');
  });

  it('refuses re-setting the password you chose, with different wording', async () => {
    // Same refusal, different next step: nothing to look up, nothing to do.
    const row = await rowFor('harbour-lime-9182', { must_change_pw: 0 });
    const err = await refusal('harbour-lime-9182', row);
    expect(err?.code).toBe('DDP-AUTH-017');
    expect(err.detail.publicMessage).toMatch(/already your password/i);
    expect(err.detail.publicMessage).not.toMatch(/temporary/i);
  });

  it('is case- and whitespace-sensitive, like the login it mirrors', async () => {
    // Not a normalising check: `Pine-4417` really is a different password, and
    // refusing it would refuse something that logging in would not accept.
    const row = await rowFor('pine-4417', { must_change_pw: 1 });
    await expect(refuseCurrentPassword('Pine-4417', row)).resolves.toBeUndefined();
    await expect(refuseCurrentPassword('pine-4417 ', row)).resolves.toBeUndefined();
  });

  it('compares at the count that made the hash, not the current target', async () => {
    // Same trap as migration 0025. Verifying at the wrong count returns false,
    // which here means silently ALLOWING the reuse rather than locking anyone
    // out — a guard that fails open is worse than one that fails loudly.
    const { hash, salt } = await hashPassword('pine-4417', ITER);
    const row = { pw_hash: hash, pw_salt: salt, pw_iterations: ITER, must_change_pw: 1 };
    expect((await refusal('pine-4417', row))?.code).toBe('DDP-AUTH-017');
  });

  it('throws loudly when the caller did not SELECT the hash columns', async () => {
    // The silently-inert failure: a handler that forgets these columns would
    // otherwise approve every password on that path and never say so.
    // Fatal rather than a warn: it alerts, and the resident's old password
    // keeps working. A guard that cannot run must not fail open.
    for (const row of [{ role: 'owner' }, {}]) {
      const err = await refusal('anything', row);
      expect(err?.code).toBe('DDP-SYS-001');
      expect(err.detail).toMatch(/pw_hash/);
    }
  });

  it('does not put the password in the error detail', async () => {
    const row = await rowFor('pine-4417', { must_change_pw: 1 });
    const err = await refusal('pine-4417', row);
    expect(JSON.stringify(err.detail)).not.toContain('pine-4417');
  });
});

/* ── going back to a password you abandoned ──────────────────────────────── */

describe('refusePastPassword', () => {
  const ITER = 1000;
  const entry = async (password) => {
    const { hash, salt, iterations } = await hashPassword(password, ITER);
    return { pw_hash: hash, pw_salt: salt, pw_iterations: iterations };
  };
  const refusal = async (pw, history) => {
    try {
      await refusePastPassword(pw, history);
    } catch (err) {
      return err;
    }
    return null;
  };

  it('allows a password the account has never held', async () => {
    const history = [await entry('Harbour-lime-9182'), await entry('Quiet-otter-4471')];
    await expect(refusePastPassword('Third-thing-5567', history)).resolves.toBeUndefined();
  });

  it('refuses the password from one change ago', async () => {
    const history = [await entry('Harbour-lime-9182')];
    const err = await refusal('Harbour-lime-9182', history);
    expect(err?.code).toBe('DDP-AUTH-018');
  });

  it('refuses one from the far end of the window, not just the most recent', async () => {
    // The off-by-one that would make the depth a lie: checking only the newest
    // row and calling it history.
    const history = [];
    for (let i = 0; i < HISTORY_DEPTH; i++) history.push(await entry(`Password-number-${i}`));
    const err = await refusal(`Password-number-${HISTORY_DEPTH - 1}`, history);
    expect(err?.code).toBe('DDP-AUTH-018');
  });

  it('says how far back it looked, so the refusal is not arbitrary', async () => {
    const history = [await entry('Harbour-lime-9182')];
    const err = await refusal('Harbour-lime-9182', history);
    expect(err.detail.publicMessage).toMatch(new RegExp(`last ${HISTORY_DEPTH}`));
    expect(err.detail.depth).toBe(HISTORY_DEPTH);
  });

  it('verifies each row at ITS OWN iteration count', async () => {
    // The quiet direction of failure. A row written before an iteration change
    // verifies false at the current target, and false here means ALLOWING the
    // reuse — the guard would go silent rather than loud. Same trap as 0025.
    const low = await hashPassword('Harbour-lime-9182', ITER);
    const high = await hashPassword('Quiet-otter-4471', ITER * 3);
    const history = [
      { pw_hash: low.hash,  pw_salt: low.salt,  pw_iterations: low.iterations },
      { pw_hash: high.hash, pw_salt: high.salt, pw_iterations: high.iterations },
    ];
    expect((await refusal('Harbour-lime-9182', history))?.code).toBe('DDP-AUTH-018');
    expect((await refusal('Quiet-otter-4471', history))?.code).toBe('DDP-AUTH-018');
  });

  it('is not fooled by a row whose count is missing', async () => {
    // Falls back to DEFAULT_ITERATIONS, which is what every pre-0025 row was
    // written at — the same assumption migration 0025 backfilled with.
    const { hash, salt } = await hashPassword('Harbour-lime-9182');
    expect((await refusal('Harbour-lime-9182', [{ pw_hash: hash, pw_salt: salt }]))?.code)
      .toBe('DDP-AUTH-018');
  });

  it('treats an empty or absent history as nothing to refuse', async () => {
    await expect(refusePastPassword('Harbour-lime-9182', [])).resolves.toBeUndefined();
    await expect(refusePastPassword('Harbour-lime-9182')).resolves.toBeUndefined();
  });

  it('skips a malformed row instead of matching or throwing on it', async () => {
    const history = [{ pw_hash: null, pw_salt: null }, {}, await entry('Harbour-lime-9182')];
    // The good row at the end is still reached.
    expect((await refusal('Harbour-lime-9182', history))?.code).toBe('DDP-AUTH-018');
    await expect(refusePastPassword('Something-else-11', history)).resolves.toBeUndefined();
  });

  it('does not put the password in the error detail', async () => {
    const history = [await entry('Harbour-lime-9182')];
    const err = await refusal('Harbour-lime-9182', history);
    expect(JSON.stringify(err.detail)).not.toContain('Harbour-lime-9182');
  });

  it('keeps the depth small enough to be affordable', async () => {
    // Not style. Each entry is a PBKDF2 derive that cannot be batched, and
    // this number is what stops a password change becoming a CPU event. If it
    // is ever raised, it should be raised against a measurement.
    expect(HISTORY_DEPTH).toBeLessThanOrEqual(5);
  });
});

/* ── the link token ───────────────────────────────────────────────────────── */

describe('the reset link token', () => {
  it('is 256 bits of hex, because it is never typed', () => {
    const t = generateLinkToken();
    expect(t).toMatch(/^[0-9a-f]{64}$/);
  });

  it('does not repeat', () => {
    const seen = new Set(Array.from({ length: 200 }, () => generateLinkToken()));
    expect(seen.size).toBe(200);
  });

  it('hashes to a stable lookup key, and refuses anything malformed', async () => {
    const t = generateLinkToken();
    expect(await linkHash(t)).toBe(await linkHash(t));
    expect(await linkHash(t)).toMatch(/^[0-9a-f]{64}$/);
    // A hash that is not the token: the row must not hand back a working link.
    expect(await linkHash(t)).not.toBe(t);
    for (const bad of ['', null, undefined, 'nope', t.toUpperCase(), `${t}0`, t.slice(1)]) {
      expect(await linkHash(bad), String(bad)).toBeNull();
    }
  });

  it('two different tokens never collide', async () => {
    expect(await linkHash(generateLinkToken()))
      .not.toBe(await linkHash(generateLinkToken()));
  });

  it('puts the token in the query string of the ordinary /forgot page', () => {
    const t = generateLinkToken();
    const url = new URL(resetLinkUrl(t));
    expect(url.pathname).toBe('/forgot');
    expect(url.searchParams.get('t')).toBe(t);
  });

  it('honours the origin it is given, so a staging link stays on staging', () => {
    const t = 'a'.repeat(64);
    expect(resetLinkUrl(t, 'https://staging.example.test'))
      .toBe(`https://staging.example.test/forgot?t=${t}`);
    // And the production portal when nothing is passed — the 3am path.
    expect(resetLinkUrl(t)).toBe(`https://diamondpark.pages.dev/forgot?t=${t}`);
  });
});

/* ── the GET behind a link must not spend it ─────────────────────────────── */

describe('following a reset link consumes nothing', () => {
  // Asserted against the SOURCE, not by calling the handler.
  //
  // No test in this repo drives a request handler — the logic lives in lib/
  // and is tested there — so there is nowhere to observe this from the
  // outside. It is still the single security property the whole GET/POST
  // split exists for: mail scanners, link previewers and corporate proxies
  // fetch URLs out of inboxes automatically and they issue GET, so if the GET
  // completed the reset the resident would arrive at a link something else had
  // already used. A structural check is a poor substitute for exercising it,
  // and it is what can be had here; it fails loudly if anybody adds a write.
  const source = readFileSync(new URL('../functions/index.js', import.meta.url), 'utf8');
  const body = source.slice(source.indexOf('async function resetLinkState'),
                            source.indexOf('async function forgotPassword'));

  it('is wired as a GET', () => {
    expect(source).toContain("route === 'GET /api/reset/link'");
  });

  it('was found, so the rest of this describe is not vacuously true', () => {
    expect(body).toContain('resetLinkState');
    expect(body.length).toBeGreaterThan(200);
  });

  it('contains no write of any kind', () => {
    for (const write of [/\bUPDATE\b/, /\bINSERT\b/, /\bDELETE\b/, /\.batch\(/, /\.run\(/]) {
      expect(body, String(write)).not.toMatch(write);
    }
  });

  it('never returns anything a resident would type', () => {
    // The flat, yes — the page has to say which account. Not the code, and
    // not the token it was handed.
    expect(body).not.toMatch(/code_hash|link_hash\s*[,}]/);
    expect(body).toContain('flat');
  });
});
