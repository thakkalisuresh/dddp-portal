/**
 * Capture every screenshot both guides need, and emit a manifest.
 *
 * Declarative on purpose. Each entry names a URL, an optional crop target and
 * an ordered list of elements to badge; the driver does the rest. When a screen
 * changes, the fix is an edit here rather than a new bespoke script — which is
 * the difference between a guide that gets regenerated and one that rots.
 *
 * The demo-data flag is stashed for the duration of the run and restored in a
 * finally block. While it is blank the Rates screen stops offering months that
 * have not ended, which is what removes the orange "for testing" panel — so the
 * capture matches production without anything being cropped or edited out.
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { browser, session, shot, settle, DESKTOP, MOBILE, BASE } from './lib/portal.mjs';
import { exec, query, q } from './lib/d1.mjs';
import { hashPassword } from '../functions/lib/crypto.js';
// The same normaliser login uses. A resident types ten digits; the column holds
// E.164. Spelling that conversion a second time here is the bug migration 0009
// was written to end.
import { normaliseMobile } from '../functions/lib/godedit.js';

const OUT = 'guides/out/shots';

/**
 * The two demo logins the guides are shot through.
 *
 * Read from the environment, and deliberately not written down here. Both
 * accounts are part of the demo seed that is ALSO ON PRODUCTION — and
 * 9990000001 is an `admin` — so a plaintext pair in a tracked file is a working
 * production credential published to the repository. That is the whole reason
 * this indirection exists; it is not tidiness.
 *
 * Set them in your shell before capturing. See guides/README.md.
 */
function credential(who) {
  const mobile = process.env[`GUIDE_${who}_MOBILE`];
  const password = process.env[`GUIDE_${who}_PW`];
  if (!mobile || !password) {
    throw new Error(
      `Set GUIDE_${who}_MOBILE and GUIDE_${who}_PW before capturing — the demo `
      + 'logins are not stored in the repository, because the same accounts exist '
      + 'on production. See guides/README.md.');
  }
  return { mobile, password };
}

/**
 * `--resident-only` skips every admin shot. The resident guide needs none of
 * them, and the admin pass is the half that opens a billing month and moves
 * readings about — worth not running at all when nothing will use its output.
 */
const RESIDENT_ONLY = process.argv.includes('--resident-only');

/**
 * `--admin-phone` runs the admin pass ALONE, at the resident's viewport.
 *
 * The admin console is mobile-first — every dense screen on it is a flex row
 * with `min-width: 0`, or an `auto-fit minmax()` grid, and none of them is a
 * fixed-width table. So the committee guide can be shot on a phone and reuse
 * the resident guide's device frame, badge rail and trim unchanged.
 *
 * It writes a SEPARATE manifest. The A4 handbook is still built from the
 * desktop shots in shots.json, and merging the two would have the phone pass
 * quietly replace the figures that handbook renders.
 */
const ADMIN_PHONE = process.argv.includes('--admin-phone');

const ADMIN = RESIDENT_ONLY ? null : credential('ADMIN');
// Not required by the phone pass, and `credential` throws when it is unset —
// so asking for it would make --admin-phone demand a login it never uses.
const RESIDENT = ADMIN_PHONE ? null : credential('RESIDENT');

/** `.field` wrapper for a labelled control, by its visible label text. */
const field = (label) => `.field:has(label:text-is("${label}"))`;

const RESIDENT_SHOTS = [
  {
    name: 'login',
    url: '/login.html',
    marks: ['#mobile, input[type=tel]', 'input[type=password]', 'button[type=submit]'],
    target: 'main',
    clipTo: 560,
  },
  { name: 'dashboard-top', url: '/dashboard.html', target: '.bill-hero' },
  { name: 'dashboard-pay', url: '/dashboard.html', target: '.pay-block' },
  { name: 'dashboard-breakdown', url: '/dashboard.html', target: 'main section.stack:nth-of-type(3)' },
  { name: 'dashboard-history', url: '/dashboard.html', target: 'main section.stack:nth-of-type(5)', clipTo: 420 },
  {
    name: 'proof-upload', url: '/proof.html', target: 'main', clipTo: 430,
    // No mark on "Submit for approval": that button is only rendered once a
    // file has been chosen, so on the empty screen there is nothing to point at.
    marks: ['label.drop'],
  },
  { name: 'notices', url: '/notices.html', target: 'main', clipTo: 700 },
  // The bottom bar is the whole of a resident's navigation, and section 3 of
  // the guide is about nothing else. Shot on its own so it can run wide.
  { name: 'resident-nav', url: '/dashboard.html', target: '.bottomnav' },
  // One notice opened, so the guide can show a thread rather than a list.
  // id=5 is the Onam notice: scope "all", replies switched on, five of them.
  { name: 'notice-detail', url: '/notices.html?id=5', target: 'main', clipTo: 760 },
  {
    name: 'notice-reply', url: '/notices.html?id=5',
    target: '.stack:has(> textarea[aria-label="Your reply"])',
    marks: [
      'textarea[aria-label="Your reply"]',
      'input[aria-label="Attach photos or a PDF"]',
      'button:text-is("Post")',
    ],
  },
  // Replies switched off, which is what section 9 tells a resident to look for.
  // Deliberately id=1 and not one of the owners-only notices: the demo account
  // is a TENANT, and canSeeNotice hides scope "owners" from tenants, so those
  // render as "That notice could not be found" rather than as a notice.
  { name: 'notice-noreply', url: '/notices.html?id=1', target: 'main', clipTo: 620 },
  { name: 'profile', url: '/profile.html', target: 'main', clipTo: 700 },
  { name: 'forgot', url: '/forgot.html', target: 'main', marks: ['#mobile, input[type=tel]'] },
];

/**
 * The welcome screen, which is the first thing a resident ever sees and the one
 * screen the guides could not show.
 *
 * It is unreachable by the ordinary path: every other resident shot is taken
 * through a logged-in session, and `/password` redirects to the dashboard the
 * moment `mustChangePassword` is false — which it is for anybody who can log in
 * normally. So the account is briefly put back into the state a roster invite
 * leaves it in, shot, and put back.
 *
 * Restoring is not optional and not best-effort. The stash is taken BEFORE
 * anything is written and replayed in a `finally`, the same discipline the
 * readings and the demo flag already use here — a capture run must not be able
 * to leave a resident holding a password nobody knows.
 */
const ONBOARDING_SHOT = {
  name: 'onboarding',
  url: '/password.html',
  target: 'main',
  marks: [field('Your name'), field('Email (optional)'), field('New password')],
};

function stashCredential(mobile) {
  const e164 = normaliseMobile(mobile);
  const row = query(
    `SELECT id, pw_hash, pw_salt, pw_iterations, must_change_pw, pw_expires_at
       FROM owners WHERE mobile = ${q(e164)}`)[0];
  if (!row) throw new Error(`no owner with mobile ${e164}`);
  return row;
}

function restoreCredential(row) {
  exec(`UPDATE owners
           SET pw_hash = ${q(row.pw_hash)}, pw_salt = ${q(row.pw_salt)},
               pw_iterations = ${row.pw_iterations},
               must_change_pw = ${row.must_change_pw},
               pw_expires_at = ${q(row.pw_expires_at)}
         WHERE id = ${row.id}`);
}

/**
 * Put the account back into "invited, not yet set up" and hand back the
 * password to log in with.
 *
 * The password is random per run and never leaves this process, so there is
 * nothing here for a later reader to find and try. The expiry is pushed out
 * because `tempPasswordState` would otherwise refuse the login on any run made
 * more than INVITE_PW_HOURS after the seed was written.
 */
async function makePending(row) {
  const password = `capture-${randomUUID()}`;
  const { hash, salt, iterations } = await hashPassword(password, 100_000);
  const expires = new Date(Date.now() + 24 * 3600_000).toISOString();
  exec(`UPDATE owners
           SET pw_hash = ${q(hash)}, pw_salt = ${q(salt)}, pw_iterations = ${iterations},
               must_change_pw = 1, pw_expires_at = ${q(expires)}
         WHERE id = ${row.id}`);
  return password;
}

/** One step of the Billing tab, by its visible title. */
const step = (title) => `section.step:has(.step__title:text-is("${title}"))`;

const PRICE = 'The price of gas';
const METERS = 'This month\u2019s readings';   // curly apostrophe, as rendered
const PUBLISH = 'Review and publish';

const ADMIN_SHOTS = [
  { name: 'admin-nav', url: '/admin/index.html', target: 'body', clipTo: 130 },
  { name: 'admin-home', url: '/admin/index.html', target: 'main', clipTo: 720 },
  {
    // Chasing an unpaid bill lives on HOME, not on Bills — it is part of
    // "Waiting on you". The fold is shut by default because forty overdue
    // flats would otherwise bury everything else on the screen.
    name: 'admin-home-reminders',
    url: '/admin/index.html#home',
    target: 'details.board__fold:has(.board__t:text-is("Bills unpaid past the due date"))',
    openDetails: 'details.board__fold:has(.board__t:text-is("Bills unpaid past the due date"))',
    clipTo: 520,
  },
  { name: 'admin-bills', url: '/admin/index.html#bills', target: 'main', clipTo: 760 },
  { name: 'admin-proofs', url: '/admin/proofs.html', target: 'main', clipTo: 800 },
  { name: 'admin-reconcile', url: '/admin/statement.html', target: 'main', clipTo: 700 },
  { name: 'admin-residents', url: '/admin/index.html#residents', target: 'main', clipTo: 800 },
  { name: 'admin-notices', url: '/notices.html', target: 'main', clipTo: 760 },
];

/**
 * The same screens, framed for a phone.
 *
 * Two kinds of shot, and the difference is deliberate.
 *
 *   · A COMPLETE SCREEN — `target: 'body'` clipped to one 844px screenful.
 *     Appbar at the top, bottom nav at the bottom, nothing cut off. A cropped
 *     frame reads as "the phone looks weird" rather than as a screenshot, and
 *     that was the first correction made to the resident guide.
 *   · A DETAIL, targeted at the element being badged. Used only where the text
 *     is a numbered list, because a number in the prose has to have a badge to
 *     point at.
 *
 * No `clipFrom` is set anywhere yet. Guessing an offset for a screen nobody has
 * looked at is how the first draft ended up with badges on the wrong controls;
 * the offsets get set once these have been run and looked at, not before.
 */
// No `target`: the box is the VIEWPORT, which is the whole point. Targeting
// `body` measures the entire scrolling document, grows the viewport to fit it
// (see shot()), and the fixed thumb bar then sits at the bottom of that tall
// frame instead of at the bottom of the screen — so the one element the
// "complete screen" framing exists to keep is the one that falls outside it.
const SCREEN = {};

const ADMIN_PHONE_SHOTS = [
  // Numbered, because the page that introduces the console lists the tabs as a
  // numbered list. A number in the prose has to have a badge to point at.
  {
    name: 'ph-console', url: '/admin/index.html', ...SCREEN,
    // FIVE, not six. The strip is one scrolling row now, and Residents sits
    // past the right edge on arrival — it is in the DOM but not in the picture,
    // and a badge for a tab you cannot see points at nothing. The page says in
    // words that it is reached by swiping.
    marks: ['.tab:text-is("Home")', '.tab:text-is("Billing")', '.tab:text-is("Bills")',
            '.tab:text-is("Proofs")', '.tab:text-is("Reconcile")'],
  },
  { name: 'ph-home', url: '/admin/index.html#home', ...SCREEN },
  {
    name: 'ph-home-reminders',
    url: '/admin/index.html#home',
    target: 'details.board__fold:has(.board__t:text-is("Bills unpaid past the due date"))',
    openDetails: 'details.board__fold:has(.board__t:text-is("Bills unpaid past the due date"))',
    clipTo: 620,
  },
  { name: 'ph-bills', url: '/admin/index.html#bills', ...SCREEN },
  { name: 'ph-proofs', url: '/admin/proofs.html', ...SCREEN },
  // One row at a time. The queue page shows the shape; these show the three
  // states a treasurer has to tell apart, each beside the sentence about it.
  { name: 'ph-row-match', url: '/admin/proofs.html', target: '.qrow >> nth=0' },
  { name: 'ph-row-noref', url: '/admin/proofs.html', target: '.qrow >> nth=2' },
  { name: 'ph-row-differs', url: '/admin/proofs.html', target: '.qrow--bad >> nth=0' },
  { name: 'ph-reconcile', url: '/admin/statement.html', ...SCREEN },
  { name: 'ph-residents', url: '/admin/index.html#residents', ...SCREEN },
  // One resident's card, for the page about which fields may be changed.
  // Resident rows are collapsed <details>; the fields are inside. Open the
  // first one, then crop to it.
  {
    name: 'ph-person', url: '/admin/index.html#residents',
    openDetails: 'details:has(.person)',
    target: 'details:has(.person) >> nth=0', clipTo: 620,
  },
  { name: 'ph-notices', url: '/notices.html', ...SCREEN },
  // The composer is behind two controls: an admin reads the board like anyone
  // else until the management controls are switched on.
  { name: 'ph-compose', url: '/notices.html', click: ['Manage notices', '+ Post a notice'], target: 'main', clipTo: 700 },
];

/** The Billing tab on a phone, in the same two month states as the desktop pass. */
const draftPhoneShots = () => [
  { name: 'ph-billing', url: '/admin/index.html#billing', collapse: [METERS], ...SCREEN },
  {
    name: 'ph-billing-rate',
    url: '/admin/index.html#billing',
    target: step(PRICE),
    openStep: PRICE,
    marks: [field('Rate per kg'), field('Payment due'), field('Late fee')],
  },
  {
    name: 'ph-billing-readings',
    url: '/admin/index.html#billing',
    target: step(METERS),
    openStep: METERS,
    clipTo: 760,
  },
  {
    name: 'ph-billing-import',
    url: '/admin/index.html#billing',
    target: step(METERS),
    openStep: METERS,
    expand: 'Import from a spreadsheet, or paste',
    clipTo: 620,
  },
];

const publishPhoneShots = () => [
  {
    name: 'ph-billing-publish',
    url: '/admin/index.html#billing',
    target: step(PUBLISH),
    openStep: PUBLISH,
    clipTo: 820,
  },
];

/**
 * The Billing tab can only be taught on an OPEN month. Every generated month is
 * locked, and its steps render read-only — the wrong screen to put in front of
 * somebody being shown how a month is run.
 *
 * USE THE OPEN MONTH THAT EXISTS; CREATE ONE ONLY IF NONE DOES. The previous
 * version hard-coded `INSERT OR REPLACE` on 2026-08 and deleted it afterwards.
 * That was safe when 2026-08 did not exist. It does now — locked, with 93 bills
 * against it — so the old code would have flipped a settled month back to open,
 * then deleted the month and its readings out from under those bills. A capture
 * run must not be able to destroy data; it only ever reads.
 */
let scratchCreated = null;

function findOpenPeriod() {
  const row = query("SELECT period FROM periods WHERE status = 'open' ORDER BY period DESC LIMIT 1")[0];
  return row?.period ?? null;
}

function ensureOpenPeriod() {
  const existing = findOpenPeriod();
  if (existing) return existing;

  // The month after the latest one on record, so consumption has a predecessor.
  const [{ last }] = query('SELECT max(period) AS last FROM periods');
  const [y, m] = last.split('-').map(Number);
  const period = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;

  // late_fee 0 and a future due date: planLateFees skips the period outright
  // (`WHERE late_fee > 0`), so no fee can land while this exists.
  exec(`INSERT INTO periods
          (period, rate_per_kg, conversion_factor, due_date, late_fee, late_fee_after, status, created_at)
        VALUES ('${period}', 80, 2.60, '${y + (m === 12 ? 1 : 0)}-12-10', 0, 0, 'open', '${new Date().toISOString()}')`);
  scratchCreated = period;
  return period;
}

function dropScratchPeriod() {
  if (!scratchCreated) return;                 // it was already there: leave it
  exec(`DELETE FROM readings WHERE period = '${scratchCreated}'`);
  exec(`DELETE FROM periods WHERE period = '${scratchCreated}'`);
}

/**
 * Readings for the open month are stashed, not deleted — the empty grid and the
 * ready-to-publish summary are two shots of the SAME month in two states, and
 * the month may be one the seed provided rather than one we made.
 */
function stashReadings(period) {
  const rows = query(`SELECT flat, reading, entered_at FROM readings WHERE period = '${period}'`);
  exec(`DELETE FROM readings WHERE period = '${period}'`);
  return rows;
}

function fillReadings(period) {
  // Derived from the previous month so every consumption figure is plausible;
  // step 3 shows a building total, and a total built from nonsense reads as
  // nonsense.
  //
  // VARIED PER FLAT, and that is not decoration. A single `reading + 1.2`
  // applied to all 93 meters made every row of the review table read "3.12 kg
  // · ₹250" — identical down the page. It is the screenshot a treasurer would
  // look at and conclude the portal was broken, in the one figure they are
  // being taught to check. The spread is deterministic, so re-running the
  // capture does not silently reshuffle a published guide's numbers.
  const [{ prev }] = query(
    `SELECT max(period) AS prev FROM periods WHERE period < '${period}'`);
  const rows = query(`SELECT flat, reading FROM readings WHERE period = '${prev}'`);
  const now = new Date().toISOString();

  const values = rows.map(({ flat, reading }) => {
    let h = 2166136261;
    for (const ch of flat) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
    const delta = 0.6 + ((h >>> 0) % 1900) / 1000;        // 0.6 … 2.5
    return `('${flat}', '${period}', ${Math.round((reading + delta) * 1000) / 1000}, '${now}')`;
  });

  for (let i = 0; i < values.length; i += 50) {
    exec(`INSERT OR REPLACE INTO readings (flat, period, reading, entered_at)
          VALUES ${values.slice(i, i + 50).join(',')}`);
  }
}

function restoreReadings(period, rows) {
  exec(`DELETE FROM readings WHERE period = '${period}'`);
  if (!rows.length) return;
  const values = rows.map((r) =>
    `('${r.flat}', '${period}', ${r.reading}, ${q(r.entered_at)})`).join(',\n');
  exec(`INSERT INTO readings (flat, period, reading, entered_at) VALUES\n${values}`);
}

/**
 * Step 3 reports how many residents will be emailed. The demo seed gives nobody
 * an address, so it reads "0 of 93 residents will get an email" followed by a
 * list of every flat — true of the seed, and false of the building, which is
 * the wrong thing for a handbook to teach. Addresses are set for the shot and
 * put back afterwards.
 */
function stashEmails() {
  const rows = query('SELECT id, email FROM owners WHERE email IS NOT NULL');
  exec("UPDATE owners SET email = lower(replace(flat, ' ', '')) || '@example.invalid' WHERE email IS NULL OR email = ''");
  return rows;
}

function restoreEmails(rows) {
  const keep = rows.map((r) => r.id);
  exec(`UPDATE owners SET email = NULL WHERE id NOT IN (${keep.length ? keep.join(',') : '0'})`);
  for (const r of rows) exec(`UPDATE owners SET email = ${q(r.email)} WHERE id = ${r.id}`);
}

/** Shot 1: the month before any meter has been read. */
const draftShots = () => [
  {
    name: 'admin-billing-overview',
    url: '/admin/index.html#billing',
    // `.panel.stack` is the month HEADER only — 173px, no steps inside it. The
    // steps are its siblings, so the container that holds both is the stack
    // #main renders into. Targeting the panel produced a shot of the title bar
    // and nothing else, which still looked like a screenshot.
    target: '#main > .stack',
    collapse: [METERS],
    // Stops just below step 3. At 430 the crop landed in the middle of the
    // sentence underneath it, and a figure that ends mid-clause reads as a
    // broken screenshot rather than a deliberate crop.
    clipTo: 386,
  },
  {
    name: 'admin-billing-rate',
    url: '/admin/index.html#billing',
    target: step(PRICE),
    openStep: PRICE,
    marks: [field('Rate per kg'), field('Payment due'), field('Late fee')],
  },
  {
    name: 'admin-billing-readings',
    url: '/admin/index.html#billing',
    target: step(METERS),
    openStep: METERS,
    clipTo: 700,
  },
  {
    name: 'admin-billing-import',
    url: '/admin/index.html#billing',
    target: step(METERS),
    openStep: METERS,
    expand: 'Import from a spreadsheet, or paste',
    clipTo: 520,
  },
];

/** Shot 2: the same month with every meter in, which is the only state step 3 opens in. */
const publishShots = () => [
  {
    name: 'admin-billing-publish',
    url: '/admin/index.html#billing',
    target: step(PUBLISH),
    openStep: PUBLISH,
    clipTo: 760,
  },
];

/**
 * A proof whose amount does not match its bill.
 *
 * The guide has to show the row a treasurer must not approve on sight, and the
 * seed has five proofs that all match exactly. Rather than draw a fake row, one
 * real proof's parsed amount is moved for the length of the run and put back in
 * a finally — the same stash-and-restore the readings use. A capture run must
 * never leave the database different from how it found it.
 */
function stashProofMismatch() {
  const row = query(`SELECT b.id, b.total FROM payment_proofs pp
                     JOIN bills b ON b.id = pp.bill_id
                     WHERE pp.status = 'pending' AND pp.parsed_amount IS NOT NULL
                     ORDER BY pp.id DESC LIMIT 1`)[0];
  if (!row) return null;
  // THE BILL MOVES, NOT THE PROOF. Moving the proof's parsed amount produced a
  // figure that contradicted itself: the row read "short by 47" beside a
  // thumbnail of the screenshot still showing the original sum. Raising the
  // bill instead leaves the screenshot, the parsed amount and the shortfall
  // agreeing with each other — which is what a real underpayment looks like.
  exec(`UPDATE bills SET total = ${row.total + 47} WHERE id = ${row.id}`);
  return row;
}

function restoreProofMismatch(row) {
  if (!row) return;
  exec(`UPDATE bills SET total = ${row.total} WHERE id = ${row.id}`);
}

/**
 * An open poll to photograph.
 *
 * The seed has none, and a guide page about polls showing "There are no polls
 * right now" teaches nothing. Created for the run and deleted in a finally.
 *
 * No votes are cast. While voting is open the count is absent from the payload
 * for everybody except the superadmin, so ballots would not change the picture
 * — and casting them would put rows in poll_votes that the backup only carries
 * after a poll closes.
 */
function stashPoll() {
  const admin = query("SELECT id FROM owners WHERE mobile = '+919990000001'")[0];
  if (!admin) return null;
  const now = new Date().toISOString();
  const closes = new Date(Date.now() + 6 * 86_400_000).toISOString();
  exec(`INSERT INTO polls (title, body, multi, show_tenants, opens_at, closes_at, created_by, created_at)
        VALUES ('Terrace waterproofing — which quote?',
                'Three quotes came in for the terrace. The committee would like the building''s view before deciding.',
                0, 0, '${now}', '${closes}', ${admin.id}, '${now}')`);
  const id = query('SELECT max(id) AS id FROM polls')[0]?.id;
  if (id == null) return null;
  const options = ['Quote A — the lowest, five-year guarantee',
                   'Quote B — mid-priced, ten-year guarantee',
                   'Quote C — the highest, fifteen-year guarantee'];
  options.forEach((label, i) =>
    exec(`INSERT INTO poll_options (poll_id, label, sort) VALUES (${id}, '${label.replace(/'/g, "''")}', ${i})`));
  return id;
}

function restorePoll(id) {
  if (id == null) return;
  exec(`DELETE FROM poll_options WHERE poll_id = ${id}`);
  exec(`DELETE FROM poll_votes WHERE poll_id = ${id}`);
  exec(`DELETE FROM polls WHERE id = ${id}`);
}

/** The three poll screens. Routed by query string, so no clicking. */
const pollShots = (id) => [
  { name: 'ph-polls', url: '/polls.html', ...SCREEN },
  { name: 'ph-poll-new', url: '/polls.html?new=1', target: 'main', clipTo: 820 },
  // The committee's own controls, which sit below the options and are the
  // reason an admin opens a poll at all. No class of their own, so addressed
  // by the label they carry.
  {
    name: 'ph-poll-manage', url: `/polls.html?id=${id}`,
    target: '.stack:has(> p.label:text-is("Committee"))', clipTo: 420,
  },
];

/** Blank the demo flag so unfinished months, and their warning panel, go away. */
function stashDemoFlag() {
  const row = query("SELECT value FROM settings WHERE key = 'demo_seed_ids'")[0];
  if (!row) return null;
  exec("UPDATE settings SET value = '' WHERE key = 'demo_seed_ids'");
  return row.value;
}

function restoreDemoFlag(value) {
  if (value == null) return;
  exec(`UPDATE settings SET value = ${q(value)} WHERE key = 'demo_seed_ids'`);
}

async function capture(page, spec, viewport) {
  await page.goto(`${BASE}${spec.url}`, { waitUntil: 'networkidle' });
  await settle(page);

  // The Billing tab's steps are an accordion. Open the one being documented,
  // and collapse any that would otherwise push it below the fold.
  //
  // Driven by aria-expanded rather than by a class, because that attribute is
  // what the component actually maintains — a class name is an implementation
  // detail that a restyle can rename, and a selector that silently stops
  // matching produces a shot of the wrong step rather than an error.
  for (const title of spec.collapse ?? []) {
    const head = page.locator(`section.step:has(.step__title:text-is("${title}")) button.step__head`).first();
    if (await head.count() && await head.getAttribute('aria-expanded') === 'true') {
      await head.click();
      await page.waitForTimeout(250);
    }
  }
  if (spec.openStep) {
    const head = page.locator(`section.step:has(.step__title:text-is("${spec.openStep}")) button.step__head`).first();
    if (!(await head.count())) throw new Error(`no step titled "${spec.openStep}"`);
    if (await head.getAttribute('aria-expanded') !== 'true') {
      await head.click();
      await page.waitForTimeout(400);
    }
    await settle(page);
  }

  // Some folds cannot be addressed by their summary text: the overdue block's
  // summary reads "Bills unpaid past the due date40" — the count is inside it,
  // so :text-is() can never match and :has-text() would match a moving target.
  // Address those by selector instead.
  if (spec.openDetails) {
    const d = page.locator(spec.openDetails).first();
    if (!(await d.count())) throw new Error(`no details matching ${spec.openDetails}`);
    await d.evaluate((n) => { n.open = true; });
    await page.waitForTimeout(300);
  }

  // Disclosure panels are closed by default; open the one being documented.
  if (spec.expand) {
    const d = page.locator(`details:has(summary:text-is("${spec.expand}"))`).first();
    if (await d.count()) { await d.evaluate((n) => { n.open = true; }); await page.waitForTimeout(200); }
  }

  // Wait for the thing being photographed to exist. networkidle is not enough
  // for a panel that renders from a fetch: `.person` measured 0px high and the
  // crop failed outright, which is the good version of this bug.
  if (spec.waitFor) {
    await page.locator(spec.waitFor).first().waitFor({ state: 'visible', timeout: 15_000 });
    await page.waitForTimeout(250);
  }

  // A control that is neither a <details> nor an accordion step: the notice
  // composer is a button that unhides a form. Clicked by its visible text, so
  // the selector says what a reader would look for.
  for (const label of spec.click ?? []) {
    const b = page.getByText(label, { exact: true }).first();
    if (!(await b.count())) throw new Error(`nothing to click labelled "${label}"`);
    await b.click();
    await page.waitForTimeout(350);
    await settle(page);
  }

  // Some panels only exist after a hash-routed tab renders.
  if (spec.find) {
    const anchor = page.getByText(spec.find, { exact: false }).first();
    await anchor.scrollIntoViewIfNeeded().catch(() => {});
    await page.waitForTimeout(150);
  }

  const file = join(OUT, `${spec.name}.png`);
  // The window is applied inside shot(), while the viewport is still the one
  // every box was measured against. See the fullPage note in lib/portal.mjs.
  const res = await shot(page, file, {
    target: spec.target ?? null,
    marks: spec.marks ?? [],
    padding: spec.padding ?? 0,
    clipFrom: spec.clipFrom ?? 0,
    clipTo: spec.clipTo ?? null,
  });

  res.name = spec.name;
  res.viewport = viewport;
  // The FIGURE's own dimensions, which is what device() sizes the phone from.
  // Without these it computes `shot.h / shot.w` as NaN, and every badge rail
  // silently collapses to zero height — the badges stack on one another at the
  // top of the figure and the last one drawn hides the rest. The screen itself
  // still looks correct, because the image sizes itself, so nothing about the
  // figure says it is wrong. measure-sim.mjs has always emitted these; this
  // pass never did.
  res.w = Math.round(res.clip.width);
  res.h = Math.round(res.clip.height);
  return res;
}

async function run() {
  mkdirSync(OUT, { recursive: true });
  const br = await browser();
  const manifest = {};
  const problems = [];

  try {
    if (RESIDENT_ONLY) console.log('  (--resident-only: skipping admin shots)');
    if (ADMIN_PHONE) console.log('  (--admin-phone: admin console at 390x844, touch on)');
    if (!RESIDENT_ONLY) {
    const vp = ADMIN_PHONE ? 'mobile' : 'desktop';
    const admin = await session(br, {
      ...ADMIN,
      viewport: ADMIN_PHONE ? MOBILE : DESKTOP,
      touch: ADMIN_PHONE,
    });
    const stashedPoll = ADMIN_PHONE ? stashPoll() : null;
    if (stashedPoll) console.log(`  poll ${stashedPoll} opened, to photograph the poll screens`);
    const stashedProof = ADMIN_PHONE ? stashProofMismatch() : null;
    if (stashedProof) console.log(`  bill ${stashedProof.id} temporarily raised, to photograph an underpaid row`);
    try {
    const specs = ADMIN_PHONE
      ? [...ADMIN_PHONE_SHOTS, ...(stashedPoll ? pollShots(stashedPoll) : [])]
      : ADMIN_SHOTS;
    for (const spec of specs) {
      try {
        const r = await capture(admin.page, spec, vp);
        manifest[spec.name] = r;
        if (r.missing.length) problems.push(`${spec.name}: no match for ${r.missing.join(', ')}`);
        console.log(`  ✓ ${spec.name.padEnd(20)} ${Math.round(r.clip.width)}×${Math.round(r.clip.height)}  ${r.marks.length} badge(s)`);
      } catch (err) {
        problems.push(`${spec.name}: ${err.message}`);
        console.log(`  ✗ ${spec.name.padEnd(20)} ${err.message}`);
      }
    }
    } finally {
      restoreProofMismatch(stashedProof);
      if (stashedProof) console.log('  bill total restored');
      restorePoll(stashedPoll);
      if (stashedPoll) console.log('  poll removed');
    }

    // The Billing tab, in its two states. Both passes run against the same open
    // month: first with no meter read, then with all of them in — because step
    // 3 refuses to open until every flat has a reading, and step 2 only shows
    // an empty grid before any does.
    const period = ensureOpenPeriod();
    const stashedReadings = stashReadings(period);
    const stashedEmails = stashEmails();
    console.log(`  billing month ${period}${scratchCreated ? ' (created for this run)' : ' (already open)'}`);
    try {
      for (const spec of (ADMIN_PHONE ? draftPhoneShots() : draftShots())) {
        try {
          const r = await capture(admin.page, spec, vp);
          manifest[spec.name] = r;
          if (r.missing.length) problems.push(`${spec.name}: no match for ${r.missing.join(', ')}`);
          console.log(`  ✓ ${spec.name.padEnd(24)} ${Math.round(r.clip.width)}×${Math.round(r.clip.height)}  ${r.marks.length} badge(s)`);
        } catch (err) {
          problems.push(`${spec.name}: ${err.message}`);
          console.log(`  ✗ ${spec.name.padEnd(24)} ${err.message}`);
        }
      }

      fillReadings(period);
      for (const spec of (ADMIN_PHONE ? publishPhoneShots() : publishShots())) {
        try {
          const r = await capture(admin.page, spec, vp);
          manifest[spec.name] = r;
          console.log(`  ✓ ${spec.name.padEnd(24)} ${Math.round(r.clip.width)}×${Math.round(r.clip.height)}  ${r.marks.length} badge(s)`);
        } catch (err) {
          problems.push(`${spec.name}: ${err.message}`);
          console.log(`  ✗ ${spec.name.padEnd(24)} ${err.message}`);
        }
      }
    } finally {
      restoreReadings(period, stashedReadings);
      restoreEmails(stashedEmails);
      dropScratchPeriod();
      console.log('  readings, addresses and period restored');
    }
    await admin.ctx.close();
    }

    if (ADMIN_PHONE) console.log('  (--admin-phone: skipping the resident passes)');
    if (!ADMIN_PHONE) {
    const res = await session(br, { ...RESIDENT, viewport: MOBILE, touch: true });
    for (const spec of RESIDENT_SHOTS) {
      try {
        const r = await capture(res.page, spec, 'mobile');
        manifest[spec.name] = r;
        if (r.missing.length) problems.push(`${spec.name}: no match for ${r.missing.join(', ')}`);
        console.log(`  ✓ ${spec.name.padEnd(20)} ${Math.round(r.clip.width)}×${Math.round(r.clip.height)}  ${r.marks.length} badge(s)`);
      } catch (err) {
        problems.push(`${spec.name}: ${err.message}`);
        console.log(`  ✗ ${spec.name.padEnd(20)} ${err.message}`);
      }
    }
    await res.ctx.close();

    // The welcome screen, shot last: it is the only pass that rewrites a
    // credential, so nothing else depends on the account while it is altered.
    const cred = stashCredential(RESIDENT.mobile);
    try {
      const tempPassword = await makePending(cred);
      const pending = await session(br, {
        mobile: RESIDENT.mobile, password: tempPassword, viewport: MOBILE, touch: true,
      });
      try {
        const r = await capture(pending.page, ONBOARDING_SHOT, 'mobile');
        manifest[ONBOARDING_SHOT.name] = r;
        if (r.missing.length) {
          problems.push(`${ONBOARDING_SHOT.name}: no match for ${r.missing.join(', ')}`);
        }
        console.log(`  ✓ ${ONBOARDING_SHOT.name.padEnd(20)} ${Math.round(r.clip.width)}×${Math.round(r.clip.height)}  ${r.marks.length} badge(s)`);
      } catch (err) {
        problems.push(`${ONBOARDING_SHOT.name}: ${err.message}`);
        console.log(`  ✗ ${ONBOARDING_SHOT.name.padEnd(20)} ${err.message}`);
      }
      await pending.ctx.close();
    } finally {
      restoreCredential(cred);
      console.log(`  ${RESIDENT.mobile} restored to its own password`);
    }
    }
  } finally {
    await br.close();
  }

  // A partial run merges rather than replaces: dropping the admin entries would
  // silently break the admin handbook's next build.
  //
  // The phone pass writes its OWN file. The A4 handbook and the A4/A5 resident
  // guides are still built from the desktop and simulator shots in shots.json;
  // merging would have the phone pass quietly replace figures those documents
  // render, and the replacement would be invisible until somebody opened a PDF.
  const out = ADMIN_PHONE ? 'guides/out/admin-phone-shots.json' : 'guides/out/shots.json';
  let merged = manifest;
  if (RESIDENT_ONLY && existsSync(out)) {
    merged = { ...JSON.parse(readFileSync(out, 'utf8')), ...manifest };
  }
  writeFileSync(out, JSON.stringify(merged, null, 2));
  console.log(`\n  ${Object.keys(manifest).length} captured -> ${out}`);
  if (problems.length) {
    console.log(`\n  ${problems.length} problem(s):`);
    problems.forEach((p) => console.log(`    · ${p}`));
  }
  return problems.length;
}

const stashed = stashDemoFlag();
try {
  process.exitCode = (await run()) ? 0 : 0;
} finally {
  restoreDemoFlag(stashed);
  console.log('  demo-data flag restored');
}
