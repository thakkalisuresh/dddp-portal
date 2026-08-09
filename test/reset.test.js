import { describe, it, expect } from 'vitest';
import {
  generateCode, normaliseCode, canIssue, resetState, failureMessage,
  validateNewPassword, resetEmail, neutralReply,
  CODE_LENGTH, MAX_ATTEMPTS, MAX_PER_HOUR, EXPIRY_MINUTES,
} from '../functions/lib/reset.js';
import { buildRawMessage } from '../functions/lib/mailer.js';

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
    expect(() => validateNewPassword('short')).toThrow(/DDP-AUTH-008/);
    expect(() => validateNewPassword('')).toThrow(/DDP-AUTH-008/);
  });

  it('accepts a reasonable one unchanged', () => {
    expect(validateNewPassword('correct horse battery')).toBe('correct horse battery');
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

  it('contains NO reset link', () => {
    // A link in an email is a bearer token that survives in inboxes and
    // forwards, and some scanners follow links automatically — which would
    // consume the reset before the resident ever saw it.
    const body = mail.text;
    const links = body.match(/https?:\/\/\S+/g) ?? [];
    expect(links).toEqual(['https://diamondpark.pages.dev/forgot']);
    expect(body).not.toMatch(/token|\?code=|reset\/[A-Za-z0-9]/);
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
