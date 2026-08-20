import { describe, it, expect, vi, afterEach } from 'vitest';
import { buildRawMessage, sendEmail, mailToken } from '../functions/lib/mailer.js';
import {
  renderEmail, escapeHtml, subjectFor, excerpt,
  para, heading, figure, details, action, aside,
} from '../functions/lib/email-template.js';

/** Undo the base64url the Gmail API wants, back to the RFC 2822 message. */
const decode = (raw) => new TextDecoder().decode(
  Uint8Array.from(atob(raw.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)),
);

const mail = (over = {}) => buildRawMessage({
  to: 'a@b.com', from: 'ddp@gmail.com', subject: 'Hello', text: 'Body', ...over,
});

/* ── the path every existing caller is on ────────────────────────────────── */

describe('a message with no html', () => {
  it('is byte-for-byte what it was before html existed', () => {
    // Not a paraphrase of the old implementation — the literal output of it,
    // captured before the multipart branch was added. Four callers and the
    // reset tests are on this path.
    expect(mail()).toBe(
      'RnJvbTogZGRwQGdtYWlsLmNvbQ0KVG86IGFAYi5jb20NClN1YmplY3Q6IEhlbGxvDQpNSU1FLVZlcnNpb'
      + '246IDEuMA0KQ29udGVudC1UeXBlOiB0ZXh0L3BsYWluOyBjaGFyc2V0PSJVVEYtOCINCkNvbnRlbnQt'
      + 'VHJhbnNmZXItRW5jb2Rpbmc6IGJhc2U2NA0KDQpRbTlrZVE9PQ',
    );
  });

  it('stays single-part, with no boundary anywhere', () => {
    const d = decode(mail());
    expect(d).toContain('Content-Type: text/plain; charset="UTF-8"');
    expect(d).not.toContain('multipart');
    expect(d).not.toContain('boundary');
  });

  it('is unchanged by an html key that is not actually a body', () => {
    // `html: html || undefined` is how a caller will write this, and an empty
    // string must not tip the message into a multipart with a blank half.
    expect(mail({ html: undefined })).toBe(mail());
    expect(mail({ html: '' })).toBe(mail());
  });
});

/* ── the multipart the html path produces ────────────────────────────────── */

describe('a message with html', () => {
  const raw = mail({ html: '<p>Body</p>' });
  const d = decode(raw);
  const boundary = d.match(/boundary="([^"]+)"/)?.[1];

  it('is base64url, as the Gmail API requires', () => {
    expect(raw).not.toMatch(/[+/=]/);
  });

  it('declares multipart/alternative with a quoted boundary', () => {
    expect(d).toMatch(/Content-Type: multipart\/alternative; boundary="[^"]+"/);
    expect(d).toContain('MIME-Version: 1.0');
    expect(boundary).toBeTruthy();
  });

  it('carries both bodies, text first', () => {
    // `alternative` means the client shows the LAST part it can render, so
    // this order is what decides whether anyone sees the HTML.
    const parts = d.split(`--${boundary}`).slice(1, -1);
    expect(parts).toHaveLength(2);
    expect(parts[0]).toContain('Content-Type: text/plain; charset="UTF-8"');
    expect(parts[1]).toContain('Content-Type: text/html; charset="UTF-8"');
  });

  it('closes the multipart properly', () => {
    // Without the trailing `--`, clients treat the rest of the message as a
    // third part and some show the raw base64.
    expect(d.trimEnd().endsWith(`--${boundary}--`)).toBe(true);
  });

  it('base64-encodes each part rather than sending 8-bit', () => {
    for (const part of d.split(`--${boundary}`).slice(1, -1)) {
      expect(part).toContain('Content-Transfer-Encoding: base64');
      const body = part.split('\r\n\r\n')[1].trim();
      expect(body).toMatch(/^[A-Za-z0-9+/=\r\n]+$/);
    }
  });

  it('round-trips both bodies exactly', () => {
    const bodies = d.split(`--${boundary}`).slice(1, -1)
      .map((p) => atob(p.split('\r\n\r\n')[1].replace(/\r\n/g, '').trim()));
    expect(bodies[0]).toBe('Body');
    expect(bodies[1]).toBe('<p>Body</p>');
  });

  it('wraps the encoded bodies at 76 columns', () => {
    // An HTML body is thousands of characters. RFC 5321 lets an MTA enforce a
    // 998-octet line, and a base64 line broken by somebody else is a body
    // that arrives as garbage.
    const long = decode(mail({ html: `<p>${'x'.repeat(4000)}</p>` }));
    const boundary = long.match(/boundary="([^"]+)"/)[1];
    for (const part of long.split(`--${boundary}`).slice(1, -1)) {
      for (const line of part.split('\r\n\r\n')[1].trim().split('\r\n')) {
        expect(line.length).toBeLessThanOrEqual(76);
      }
    }
  });
});

describe('the boundary', () => {
  it('differs between messages', () => {
    const b = () => decode(mail({ html: '<p>x</p>' })).match(/boundary="([^"]+)"/)[1];
    expect(b()).not.toBe(b());
  });

  it('cannot collide with the content it delimits', () => {
    // The bodies are base64, and `=_` cannot occur inside base64 output — but
    // the point of the check is that nothing here relies on reading that
    // argument correctly.
    const d = decode(mail({ html: '<p>--=_dddp_pretending-to-be-a-boundary</p>' }));
    const boundary = d.match(/boundary="([^"]+)"/)[1];
    expect(d.split(`--${boundary}`)).toHaveLength(4); // preamble + 2 parts + close
  });
});

/* ── the encoding the rupee sign depends on ──────────────────────────────── */

describe('non-ASCII', () => {
  it('encodes a non-ASCII subject rather than mangling it', () => {
    const d = decode(mail({ subject: 'പാസ്‌വേഡ് ₹329', html: '<p>x</p>' }));
    expect(d).toMatch(/Subject: =\?UTF-8\?B\?/);
    const b64 = d.match(/Subject: =\?UTF-8\?B\?([^?]+)\?=/)[1];
    expect(new TextDecoder().decode(
      Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)),
    )).toBe('പാസ്‌വേഡ് ₹329');
  });

  it('leaves an ASCII subject alone, encoded-word and all', () => {
    expect(decode(mail())).toContain('Subject: Hello');
  });

  it('survives the rupee sign and Malayalam in both bodies', () => {
    const text = 'ഹലോ — ₹1,284 വരെ';
    const html = `<p>ഹലോ — ₹1,284</p>`;
    const d = decode(mail({ text, html }));
    const boundary = d.match(/boundary="([^"]+)"/)[1];
    const bodies = d.split(`--${boundary}`).slice(1, -1).map((p) => new TextDecoder().decode(
      Uint8Array.from(
        atob(p.split('\r\n\r\n')[1].replace(/\r\n/g, '').trim()),
        (c) => c.charCodeAt(0),
      ),
    ));
    expect(bodies[0]).toBe(text);
    expect(bodies[1]).toBe(html);
  });
});

/* ── the funnel ──────────────────────────────────────────────────────────── */

describe('sendEmail', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  const env = {
    GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'secret',
    GOOGLE_REFRESH_TOKEN: 'refresh', MAIL_FROM: 'ddp@gmail.com',
  };

  /** Answers the token exchange, records the message Gmail was handed. */
  const stubGmail = () => {
    const sent = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      if (String(url).includes('oauth2')) {
        return { ok: true, json: async () => ({ access_token: 'tok' }) };
      }
      sent.push(JSON.parse(init.body));
      return { ok: true, status: 200 };
    }));
    return sent;
  };

  it('passes html through to the message', async () => {
    const sent = stubGmail();
    await sendEmail(env, { to: 'r@x.in', subject: 'Hi', text: 'Body', html: '<p>Body</p>' });
    expect(decode(sent[0].raw)).toContain('multipart/alternative');
  });

  it('sends a plain-text message when given no html', async () => {
    const sent = stubGmail();
    await sendEmail(env, { to: 'r@x.in', subject: 'Hi', text: 'Body' });
    expect(decode(sent[0].raw)).toContain('Content-Type: text/plain');
    expect(decode(sent[0].raw)).not.toContain('multipart');
  });

  it('mints its own token when not given one', async () => {
    // Every single-message caller is on this path and must stay on it.
    const sent = stubGmail();
    await sendEmail(env, { to: 'r@x.in', subject: 'Hi', text: 'Body' });
    expect(globalThis.fetch.mock.calls.map(([u]) => String(u).includes('oauth2')))
      .toEqual([true, false]);
    expect(sent).toHaveLength(1);
  });

  it('spends a token it is handed instead of minting another', async () => {
    const sent = stubGmail();
    await sendEmail(env, { to: 'r@x.in', subject: 'Hi', text: 'Body' }, 'already-have-one');
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(globalThis.fetch.mock.calls[0][1].headers.authorization)
      .toBe('Bearer already-have-one');
    expect(sent).toHaveLength(1);
  });

  it('keeps a batch of 89 inside the subrequest cap', async () => {
    // THE ARITHMETIC IS THE POINT. Publishing a month mails every flat with an
    // address. At two subrequests a message that is 178 against a cap of 50
    // (docs/COSTS.md) and the send dies around the twenty-fifth flat, having
    // already told two dozen residents their bill is ready.
    const sent = stubGmail();
    const auth = await mailToken(env);
    expect(auth.ok).toBe(true);

    for (let i = 0; i < 89; i++) {
      await sendEmail(env, { to: `f${i}@x.in`, subject: 'Bill', text: 'B' }, auth.token);
    }

    expect(sent).toHaveLength(89);
    expect(globalThis.fetch).toHaveBeenCalledTimes(90);  // 89 sends + 1 refresh
    expect(globalThis.fetch.mock.calls.filter(([u]) => String(u).includes('oauth2')))
      .toHaveLength(1);
  });

  it('still refuses to throw when Gmail refuses the send', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url) => (String(url).includes('oauth2')
      ? { ok: true, json: async () => ({ access_token: 'tok' }) }
      : { ok: false, status: 403 })));
    await expect(sendEmail(env, { to: 'r@x.in', subject: 'Hi', text: 'B', html: '<p>B</p>' }))
      .resolves.toEqual({ sent: false, reason: 'gmail-403' });
  });

  it('says so when the mailbox is not configured, before any network', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await sendEmail({}, { to: 'r@x.in', subject: 'Hi', text: 'B', html: '<p>B</p>' }))
      .toEqual({ sent: false, reason: 'not-configured' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

/* ── the template ────────────────────────────────────────────────────────── */

describe('renderEmail', () => {
  const message = renderEmail({
    title: 'your July 2026 gas bill',
    preview: '₹1,284 due by 10 August',
    blocks: [
      para('Hello Priya,'),
      heading('This month'),
      figure('₹1,284', 'due by 10 August 2026'),
      details([['Flat', 'A-204'], ['Units', '31']]),
      action('View your bill', 'https://diamondpark.pages.dev/dashboard'),
      aside('If this looks wrong, tell the committee.'),
    ],
  });

  it('produces both bodies and a subject from one description', () => {
    // The reason the block list exists: written by hand twice, the two bodies
    // drift, and a resident is eventually told an amount that is not theirs.
    expect(message.subject).toBe('Diamond Park — your July 2026 gas bill');
    expect(message.html).toContain('your July 2026 gas bill');
    expect(message.html).toContain('<!DOCTYPE html>');
    expect(message.text).not.toContain('<');
  });

  it('carries every value into both bodies', () => {
    for (const value of ['₹1,284', 'A-204', '31', 'Hello Priya,']) {
      expect(message.html, `html: ${value}`).toContain(value);
      expect(message.text, `text: ${value}`).toContain(value);
    }
  });

  it('puts the link in the text body as a URL somebody can copy', () => {
    expect(message.text).toContain('https://diamondpark.pages.dev/dashboard');
  });

  it('signs both bodies as the association', () => {
    expect(message.text).toContain("DD Diamond Park Residents' Welfare Association");
    // The apostrophe stays an apostrophe: escapeHtml leaves it alone, and
    // every attribute here is double-quoted, so nothing can escape one.
    expect(message.html).toContain("DD Diamond Park Residents' Welfare Association");
  });

  it('styles inline only — Gmail keeps nothing else', () => {
    expect(message.html).not.toMatch(/<style[\s>]/i);
    expect(message.html).not.toMatch(/<link[\s>]/i);
    expect(message.html).toMatch(/style="[^"]+"/);
  });

  it('lays out in tables, because Outlook has no flexbox', () => {
    expect(message.html).toContain('role="presentation"');
    expect(message.html).not.toMatch(/display:\s*flex/);
    expect(message.html).not.toMatch(/display:\s*grid/);
  });

  it('caps the width at something a reading pane can show', () => {
    expect(message.html).toContain('max-width:600px');
  });

  it('names the association in the subject but not the headline', () => {
    // The banner inside the message already says DD DIAMOND PARK. In the inbox
    // list nothing does, and "Payment received for July 2026" from an unknown
    // address is the kind of mail people delete.
    expect(subjectFor('Payment received')).toBe('Diamond Park — Payment received');
    expect(message.html).not.toContain('Diamond Park — your July 2026 gas bill');
  });

  it('does not prefix a subject that already carries the name', () => {
    // Every subject written before this helper existed starts with the prefix,
    // and "Diamond Park — Diamond Park — ..." is how that would surface.
    const already = 'Diamond Park — gas bill for July 2026 is unpaid';
    expect(subjectFor(already)).toBe(already);
    expect(subjectFor(subjectFor('a bill'))).toBe('Diamond Park — a bill');
  });

  it('escapes what a resident typed rather than rendering it', () => {
    // A flat's "name" is free text an admin can set, and a stray `<` in it
    // must not become markup — nor silently vanish from the message.
    const injected = renderEmail({
      title: 'Bill for <b>A-204</b>',
      blocks: [para('Owner: Ann & "Bob" <script>alert(1)</script>')],
    });
    expect(injected.html).not.toContain('<script>');
    expect(injected.html).toContain('&lt;script&gt;');
    expect(injected.html).toContain('Ann &amp; &quot;Bob&quot;');
    expect(injected.text).toContain('Ann & "Bob"');
  });

  it('escapes the four characters that matter and nothing else', () => {
    expect(escapeHtml('₹ & < > " ഹ')).toBe('₹ &amp; &lt; &gt; &quot; ഹ');
  });

  it('survives being handed to the mailer', () => {
    const d = decode(buildRawMessage({
      to: 'r@x.in', from: 'ddp@gmail.com', ...message,
    }));
    expect(d).toContain('multipart/alternative');
    expect(d).toMatch(/Subject: =\?UTF-8\?B\?/); // the em dash in the title
  });
});

/* ── the notice excerpt ──────────────────────────────────────────────────── */

describe('excerpt', () => {
  const long = `The overhead tanks will be cleaned on Sunday 24 August. ${'Water supply will be off. '.repeat(20)}`;

  it('leaves a short notice whole, and says it did', () => {
    expect(excerpt('Supply off 9am to 2pm.')).toEqual({
      text: 'Supply off 9am to 2pm.', truncated: false,
    });
  });

  it('cuts a long notice down and says it did', () => {
    const { text, truncated } = excerpt(long);
    expect(truncated).toBe(true);
    expect(text.length).toBeLessThanOrEqual(281);
    expect(text.endsWith('\u2026')).toBe(true);
  });

  it('never cuts a word in half', () => {
    // A notice sliced mid-word gets reported as a bug, not read as an excerpt.
    for (let limit = 20; limit < 120; limit++) {
      const { text } = excerpt(long, limit);
      const lastWord = text.replace(/\u2026$/, '').split(' ').pop();
      expect(long, `limit ${limit}`).toContain(lastWord);
    }
  });

  it('does not leave a dangling comma or dash before the ellipsis', () => {
    // The cut lands just after "Sunday," — the comma has to go with it.
    expect(excerpt('Cleaning is on Sunday, and the supply is off.', 22).text)
      .toBe('Cleaning is on Sunday\u2026');
  });

  it('strips the markdown a notice body is written in', () => {
    // Notice bodies are the subset in public/js/markdown.js. Four asterisks
    // arriving in an inbox is how a committee stops trusting the mail.
    expect(excerpt('**Sunday** the *overhead* tanks').text).toBe('Sunday the overhead tanks');
    expect(excerpt('See [the schedule](https://x.test/s) first').text)
      .toBe('See the schedule first');
    expect(excerpt('- tank A\n- tank B').text).toBe('tank A tank B');
  });

  it('collapses the newlines a paragraph break leaves behind', () => {
    expect(excerpt('First para.\n\nSecond para.').text).toBe('First para. Second para.');
  });
});

/* ── the token a bulk send spends ────────────────────────────────────────── */

describe('mailToken', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  const env = {
    GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'secret',
    GOOGLE_REFRESH_TOKEN: 'refresh', MAIL_FROM: 'ddp@gmail.com',
  };

  it('mints one token with one subrequest', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ access_token: 'tok' }) })));
    expect(await mailToken(env)).toEqual({ ok: true, token: 'tok' });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('says so when the mailbox is not configured, before any network', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await mailToken({})).toEqual({ ok: false, reason: 'not-configured' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses to throw when the refresh fails', async () => {
    // Same contract as sendEmail. A publish that cannot get a token has to
    // report it, not take the request down mid-batch.
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));
    const result = await mailToken(env);
    expect(result.ok).toBe(false);
    expect(result.token).toBeUndefined();
  });

  it('reports a refused refresh in sendEmail\'s vocabulary', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 400, text: async () => 'bad' })));
    const result = await mailToken(env);
    expect(result.ok).toBe(false);
    expect(typeof result.reason).toBe('string');
  });
});
