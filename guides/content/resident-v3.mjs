/**
 * The resident guide.
 *
 * NUMBERS ONLY WHERE THE PICTURE IS NUMBERED. Steps used to be numbered on
 * every page while only three captures actually carry badges, so on most pages
 * "step 2" pointed at nothing. A numbered list here means the figure beside it
 * has a matching badge, measured by lib/measure.mjs. Everywhere else the list
 * is unnumbered, because it is describing a screen rather than sequencing taps.
 *
 * NO FIGURES IN THE PROSE. The screenshots show one flat's August bill; the
 * guide is read by 99 flats in whatever month it reaches them. Amounts and
 * dates belong in the picture, where they are visibly an example, and never in
 * a heading.
 *
 * COPY RULES, from the research rather than from taste:
 *   · sentences near 15 words, one idea each
 *   · NO CONTRACTIONS AT ALL — not even "you'll". The Home Office found these
 *     measurably harder for readers with limited English, and a good number of
 *     residents here read Malayalam more comfortably.
 *   · no phrasal verbs where one word will do: "complete", not "fill in"
 *   · no idiom. It does not survive translation, and a Malayalam pass is
 *     planned (docs/BACKLOG.md B2)
 *   · the committee, never an individual's name. People leave committees;
 *     a reprint should not be needed when they do.
 */
import { device, androidChooser, gpayScreen } from '../lib/device.mjs';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export const t = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');

let SHOTS = {};
export const useShots = (s) => { SHOTS = s; };
const shot = (name) => {
  const s = SHOTS[name];
  if (!s) throw new Error(`no capture "${name}" — run node guides/measure-sim.mjs`);
  return s;
};

const sheet = (body, { cls = '', id = '' } = {}) =>
  `<section class="sheet ${cls}"${id ? ` id="${id}"` : ''}>${body}</section>`;
const link = (href, text) => `<a href="${href}">${t(text)}</a>`;
const WEB = 'https://diamondpark.pages.dev';

/**
 * The website contact's WhatsApp number, in international form without the +.
 * Not committed: it is a personal number, and a PDF that reaches 99 flats is
 * forwarded onward forever. Set it at build time:
 *
 *   GUIDE_WHATSAPP=91XXXXXXXXXX node guides/build-guide.mjs
 *
 * Without it the name still appears; only the link is dropped, and the build
 * says so rather than shipping a dead link.
 */
const WHATSAPP = (() => {
  const raw = process.env.GUIDE_WHATSAPP;
  if (!raw) return null;
  // wa.me wants bare international digits: no +, no 00 prefix, no spaces.
  // Accepting the forms people actually paste is cheaper than a dead link.
  const digits = raw.replace(/[^\d]/g, '').replace(/^00/, '');
  return digits.length >= 10 ? digits : null;
})();

/** Numbered — only for a figure whose badges match. */
const steps = (rows) => `<ol class="steps">${rows.map(([b, r], i) =>
  `<li><span class="n">${i + 1}</span><span><b>${t(b)}</b>${r ? ` <span class="r">${t(r)}</span>` : ''}</span></li>`).join('')}</ol>`;

/** Unnumbered — for describing a screen rather than sequencing taps. */
const points = (rows) => `<ul class="points">${rows.map(([b, r]) =>
  `<li><b>${t(b)}</b>${r ? ` <span class="r">${t(r)}</span>` : ''}</li>`).join('')}</ul>`;

/**
 * Markup that is already markup.
 *
 * `t()` escapes, which is right for copy and wrong for a paragraph that has had
 * a link built into it: `${link(...)}` inside a box came out as literal
 * `<a href="...">` text on the page. Silent, and it shipped — the resident
 * guide carries two of them. Wrap generated HTML in `html()` and it is passed
 * through instead of escaped.
 */
const html = (s) => ({ __html: String(s) });
const para = (p) => (p && p.__html !== undefined ? p.__html : t(p));

const box = (lab, ...ps) =>
  `<div class="box"><span class="lab">${t(lab)}</span>${ps.map((p) => `<p>${para(p)}</p>`).join('')}</div>`;
const warn = (lab, ...ps) =>
  `<div class="box box--warn"><span class="lab">${t(lab)}</span>${ps.map((p) => `<p>${para(p)}</p>`).join('')}</div>`;
// The dek is not escaped: it is authored copy, and it is the one slot that
// routinely carries a built link. Escaping it printed `<a href="...">` on the
// page of the guide that tells a resident where to sign in.
const head = (kick, h1, dek) =>
  `<p class="kick">${t(kick)}</p><h1>${t(h1)}</h1>${dek ? `<p class="dek">${dek}</p>` : ''}`;
const row = (...figs) => `<div class="dev-row">${figs.join('')}</div>`;

/* ── paying ──────────────────────────────────────────────────────────
   The platform difference is only the FIRST step: Android asks which app,
   an iPhone opens one directly. Everything after that is identical, so it
   is documented once rather than twice. */

const androidPanel = (mm) => `
  ${steps([
    ['Open your bill and tap Pay.', 'The wide green button carries the amount.'],
    ['Your phone asks which app to use.', 'Tap the app you already have, then Just once.'],
  ])}
  ${row(
    // Both figures are the ANDROID capture. The first draft put an iPhone
    // screenshot on the Android page, which is exactly the confusion this page
    // exists to remove.
    device(shot('and-01-pay'), {
      screenMm: mm, only: [1], railMm: 9,
      url: 'diamondpark.pages.dev', urlAt: 'top',
    }),
    device(shot('and-01-pay'), {
      screenMm: mm, rail: false, scrim: true, sheet: androidChooser(),
      url: 'diamondpark.pages.dev', urlAt: 'top',
    }),
  )}
  <p class="cap">The bill, then the app chooser. The chooser is drawn, not photographed.</p>`;

const iosPanel = (mm) => `
  ${steps([
    ['Open your bill.', 'An iPhone lists the apps instead of showing one Pay button.'],
    ['Tap your app in the list.', 'It opens that app immediately. Your phone does not ask which one.'],
  ])}
  ${device(shot('ios-01-bill-pay'), { screenMm: mm, only: [1, 2], railMm: 11, url: 'diamondpark.pages.dev' })}`;

const appPanel = (mm) => `
  ${steps([
    ['Check the amount and the reference, then pay.', 'Both are already entered. You add only your UPI PIN.'],
    ['Return to the portal and send the receipt.', 'Tap "Already paid? Upload screenshot", then choose the screenshot your app saved.'],
  ])}
  ${row(
    device({ w: 1206, h: 2622 }, { screenMm: mm, rail: false, draw: gpayScreen() }),
    device(shot('ios-04-proof'), { screenMm: mm, rail: false, url: 'diamondpark.pages.dev' }),
  )}
  <p class="cap">Google Pay, drawn rather than photographed. PhonePe and Paytm ask for the same two things.</p>`;

export function pages({ version, date, trim }) {
  const a5 = trim === 'a5';
  const single = a5 ? 38 : 46;   // one phone on the page
  const pair = a5 ? 30 : 38;     // two phones side by side
  const out = [];

  /* 1 · cover. Page numbers are hard-coded, which is safe only because the
     build asserts one page per section and fails when any section overruns. */
  out.push(sheet(`
    <p class="assoc">DD Diamond Park · Residents' Welfare Association</p>
    <h1>Your residents' association portal</h1>
    <p class="sub">Your gas bill, notices from the committee, and your own details — all from your phone.</p>
    <div class="contents">
      ${[
        ['2', 'Signing in', 'p2'],
        ['3', 'What the bill screen shows', 'p3'],
        ['4', 'How the amount is worked out', 'p4'],
        ['5', 'Paying on an Android phone', 'p5'],
        ['6', 'Paying on an iPhone', 'p6'],
        ['7', 'Paying in the app, and the receipt', 'p7'],
        ['8', 'If the app does not open', 'p8'],
        ['9', 'Notices from the committee', 'p9'],
        ['10', 'Correcting your details', 'p10'],
        ['11', 'Common questions', 'p11'],
        ['12', 'Who to ask', 'p12'],
      ].map(([n, title, id]) =>
        `<a class="c-row" href="#${id}"><span class="c-n">${n}</span><span>${t(title)}</span></a>`).join('')}
    </div>
    <div class="stamp">
      <span>Kuriachira, Thrissur 680006, Kerala</span>
      <span>${link(WEB, 'diamondpark.pages.dev')}</span>
      <span>Version ${esc(version)} · ${esc(date)}</span>
    </div>`, { cls: 'cover' }));

  /* 2 · signing in */
  out.push(sheet(`
    ${head('Getting started', 'Signing in', `Go to ${link(WEB, 'diamondpark.pages.dev')} on your phone. Sign in with the mobile number the association has for your flat, or with your email.`)}
    ${device(shot('ios-login'), { screenMm: single - 9, railMm: 11, url: 'diamondpark.pages.dev' })}
    <div class="after">
    ${steps([
      ['Enter your mobile number or email.', 'The number on the association list for your flat.'],
      ['Enter your password.', 'Tap Show to check what you entered.'],
      ['Tap Log in.', ''],
    ])}</div>
    ${box('The first time',
      'You receive a temporary password. Use it soon, because it expires.',
      'Living outside India? Include your country code, as the screen suggests.')}`, { id: 'p2' }));

  /* 3 · the bill screen */
  out.push(sheet(`
    ${head('Your bill', 'What the bill screen shows', 'This is the first screen after you sign in. The amount at the top is what you owe this month.')}
    ${device(shot('ios-01-bill-pay'), { screenMm: single, rail: false, url: 'diamondpark.pages.dev' })}
    <div class="after">
    ${points([
      ['The month', 'which bill you are looking at.'],
      ['The amount', 'everything owed for that month.'],
      ['The date to pay by', 'shown under the amount.'],
      ['A late fee warning', 'when one applies, naming the date the fee starts.'],
    ])}</div>
    ${box('Unpaid does not mean overdue',
      'A bill reads Unpaid from the day it is published. It becomes late only after the date shown under the amount.')}`, { id: 'p3' }));

  /* 4 · the arithmetic */
  out.push(sheet(`
    ${head('The arithmetic', 'How the amount is worked out', 'Scroll down on the same screen. The portal shows every number it used.')}
    ${device(shot('ios-02-scroll1'), { screenMm: single, rail: false, url: 'diamondpark.pages.dev' })}
    <div class="after">
      <p>Your gas used, multiplied by the rate for gas that month. The example above is one flat in one month; yours will differ.</p>
    </div>
    ${box('The meter readings are listed too',
      'Every month is shown with the date it was read and the meter number. If a reading looks wrong, that is the number to quote.')}`, { id: 'p4' }));

  /* 5 · Android */
  out.push(sheet(`
    ${head('Paying', 'Paying on an Android phone', 'Your phone asks which UPI app to use.')}
    ${androidPanel(pair)}
    ${box('Then carry on', 'Page 7 covers what happens inside the app, and how to send the receipt.')}`, { id: 'p5' }));

  /* 6 · iPhone */
  out.push(sheet(`
    ${head('Paying', 'Paying on an iPhone', 'It opens the UPI app directly. There is no question about which app to use.')}
    ${iosPanel(single)}
    <div class="after">
    ${box('Then carry on', 'Page 7 covers what happens inside the app, and how to send the receipt.')}</div>`, { id: 'p6' }));

  /* 7 · inside the app, then the receipt — the same on both phones */
  out.push(sheet(`
    ${head('Paying', 'Paying in the app, and the receipt', 'From here both phones behave the same way.')}
    ${appPanel(pair)}
    ${warn('The bill stays Unpaid until you send the receipt',
      'Paying is not the last step. Upload the screenshot, and the committee confirms it within a few days.')}`, { id: 'p7' }));

  /* 8 · the failure path */
  out.push(sheet(`
    ${head('If the app does not open', 'Nothing happened when I tapped', 'Some UPI apps refuse a link that comes from a browser. The portal notices and shows two routes that always work.')}
    ${device(shot('and-03-fallback'), { screenMm: single, rail: false })}
    <div class="after">
    ${points([
      ['Scan the QR code', 'with any UPI app. You can also screenshot it and scan from your gallery.'],
      ['Or copy the UPI ID and the reference', 'each has a Copy button. Paste both into your own app.'],
    ])}</div>
    ${warn('The reference matters',
      'Under "Pay another way" there is a short reference such as (2B_09_08_26). Copy it exactly. It is how your flat is matched to the payment.')}`, { id: 'p8' }));

  /* 9 · notices */
  out.push(sheet(`
    ${head('Notices', 'Notices from the committee', 'Tap **Notices** at the bottom of the screen. This is where the committee posts anything the building needs to know.')}
    ${device(shot('ios-05-notices'), { screenMm: single, rail: false, url: 'diamondpark.pages.dev' })}
    <div class="after">
    ${points([
      ['Parking, maintenance, celebrations', 'anything that used to go on the notice board.'],
      ['Some notices accept a reply', 'when they do, a reply box appears at the bottom of the notice.'],
      ['Nothing expires', 'an old notice stays readable, so you can check what was agreed.'],
    ])}</div>`, { id: 'p9' }));

  /* 10 · details */
  out.push(sheet(`
    ${head('Your details', 'Correcting your details', 'Tap **Me** at the bottom of the screen.')}
    ${device(shot('ios-06-me'), { screenMm: single, rail: false, url: 'diamondpark.pages.dev' })}
    <div class="after">
    ${points([
      ['Your name and email', 'you can change these yourself. Tap Save when you finish.'],
      ['Your flat and mobile number', 'greyed out, because the committee sets them. If either is wrong, tell the committee.'],
      ['Change password', 'further down the same screen.'],
    ])}</div>
    ${box('Add your email',
      'Without an email on your account, the portal cannot reset your password for you. The committee has to do it instead.')}`, { id: 'p10' }));

  /* 11 · FAQ */
  out.push(sheet(`
    ${head('Questions', 'Common questions', '')}
    <div class="faq">
      ${[
        ['I have forgotten my password.',
         `Tap ${link(WEB + '/forgot', 'Forgotten your password?')} under the Log in button. If your account has no email, ask the committee to set a new one.`],
        ['The screen says my number is not registered.',
         'The association has a different number for your flat. Ask the committee which one, or ask them to change it.'],
        ['My temporary password has expired.',
         'Temporary passwords do not last. Ask the committee for a new one.'],
        ['I paid, but the bill still says Unpaid.',
         'Upload the payment screenshot. The bill changes only after the committee confirms it, which takes a few days.'],
        ['It says the amount does not match.',
         'The receipt is for a different figure. Check that you paid the amount on the bill, including any late fee.'],
        ['It says the screenshot was already uploaded.',
         'You sent this one before. Nothing is wrong. The committee already has it.'],
        ['I think the reading is wrong.',
         'Every reading is listed with the date it was taken. Quote that date and number to the committee.'],
      ].map(([q, a]) => `<div class="faq-item"><div class="q">${t(q)}</div><div class="a">${a}</div></div>`).join('')}
    </div>`, { id: 'p11' }));

  /* 12 · who to ask */
  out.push(sheet(`
    ${head('Help', 'Who to ask', 'Everything goes to the committee. It helps to say which of the two it is.')}
    <div class="ask">
      <div class="ask-card">
        <div class="who">About your bill</div>
        <div class="what">The amount, the meter reading, a late fee, or a payment that has not been confirmed. The treasurer handles these.</div>
      </div>
      <div class="ask-card">
        <div class="who">About the website</div>
        <div class="what">You cannot sign in, a page does not load, or the upload keeps failing.<br>
          <b>Sabarish, flat 4A</b>${WHATSAPP ? ` — ${link('https://wa.me/' + WHATSAPP, 'message on WhatsApp')}` : ''}</div>
      </div>
    </div>
    ${box('Corrections take a few days',
      'A change to a bill needs two other committee members to agree. The late fee is paused while everyone decides.')}
    ${box('Where to find it', html(`${link(WEB, 'diamondpark.pages.dev')} — the same address every month. Save it once.`))}`, { id: 'p12' }));

  return out;
}

/* ── the A6 card, a separate document ───────────────────────────────── */
export function cardPages() {
  return [sheet(`
    <div>
      <h1>Your association portal</h1>
      <p class="dek">Every month, in four steps.</p>
      ${steps([
        ['Sign in with your mobile number.', ''],
        ['Check the amount and the date.', ''],
        ['Pay with any UPI app.', ''],
        ['Upload the payment screenshot.', ''],
      ])}
    </div>
    <div class="rule">
      <h2>Ask the committee</h2>
      <div class="ask">
        <div class="ask-card">
          <div class="who">About your bill</div>
          <div class="what">The amount, the reading, a late fee.</div>
        </div>
        <div class="ask-card">
          <div class="who">About the website</div>
          <div class="what">Cannot sign in. Page will not load. Upload fails.<br>
            <b>Sabarish, flat 4A</b>${WHATSAPP ? ` · ${link('https://wa.me/' + WHATSAPP, 'WhatsApp')}` : ''}</div>
        </div>
      </div>
      <p class="url">diamondpark.pages.dev</p>
      <p class="fine">Pay the exact amount and leave the reference unchanged. That is how your flat is matched.</p>
    </div>`)];
}
