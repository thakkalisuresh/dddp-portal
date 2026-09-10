/**
 * The committee guides.
 *
 * DRAFT. Not signed off by the committee, and expected to change — wording,
 * section order and page count are all still open. Nothing here should be
 * printed as a run or circulated as the association's documentation yet.
 *
 * THREE DOCUMENTS, ONE SOURCE. `spinePages()` is the month start to finish,
 * read once by somebody who has just joined. `sheetPages(id)` is one screen on
 * its own, kept beside the person working it. `fullPages()` composes both into
 * a single handbook. Nothing is written twice, so a correction made once
 * appears in every document that carries it.
 *
 * NOT A GAS DOCUMENT. Gas is the first thing the association bills through the
 * portal and it will not be the last, so the framing is the portal and the
 * committee's work in it. Metered consumption appears where it is genuinely the
 * subject, and nowhere else.
 *
 * WHAT IS IN THE NAVIGATION, verified against public/js/admin-console.js:63.
 * Home · Billing · Bills · Proofs · Reconcile · Residents. Rates and Readings
 * are NOT separate tabs; they are steps 1 and 2 of Billing, and /admin/readings
 * is now a redirect that is kept only "for a release or two". Roster and Errors
 * carry `superadmin: true`, so a committee admin never sees them and they are
 * absent here. God mode is absent for the same reason.
 *
 * COPY RULES, from the research rather than from taste:
 *   · sentences near 15 words, one idea each
 *   · NO CONTRACTIONS AT ALL. The Home Office found them measurably harder for
 *     readers with limited English.
 *   · no idiom, because a Malayalam pass is planned (docs/BACKLOG.md B2)
 *   · roles, never names. The administrator is the single exception: he is
 *     named in the portal's own copy (public/js/contact.js) because "the
 *     superadmin" is a database role nobody in the building uses.
 *   · NO FIGURES IN THE PROSE. Amounts and dates belong in the picture, where
 *     they are visibly an example.
 *   · NUMBERS ONLY WHERE THE PICTURE IS NUMBERED. A numbered list means the
 *     figure beside it carries badges measured by lib/portal.mjs.
 */
import { device } from '../lib/device.mjs';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export const t = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');

let SHOTS = {};
export const useShots = (s) => { SHOTS = s; };

const WEB = 'https://diamondpark.pages.dev';
const link = (href, text) => `<a href="${href}">${t(text)}</a>`;

/** The administrator, named in the portal's own copy. */
const ADMIN_NAME = 'Sabarish, flat 4A';

/**
 * Markup that is already markup.
 *
 * `t()` escapes, which is right for copy and wrong for a paragraph that has had
 * a link built into it: `${link(...)}` inside a box came out as literal
 * `<a href="...">` text on the page. Silent, and it shipped in both guides.
 * Wrap generated HTML in `html()` and it is passed through instead.
 */
const html = (s) => ({ __html: String(s) });
const para = (p) => (p && p.__html !== undefined ? p.__html : t(p));

/**
 * Figure sizes, in millimetres of SCREEN width.
 *
 * These were roughly half this, and every page carried a band of dead paper
 * under it. A figure is the reason a page exists; it should be the largest
 * thing on the page rather than a thumbnail beside the words.
 *
 * `screen` frames a whole phone screen, which is tall — about 2.16 times its
 * width once the bezel is on. `detail` frames a cropped panel, which is
 * squatter and can therefore run wider. `row` is a single list row, which is
 * wider still.
 */
const SIZES = {
  // `tall` is for the two crops that are nearly a full screen high — the
  // readings grid and the publish summary. At `detail` width they run past the
  // foot of an A5 page and take their section onto a second sheet, which is
  // the one failure the build refuses to ship. Sizing those two separately
  // keeps every other figure as large as it can be.
  a5: { screen: 46, detail: 54, tall: 40, row: 84 },
  phone: { screen: 42, detail: 50, tall: 36, row: 68 },
};

/**
 * A figure.
 *
 * Handles the placeholder manifest the build substitutes under
 * GUIDE_PLACEHOLDER, so pagination can be checked before anybody has a login to
 * capture with. A placeholder is drawn as a hatched box naming the capture it
 * stands in for — it can never be mistaken for a screenshot.
 */
const fig = (name, opts = {}) => {
  const s = SHOTS[name];
  if (!s) throw new Error(`no capture "${name}" — run node guides/capture.mjs --admin-phone`);
  if (s.placeholder) {
    return device({ w: 390, h: 844, marks: [] }, {
      ...opts, rail: false, draw: `<div class="ph">${esc(name)}<br>placeholder</div>`,
    });
  }
  return device(s, opts);
};

const sheet = (body, { cls = '', id = '' } = {}) =>
  `<section class="sheet ${cls}"${id ? ` id="${id}"` : ''}>${body}</section>`;

/** Numbered — only for a figure whose badges match. */
const steps = (rows) => `<ol class="steps">${rows.map(([b, r], i) =>
  `<li><span class="n">${i + 1}</span><span><b>${t(b)}</b>${r ? ` <span class="r">${t(r)}</span>` : ''}</span></li>`).join('')}</ol>`;

/** Unnumbered — for describing a screen rather than sequencing taps. */
const points = (rows) => `<ul class="points">${rows.map(([b, r]) =>
  `<li><b>${t(b)}</b>${r ? ` <span class="r">${t(r)}</span>` : ''}</li>`).join('')}</ul>`;

const box = (lab, ...ps) =>
  `<div class="box"><span class="lab">${t(lab)}</span>${ps.map((p) => `<p>${para(p)}</p>`).join('')}</div>`;
const warn = (lab, ...ps) =>
  `<div class="box box--warn"><span class="lab">${t(lab)}</span>${ps.map((p) => `<p>${para(p)}</p>`).join('')}</div>`;
// The dek is not escaped: it is authored copy and routinely carries a link.
const head = (kick, h1, dek) =>
  `<p class="kick">${t(kick)}</p><h1>${t(h1)}</h1>${dek ? `<p class="dek">${dek}</p>` : ''}`;

/**
 * The spine's sections, in order, once.
 *
 * Both covers are built from this. They used to carry hard-coded page numbers,
 * which is safe only while the build asserts one page per section — and stops
 * being safe the moment a second document reuses the same sections at
 * different page numbers.
 */
const SPINE_SECTIONS = [
  ['What the committee can do', 's2'],
  ['The console', 's3'],
  ['The dashboard', 's4'],
  ['Setting the rate', 's5'],
  ['Importing readings', 's6'],
  ['Entering readings by hand', 's7'],
  ['Reviewing and publishing', 's8'],
  ['Payment verification', 's9'],
  ['Payment reminders', 's10'],
  ['Approvals and permissions', 's11'],
  ['Where to look next', 's12'],
];

/** A contents block: [page number, title, anchor] rows. */
const contents = (rows) => `<div class="contents">${rows.map(([n, title, id]) =>
  `<a class="c-row" href="#${id}"><span class="c-n">${esc(String(n))}</span><span>${t(title)}</span></a>`).join('')}</div>`;

/* ── the spine ──────────────────────────────────────────────────────── */

export function spinePages({ version, date, trim }) {
  const a5 = trim === 'a5';
  const z = a5 ? SIZES.a5 : SIZES.phone;
  const out = [];

  out.push(sheet(`
    <p class="assoc">DD Diamond Park · Residents' Welfare Association</p>
    <h1>Committee handbook</h1>
    <p class="sub">How the committee runs the association portal: billing,
      payments, residents and notices.</p>
    ${contents(SPINE_SECTIONS.map(([title, id], k) => [k + 2, title, id]))}
    <div class="stamp">
      <span>Kuriachira, Thrissur 680006, Kerala</span>
      <span>${link(WEB, 'diamondpark.pages.dev')}</span>
      <span>Version ${esc(version)} · ${esc(date)}</span>
    </div>`, { cls: 'cover' }));

  out.push(...bodySections(z));

  out.push(sheet(`
    ${head('Reference', 'Where to look next',
      'Each screen has its own sheet with the detail.')}
    ${points(SHEETS.map(({ title, dek }) => [title, dek]))}
    ${box('About a bill',
      'The amount, a meter reading, a late fee, or a payment not yet confirmed. These go to the committee member responsible for gas.')}
    ${box('About the portal itself',
      html(`A page will not load, or the console will not open at all.<br><b>${t(ADMIN_NAME)}</b>${WHATSAPP ? ` — ${link('https://wa.me/' + WHATSAPP, 'message on WhatsApp')}` : ''}`))}
    ${box('Where to find it', html(`${link(WEB, 'diamondpark.pages.dev')} — the same address every month.`))}`,
  { id: 's12' }));

  return out;
}

/** Sections 2 to 11, shared by the spine and the handbook. */
function bodySections(z) {
  const out = [];

  out.push(sheet(`
    ${head('Orientation', 'What the committee can do',
      `Each flat has its own meter. Residents use the supply, and the association
       bills each flat for what it used, at the rate agreed for that month.`)}
    ${points([
      ['The portal performs the calculation', 'consumption multiplied by the rate for the month, rounded to the rupee.'],
      ['There is no box for an amount', 'only a meter reading and a rate per kg. Every figure is produced from those two.'],
      ['The committee makes the decisions', 'the rate, the readings, and whether a payment is accepted.'],
    ])}
    ${box('Admin accounts',
      'Committee members hold admin accounts. Every admin sees the same rates, readings and published amounts, and each action is recorded against the account that performed it.')}
    ${box('Notices are separate',
      'A member may hold a committee account that posts notices and has no other admin function. The Notices sheet covers it.')}`,
  { id: 's2' }));

  out.push(sheet(`
    ${head('Orientation', 'The console',
      'Everything below sits under <b>Admin</b>. The tabs run in the order the work happens.')}
    ${steps([
      ['Home.', 'Where the month stands, and what is outstanding.'],
      ['Billing.', 'The rate, the readings, and publishing. Three steps in one tab.'],
      ['Bills.', 'Every bill the association has issued.'],
      ['Proofs.', 'Payment screenshots submitted by residents.'],
      ['Reconcile.', 'An optional check against the bank statement.'],
    ])}
    ${
      // 'below', because the strip is a single row: the tabs are told apart by
      // X, not by Y, and the side rail cannot address them. This works only
      // because the strip stopped wrapping — while it wrapped, four tabs shared
      // a Y and two shared an X with the row above, and the badges came out
      // reading 5 2 6 3 4.
      // `tall`: the badge strip under the phone costs 8mm that a side rail
      // does not, and this page also carries five numbered steps and a box.
      fig('ph-console', { screenMm: z.tall, rail: 'above' })}
    ${box('Residents sits past the right edge',
      'The strip is one row and it scrolls. Swipe it sideways to reach Residents, which lists who lives where and who is billed.')}`,
  { id: 's3' }));

  out.push(sheet(`
    ${head('Home', 'The dashboard',
      `The first screen under Admin. It reports how far through the month the
       association is, and what is outstanding.`)}
    ${fig('ph-home', { screenMm: z.screen, rail: false })}
    ${points([
      ['Where the month stands', 'the month, the readings recorded, the rate, and the payment due date.'],
      ['Waiting on you', 'the outstanding work. Each row opens the screen that clears it.'],
    ])}
    ${warn('Awaiting proof is not the same as paid',
      'A resident who has started a payment is counted as awaiting proof until a screenshot is approved. The funds may already have arrived.')}`,
  { id: 's4' }));

  out.push(sheet(`
    ${head('Billing · step 1', 'Setting the rate',
      'Three fields, and all three belong to the month being billed.')}
    ${steps([
      ['Rate per kg.', 'The rate agreed by the committee for that month.'],
      ['Payment due.', 'The date from which a late fee applies.'],
      ['Late fee.', 'Whole rupees.'],
    ])}
    ${fig('ph-billing-rate', { screenMm: z.detail, railMm: 11 })}
    ${warn('Set the rate for every month, including an unchanged one',
      'Nothing is carried forward. An inherited rate produces a full set of bills that appear normal and are all incorrect.')}`,
  { id: 's5' }));

  out.push(sheet(`
    ${head('Billing · step 2', 'Importing readings',
      `The quickest route for a full month. Ninety-odd meters are faster brought
       in together than entered one at a time.`)}
    ${fig('ph-billing-import', { screenMm: z.detail, rail: false })}
    ${points([
      ['Download the template', 'it arrives with every flat and its previous reading already entered.'],
      ['Or paste a list', 'a flat and a reading on each line is sufficient.'],
      ['Review what it reports', 'a flat it cannot identify, or the same flat twice, is listed rather than discarded.'],
    ])}
    ${warn('Do not omit a month',
      'Each month is calculated from the month before it. A month with no readings prevents the next month being calculated.')}`,
  { id: 's6' }));

  out.push(sheet(`
    ${head('Billing · step 2', 'Entering readings by hand',
      `One row for each flat: the previous reading, the new one, and the
       consumption that results.`)}
    ${fig('ph-billing-readings', { screenMm: z.tall, rail: false })}
    ${points([
      ['Entries are saved automatically', 'a moment after you stop typing, in a single batch. There is no Save button on the grid.'],
      ['A weak connection does not lose work', 'unsent entries are queued and retried, and the page will not close quietly while any remain.'],
      ['The counter reports progress', 'the number of meters recorded, out of the whole building.'],
    ])}
    ${warn('A reading below the previous one is refused',
      'A meter does not run backwards, so a lower figure is a typing error or a replaced meter. A replacement is recorded separately.')}`,
  { id: 's7' }));

  out.push(sheet(`
    ${head('Billing · step 3', 'Reviewing and publishing',
      'This step opens once every meter has been recorded. Nothing reaches a resident before it.')}
    ${fig('ph-billing-publish', { screenMm: z.tall, rail: false })}
    ${points([
      ['Compare the total against the gas totals for the month', 'this single figure catches a wrong rate, a mistyped meter and an omitted flat.'],
      ['Review the flat-by-flat table', 'for any figure that does not suit that flat.'],
      ['Publish', 'the bills are issued and every resident with an email address is notified.'],
    ])}
    ${box('It reports who cannot be emailed',
      'The step lists the flats with no address on file. Those residents require notification by another route.')}`,
  { id: 's8' }));

  out.push(sheet(`
    ${head('Payments', 'Payment verification',
      `Residents pay through a UPI application and submit the screenshot. This
       screen is where those submissions are reviewed.`)}
    ${fig('ph-proofs', { screenMm: z.screen, rail: false })}
    ${points([
      ['The portal reads each screenshot first', 'it compares the amount against the bill before the row is presented.'],
      ['It checks the payment reference', 'and confirms it has not been used against another bill.'],
      ['A duplicate image is refused', 'so the same screenshot cannot be counted twice.'],
    ])}
    ${box('The ordinary case is a single action',
      'A control at the top of the queue approves every row that matches its bill exactly.')}`,
  { id: 's9' }));

  out.push(sheet(`
    ${head('Payments', 'Payment reminders',
      'Overdue bills are listed on the dashboard, under Waiting on you.')}
    ${fig('ph-home-reminders', { screenMm: z.detail, rail: false })}
    ${points([
      ['A bill may be reminded up to three times', 'the first when you ask, the others after a day and then two days.'],
      ['Remind all writes only to the flats currently due one', 'the remainder of the list is left alone.'],
      ['It may be run twice in a month', 'with a day between the two runs, and it draws on the same allowance.'],
    ])}
    ${box('Why a control is unavailable',
      'The console states the reason: the allowance is spent, insufficient time has passed, or no email address is on file. A resident with no address requires a telephone call.')}`,
  { id: 's10' }));

  out.push(sheet(`
    ${head('Governance', 'Approvals and permissions',
      'Certain actions require agreement from another account before they take effect.')}
    ${points([
      ['Correcting a published bill', 'two other admins must agree.'],
      ['Correcting an admin’s own bill', 'every other admin must agree.'],
      ['Changing a resident’s mobile or email', `these go to ${ADMIN_NAME}, because either may change the username a resident signs in with.`],
    ])}
    ${warn('A correction takes effect on agreement, not on submission',
      'If nothing appears to have happened, check the dashboard for a request already pending. A duplicate requires the same approvals again.')}
    ${box('The late fee is suspended while a correction is pending',
      'A resident whose bill is under review is not charged for the time the committee takes to decide.')}
    ${box('Why the rule exists',
      'It prevents any single account altering what a neighbour owes without a second person seeing it.')}`,
  { id: 's11' }));

  return out;
}

/**
 * The website contact's WhatsApp number, in international form without the +.
 * Not committed: it is a personal number, and a PDF that reaches a committee is
 * forwarded onward forever. Set it at build time:
 *
 *   GUIDE_WHATSAPP=91XXXXXXXXXX node guides/build-admin.mjs
 */
const WHATSAPP = (() => {
  const raw = process.env.GUIDE_WHATSAPP;
  if (!raw) return null;
  const digits = raw.replace(/[^\d]/g, '').replace(/^00/, '');
  return digits.length >= 10 ? digits : null;
})();

/* ── the combined handbook ──────────────────────────────────────────── */

/**
 * Everything in one document.
 *
 * The same sections as the spine and the sheets — nothing is written twice, so
 * a correction made once appears in every document that carries it. The spine's
 * closing page is dropped: "Where to look next" points at the sheets as
 * separate documents, which is wrong once they are chapters of the thing you
 * are already holding.
 */
export function fullPages({ version, date, trim }) {
  const z = trim === 'a5' ? SIZES.a5 : SIZES.phone;
  const body = bodySections(z);

  const chapters = SHEETS.map((meta) => ({
    meta, pages: sheetPages(meta.id, { version, date, trim, inline: true }),
  }));

  /* The contents live ON the cover.
     They were a page of their own, which left the cover as a title and four
     lines above half a sheet of blank paper. The index is what a cover of a
     reference document is for, and it is the one block long enough to fill
     one. If it ever stops fitting, the build says so rather than letting the
     cover quietly become two sheets. */
  const rows = [];
  let n = 2;
  for (const [title, id] of SPINE_SECTIONS.slice(0, body.length)) rows.push([n++, title, id]);
  const chapterRows = [];
  for (const c of chapters) { chapterRows.push([n, c.meta.title, `f-${c.meta.id}`]); n += c.pages.length; }
  const closingAt = n;

  const cover = sheet(`
    <p class="assoc">DD Diamond Park · Residents' Welfare Association</p>
    <h1>Committee handbook</h1>
    <p class="sub">How the committee runs the association portal: billing,
      payments, residents and notices.</p>
    ${contents([...rows, ...chapterRows, [closingAt, 'Who to contact', 'f-ask']])}
    <div class="stamp">
      <span>Kuriachira, Thrissur 680006, Kerala</span>
      <span>${link(WEB, 'diamondpark.pages.dev')}</span>
      <span>Version ${esc(version)} · ${esc(date)}</span>
    </div>`, { cls: 'cover' });

  /* Each chapter's first page gets the anchor its contents row points at. */
  const chapterPages = chapters.flatMap((c) => c.pages.map((h, k) =>
    (k === 0 ? h.replace('<section class="sheet ', `<section id="f-${c.meta.id}" class="sheet `) : h)));

  const closing = sheet(`
    ${head('Contact', 'Who to contact', 'Two different questions, and they go to different people.')}
    ${points([
      ['About a bill', 'the amount, a meter reading, a late fee, or a payment not yet confirmed.'],
      ['About the portal', 'a page will not load, or the console will not open at all.'],
    ])}
    ${box('Billing questions',
      'These go to the committee member responsible for gas.')}
    ${box('The portal itself',
      html(`<b>${t(ADMIN_NAME)}</b>${WHATSAPP ? ` — ${link('https://wa.me/' + WHATSAPP, 'message on WhatsApp')}` : ''}`))}
    ${box('Corrections require agreement',
      'A change to a bill needs other committee members to approve it. The late fee is suspended while the request is pending.')}
    ${box('Where to find it', html(`${link(WEB, 'diamondpark.pages.dev')} — the same address every month.`))}`,
  { id: 'f-ask' });

  return [cover, ...body, ...chapterPages, closing];
}

/* ── the reference sheets ───────────────────────────────────────────── */

export const SHEETS = [
  { id: 'proofs', title: 'Payment proofs', dek: 'the screenshots residents submit' },
  { id: 'reconcile', title: 'Reconcile', dek: 'an optional bank statement check' },
  { id: 'bills', title: 'Correcting a bill', dek: 'how a published bill is changed' },
  { id: 'residents', title: 'Residents', dek: 'who lives where, and what may be changed' },
  { id: 'notices', title: 'Notices', dek: 'informing the building' },
];

/**
 * @param inline  true when these pages are chapters of the combined handbook
 *                rather than a sheet on their own. A standalone sheet carries
 *                its own version stamp, because it is reissued by itself and a
 *                sheet with no date is one nobody can tell is stale. Inside the
 *                handbook the cover already carries that.
 */
export function sheetPages(id, { version, date, trim, inline = false }) {
  const a5 = trim === 'a5';
  const z = a5 ? SIZES.a5 : SIZES.phone;
  const meta = SHEETS.find((s) => s.id === id);
  if (!meta) throw new Error(`no sheet "${id}"`);

  const kick = inline ? meta.title : 'Reference sheet';
  const stamp = inline ? '' : `<div class="stamp"><span>DD Diamond Park · committee reference</span>
    <span>Version ${esc(version)} · ${esc(date)}</span></div>`;

  const build = {
    proofs: () => [
      sheet(`
        ${head(kick, 'Payment proofs',
          `When a resident pays, the screenshot from their UPI application is
           submitted here for review.`)}
        ${fig('ph-proofs', { screenMm: z.screen, rail: false })}
        ${points([
          ['Approve the exact matches together', 'the control at the top of the queue clears all of them at once.'],
          ['Then examine anything that did not match', 'open View to see the screenshot as submitted.'],
          ['Decisions can be reviewed afterwards', 'Already decided retains the last fifty approvals and rejections.'],
        ])}
        ${stamp}`),
      sheet(`
        ${head(kick, 'The three rows to recognise', '')}
        <div class="rows">
          <div class="rows__item">
            ${fig('ph-row-match', { screenMm: z.row, rail: false })}
            <p><b>Matches.</b> The amount on the screenshot equals the bill. Approve it.</p>
          </div>
          <div class="rows__item">
            ${fig('ph-row-noref', { screenMm: z.row, rail: false })}
            <p><b>No reference shown.</b> The application did not print one. This is not
              suspicious. Check the amount, then approve.</p>
          </div>
          <div class="rows__item">
            ${fig('ph-row-differs', { screenMm: z.row, rail: false })}
            <p><b>Amount differs.</b> The sum paid is not the sum billed. Open it and
              speak to the resident before deciding.</p>
          </div>
        </div>
        ${stamp}`),
    ],

    reconcile: () => [
      sheet(`
        ${head(kick, 'Reconcile',
          `<b>Entirely optional.</b> No part of the billing month depends on it.
           This screen compares the association’s own bank statement against
           what residents state they paid.`)}
        ${
          // `tall`, like the Bills page: this one carries a long opening
          // paragraph, three points and a box, and at the shared screen size
          // the figure pushes the section onto a second sheet.
          fig('ph-reconcile', { screenMm: z.tall, rail: false })}
        ${points([
          ['Upload the association’s statement as CSV or PDF', 'the portal matches each credit against a bill.'],
          ['Review what it could not match', 'usually a payment with no reference, or an odd amount.'],
          ['Leave a credit unmatched rather than guessing', 'a sum attached to the wrong flat is harder to find later.'],
        ])}
        ${box('The statement deletes itself',
          'Finishing the review records the verdicts and deletes the statement. A review left open is cleared automatically after twelve hours.')}
        ${stamp}`),
    ],

    bills: () => [
      sheet(`
        ${head(kick, 'Correcting a bill',
          `A published month is settled. A bill is corrected by changing what
           produced it: the meter reading, or the rate.`)}
        ${
          // A standalone sheet carries a version stamp that the chapter does
          // not, and this page has no room to spare: at the shared size the
          // stamp pushes it onto a second sheet.
          fig('ph-bills', { screenMm: inline ? z.screen : z.tall, rail: false })}
        ${points([
          ['Find the bill under Bills', 'search by flat number. Amounts are shown here and never edited here.'],
          ['Make the correction on the Billing tab', 'to the reading or the rate. There is no field for an amount.'],
          ['State a short reason', 'it is recorded with the change and shown to whoever approves it.'],
        ])}
        ${warn('Agreement applies the change, not submission',
          'Two other admins must agree, and every other admin if the bill belongs to an admin. The late fee is suspended meanwhile.')}
        ${stamp}`),
    ],

    residents: () => [
      sheet(`
        ${head(kick, 'Residents', 'Who lives in which flat, who is billed, and who remains liable.')}
        ${fig('ph-residents', { screenMm: z.screen, rail: false })}
        ${box('The tenant is billed. The owner remains liable.',
          'Consumption is metered, so the bill follows whoever used the supply. If it is not paid, the debt remains against the property.')}
        ${points([
          ['Search by flat number', 'this is faster than searching by name.'],
          ['A flat may be removed from billing', 'an empty flat should not produce bills nobody owes. A reason is required and recorded.'],
        ])}
        ${stamp}`),
      sheet(`
        ${head(kick, 'What may be changed', '')}
        ${fig('ph-person', { screenMm: z.detail, rail: false })}
        ${points([
          ['Name — change it directly', 'it is not a credential.'],
          ['Mobile and email — Request', `each goes to ${ADMIN_NAME}, because either may be the username a resident signs in with.`],
          ['Mobile numbers carry a country code', 'a number that is refused is usually missing its code.'],
        ])}
        ${box('Resetting a password',
          html(`A <b>Reset password</b> control appears on a resident’s card only while password-reset email is not configured. Once it is, residents reset themselves with ${link(WEB + '/forgot', 'Forgotten your password?')} and the control disappears.`))}
        ${stamp}`),
    ],

    notices: () => [
      sheet(`
        ${head(kick, 'Notices', 'How the association informs the building.')}
        ${fig('ph-notices', { screenMm: z.screen, rail: false })}
        ${box('Not in the admin console',
          'A notice is written and managed on the notice board itself, under Notices in the main navigation.')}
        ${box('Who sees what',
          'A notice may go to the whole building, or to owners alone. A tenant cannot act on an association agenda.')}
        ${stamp}`),
      sheet(`
        ${head(kick, 'Posting a notice, and who may', '')}
        ${
          // Smaller on the standalone sheet, which carries a version stamp the
          // chapter does not and has no room to spare. Same trade as the
          // Correcting a bill page.
          fig('ph-compose', { screenMm: inline ? z.tall : z.tall - 8, rail: false })}
        ${points([
          ['Give it a short title', 'the title is what residents see in the list.'],
          ['Choose who sees it', 'the whole building, or owners alone.'],
          ['Decide about replies', 'these are disabled unless enabled, one notice at a time.'],
          ['Withdraw before deleting', 'a live notice cannot disappear by accident. Withdrawn notices are retained.'],
        ])}
        ${box('Limits',
          'Attachments: five files on a notice, two on a reply. Each up to 25 MB, as JPEG, PNG, WebP or PDF.',
          'Replies: up to 1,200 characters, and a resident may post six in an hour.',
          'Notices themselves are not limited in number.')}
        ${box('Committee accounts',
          'A member may be elected and given a committee account. It posts notices and edits the notices that account posted, and it has no other admin function: no rates, no readings, no bills, no payments. The admin console does not appear for it.')}
        ${stamp}`),
    ],
  };

  return build[id]();
}
