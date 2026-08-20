/**
 * Self-checks — the building's invariants, written down as assertions.
 *
 * WHY THIS EXISTS. Every real bug this system has had was an invariant
 * violation that no code was watching for:
 *
 *   * mobiles stored in two different spellings, so the UNIQUE index stopped
 *     protecting anything and two accounts shared a login number;
 *   * new residents written as bare digits after login started normalising to
 *     E.164, so an account could be created that could never log in;
 *   * wa.me links built by string concatenation, dead on every reset;
 *   * a bill total that no longer matched its own components.
 *
 * None of those threw. They were all found by a human looking at output and
 * noticing. This module is the attempt to stop relying on that: state each
 * rule once, check it on demand, and report the rows that break it.
 *
 * Pure — every check takes rows and returns findings, so it is testable
 * without a database and runs identically from the CLI and from god mode.
 *
 * Severity is about what to do, not how bad it feels:
 *   fail — something is broken now; a resident is affected or will be
 *   warn — will break, or hides a real problem
 *   info — worth knowing, not wrong
 */

import { computedTotal, isUnexplainedMismatch } from './godedit.js';

export const SEVERITIES = ['fail', 'warn', 'info'];

function finding(severity, id, title, detail, rows = []) {
  return { severity, id, title, detail, rows, count: rows.length };
}

/* ── redaction ───────────────────────────────────────────────────────────── */

/**
 * A diagnostics report is written to be pasted into a chat window, so it must
 * be safe to paste. Enough of a number to recognise who it is, not enough to
 * be the number.
 */
export function maskMobile(mobile) {
  const s = String(mobile ?? '');
  if (s.length < 6) return '***';
  return `${s.slice(0, 5)}${'*'.repeat(Math.max(0, s.length - 8))}${s.slice(-3)}`;
}

export function maskEmail(email) {
  if (!email) return null;
  const [user, domain] = String(email).split('@');
  if (!domain) return '***';
  return `${user.slice(0, 2)}***@${domain}`;
}

/* ── the checks ──────────────────────────────────────────────────────────── */

/**
 * Mobiles are the login identity. Two spellings of one number defeat both the
 * UNIQUE index and the login lookup, which is exactly how one number ended up
 * on two accounts.
 */
export function checkMobiles(owners) {
  const out = [];

  const notE164 = owners.filter((o) => !String(o.mobile ?? '').startsWith('+'));
  if (notE164.length) {
    out.push(finding('fail', 'MOBILE-FORMAT',
      'Mobile numbers not stored in E.164',
      'Login normalises to +91…, so these accounts cannot log in at all. '
      + 'A write path is skipping normaliseMobile.',
      notE164.map((o) => ({ flat: o.flat, name: o.name, mobile: maskMobile(o.mobile) }))));
  }

  // Compared on digits, because the whole failure mode is two spellings that
  // a plain string comparison treats as different.
  const byDigits = new Map();
  for (const o of owners) {
    const key = String(o.mobile ?? '').replace(/\D/g, '').slice(-10);
    if (!key) continue;
    byDigits.set(key, [...(byDigits.get(key) ?? []), o]);
  }
  const dupes = [...byDigits.values()].filter((group) => group.length > 1);
  if (dupes.length) {
    out.push(finding('fail', 'MOBILE-DUPLICATE',
      'One number on more than one account',
      'Whoever logs in gets whichever row the query returns first.',
      dupes.map((g) => ({
        mobile: maskMobile(g[0].mobile),
        accounts: g.map((o) => `${o.flat} ${o.name}`).join(' + '),
      }))));
  }

  return out;
}

/** Email will be the OTP address, so a shared one is a shared account. */
export function checkEmails(owners) {
  const seen = new Map();
  for (const o of owners) {
    const e = (o.email ?? '').trim().toLowerCase();
    if (!e) continue;
    seen.set(e, [...(seen.get(e) ?? []), o]);
  }
  const dupes = [...seen.entries()].filter(([, g]) => g.length > 1);
  return dupes.length
    ? [finding('warn', 'EMAIL-DUPLICATE', 'One email on more than one account',
        'Password reset by email would send both accounts to the same inbox.',
        dupes.map(([e, g]) => ({ email: maskEmail(e), accounts: g.map((o) => o.flat).join(' + ') })))]
    : [];
}

/**
 * The role can move but never be copied, and never vanish. Zero is worse than
 * two: nobody can administer the portal and there is no in-app way back.
 */
export function checkSuperadmin(owners) {
  const supers = owners.filter((o) => o.role === 'superadmin' && o.active);
  if (supers.length === 1) return [];
  if (supers.length === 0) {
    return [finding('fail', 'SUPERADMIN-NONE', 'No active superadmin',
      'God mode is unreachable. Recover with scripts/reset-my-password.mjs, '
      + 'or set the role directly in D1.')];
  }
  return [finding('fail', 'SUPERADMIN-MANY', `${supers.length} active superadmins`,
    'The single-superadmin rule has been bypassed, probably by a direct D1 write.',
    supers.map((o) => ({ flat: o.flat, name: o.name })))];
}

/**
 * A bill whose total does not match its components is either corruption or an
 * acknowledged override. Only the first is a problem — hence manual_total.
 */
export function checkBills(bills) {
  const out = [];

  const broken = bills.filter(isUnexplainedMismatch);
  if (broken.length) {
    out.push(finding('fail', 'BILL-MISMATCH',
      'Bills whose total does not match their own components',
      'This is the DDP-BILL-003 condition. Either the components were changed '
      + 'outside the app, or an override was written without manual_total.',
      broken.map((b) => ({
        flat: b.flat, period: b.period, total: b.total, components: computedTotal(b),
      }))));
  }

  /**
   * Bills carrying a typed amount, from the path that no longer exists.
   *
   * THIS NUMBER IS MEANT TO REACH ZERO. Until 2026-08-20 a bill's total could
   * be typed directly and `manual_total` marked it as somebody's considered
   * decision; the amount is now never editable, and the two things that can be
   * wrong with a bill — the reading and the month's price of gas — are
   * corrected as themselves. `editBill` refuses `total` outright, so nothing
   * can add to this count any more.
   *
   * The column stays, and `changeRate` goes on skipping these rows, because
   * dropping a column in SQLite is a table rebuild and these bills are real
   * history. Counted here so the number is visible rather than assumed: when it
   * reads zero, the column and its guards can go in a follow-up that costs
   * nothing.
   */
  const overridden = bills.filter((b) => b.manual_total);
  if (overridden.length) {
    out.push(finding('info', 'BILL-OVERRIDE', 'Bills carrying a typed amount',
      'Written by the amount-editing path retired on 2026-08-20, when the rule '
      + 'became that a bill\'s amount is visible and never editable. Nothing can '
      + 'add to this list now. A rate change leaves these rows alone, so they '
      + 'are the bills that will not follow a price correction — and when this '
      + 'count reaches zero the manual_total column can be removed.',
      overridden.map((b) => ({
        flat: b.flat, period: b.period, total: b.total,
        components: computedTotal(b), reason: b.adjust_reason ?? '(none recorded)',
      }))));
  }

  const negative = bills.filter((b) => Number(b.total) < 0);
  if (negative.length) {
    out.push(finding('fail', 'BILL-NEGATIVE', 'Bills with a negative total',
      'The portal cannot charge a negative amount; the UPI link will be invalid.',
      negative.map((b) => ({ flat: b.flat, period: b.period, total: b.total }))));
  }

  return out;
}

/**
 * A rate silently carried forward is the worst failure available here: every
 * bill looks normal and every one is wrong.
 */
export function checkPeriods(periods) {
  const out = [];

  const noRate = periods.filter((p) => !(Number(p.rate_per_kg) > 0));
  if (noRate.length) {
    out.push(finding('warn', 'PERIOD-NO-RATE', 'Months with no rate set',
      'Bill generation is blocked for these until a rate is entered.',
      noRate.map((p) => ({ period: p.period }))));
  }

  const noConversion = periods.filter((p) => !(Number(p.conversion_factor) > 0));
  if (noConversion.length) {
    out.push(finding('fail', 'PERIOD-NO-CONVERSION', 'Months with no conversion factor',
      'The meter counts cubic metres and the bill charges kilograms. Without '
      + 'the factor every flat is under-billed roughly 2.6x.',
      noConversion.map((p) => ({ period: p.period }))));
  }

  return out;
}

/** Bills and proofs belong to a person; readings belong to the property. */
export function checkOwnership(bills, proofs) {
  const out = [];
  const orphanBills = bills.filter((b) => b.owner_id == null);
  if (orphanBills.length) {
    out.push(finding('warn', 'BILL-NO-OWNER', 'Bills not attached to a person',
      'After a sale the new owner would see these. See the privacy note in the README.',
      orphanBills.map((b) => ({ flat: b.flat, period: b.period }))));
  }
  const orphanProofs = proofs.filter((p) => p.owner_id == null);
  if (orphanProofs.length) {
    out.push(finding('warn', 'PROOF-NO-OWNER', 'Payment screenshots not attached to a person',
      'A screenshot is a fact about a person, not a flat.',
      orphanProofs.map((p) => ({ id: p.id, bill_id: p.bill_id }))));
  }
  return out;
}

/** Rows pointing at things that no longer exist. */
export function checkIntegrity({ owners, flats, readings }) {
  const known = new Set(flats.map((f) => f.flat));
  const out = [];

  const homeless = owners.filter((o) => o.active && o.flat && !known.has(o.flat));
  if (homeless.length) {
    out.push(finding('fail', 'OWNER-NO-FLAT', 'Residents whose flat is not on the register',
      'They will fail to load a dashboard.',
      homeless.map((o) => ({ name: o.name, flat: o.flat }))));
  }

  /**
   * A flat still on the billing roll with nobody on file.
   *
   * THE CONSEQUENCE IS OUT OF ALL PROPORTION TO THE CAUSE, which is why this
   * had to become a check rather than a thing somebody notices. `occupantOf`
   * returns null for it, so there is nobody to bill and nobody to send a bill
   * to — but `flats.active` is still 1, so it stays on the reading grid and
   * counts towards `expectedFlats`. Generation refuses a partial month by
   * design (a missing flat means somebody silently never gets billed), so ONE
   * unsold flat nobody remembered to mark inactive blocks billing for all 89.
   *
   * And the screen does not say so. It says "88 of 89 entered", which reads as
   * a meter walk that is nearly finished rather than a month that cannot close
   * — the treasurer goes looking for a reading that does not exist, for a flat
   * with no meter, belonging to nobody.
   *
   * The fix is one field on the Residents tab: set the flat to "no owner" and
   * stop billing it. `fail` rather than `warn` because a month is already
   * unable to close, today, not eventually.
   */
  const occupied = new Set(owners.filter((o) => o.active).map((o) => o.flat));
  const empty = flats.filter((f) => f.active && !occupied.has(f.flat));
  if (empty.length) {
    out.push(finding('fail', 'FLAT-BILLED-NO-OWNER', 'Flats being billed with nobody on file',
      'Each needs a meter reading before ANY month can be generated — generation '
      + 'refuses a partial month, so one of these blocks billing for the whole '
      + 'building while the grid only says how many flats are still to enter. '
      + 'Set the flat to "no owner" on the Residents tab and stop billing it, or '
      + 'add the owner.',
      empty.map((f) => ({ flat: f.flat, floor: f.floor }))));
  }

  // Meters do not run backwards. A lower reading is a typo or a replaced meter.
  const byFlat = new Map();
  for (const r of [...readings].sort((a, b) => a.period.localeCompare(b.period))) {
    const prev = byFlat.get(r.flat);
    if (prev != null && Number(r.reading) < Number(prev.reading)) {
      out.push(finding('fail', 'READING-BACKWARDS', 'A meter reading lower than the month before',
        'Either a typo, or the meter was replaced and needs its own note.',
        [{ flat: r.flat, period: r.period, reading: r.reading, previous: prev.reading }]));
    }
    byFlat.set(r.flat, r);
  }

  return out;
}

/**
 * Tenancy gaps — the ones that are invisible until money is owed.
 *
 * Neither of these throws, and neither shows up anywhere in the UI. They
 * surface at the worst possible moment: a tenant leaves owing rent and nobody
 * can say who is liable, or two people are billed for one meter.
 */
export function checkTenancy(owners) {
  const out = [];
  const active = owners.filter((o) => o.active);

  const byFlat = new Map();
  for (const o of active) byFlat.set(o.flat, [...(byFlat.get(o.flat) ?? []), o]);

  const orphaned = [...byFlat.entries()].filter(([, people]) =>
    people.some((p) => p.relationship === 'tenant')
    && !people.some((p) => p.relationship === 'owner'));
  if (orphaned.length) {
    out.push(finding('warn', 'TENANT-NO-OWNER', 'Let flats with no owner on record',
      'The tenant is billed, but nobody is liable if they leave owing. '
      + 'The liability rule has nothing to point at.',
      orphaned.map(([flat, people]) => ({
        flat, tenant: people.find((p) => p.relationship === 'tenant')?.name,
      }))));
  }

  const crowded = [...byFlat.entries()].filter(([, people]) =>
    people.filter((p) => p.relationship === 'tenant').length > 1);
  if (crowded.length) {
    out.push(finding('warn', 'TWO-TENANTS', 'Flats with more than one active tenant',
      'One meter, one bill — whichever tenant the query returns first is billed '
      + 'and the other is not. Deactivate whoever has left.',
      crowded.map(([flat, people]) => ({
        flat, tenants: people.filter((p) => p.relationship === 'tenant')
          .map((p) => p.name).join(' + '),
      }))));
  }

  const twoOwners = [...byFlat.entries()].filter(([, people]) =>
    people.filter((p) => p.relationship === 'owner').length > 1);
  if (twoOwners.length) {
    out.push(finding('info', 'TWO-OWNERS', 'Flats with more than one owner account',
      'Joint owners are legitimate, but only one is treated as liable. Listed '
      + 'so the choice is deliberate rather than whichever row came first.',
      twoOwners.map(([flat, people]) => ({
        flat, owners: people.filter((p) => p.relationship === 'owner')
          .map((p) => p.name).join(' + '),
      }))));
  }

  return out;
}

/**
 * Is generated demo data still sitting in the database?
 *
 * Put here rather than only in a document because a document goes stale the
 * day the data is removed, and a stale warning is worse than none — it trains
 * people to ignore the next one. This reads the database, so it is true or
 * silent, never wrong.
 *
 * It matters because the demo occupies the same tables the real roster will
 * use: importing on top of it means meeting 99 flats that already exist.
 */
export function checkDemoData(owners, marker) {
  const demo = owners.filter((o) => /\[demo\]$/.test(String(o.name ?? '')));
  if (!demo.length && !marker) return [];

  return [finding('warn', 'DEMO-DATA-PRESENT',
    `${demo.length} generated demo residents are in this database`,
    'Fine for user testing, and it must come out before the real roster: the '
    + 'import would meet flats that already exist. Remove with '
    + 'node scripts/seed-demo.mjs --remote --remove',
    [{ residents: demo.length, flats: new Set(demo.map((o) => o.flat)).size }])];
}

/**
 * Who is currently exempt from late fees.
 *
 * The whole risk this feature carries is an exemption granted during one
 * dispute and still running two years later, invisible to whoever inherited
 * the treasurer's job. The end date makes that unlikely; listing them here
 * makes it visible, which is the part a date alone cannot do.
 */
export function checkExemptions(owners, today = new Date().toISOString().slice(0, 10)) {
  const active = owners.filter((o) =>
    o.active && o.late_fee_exempt_until && o.late_fee_exempt_until >= today);
  if (!active.length) return [];

  return [finding('info', 'LATE-FEE-EXEMPT',
    `${active.length} ${active.length === 1 ? 'resident is' : 'residents are'} exempt from late fees`,
    'Granted by the committee and dated. Listed so they are noticed while they '
    + 'are still running, rather than after somebody asks why.',
    active.map((o) => ({
      flat: o.flat, name: o.name, until: o.late_fee_exempt_until,
      reason: o.late_fee_exempt_reason ?? '(none recorded)',
    })))];
}

/**
 * Can residents reset their own password?
 *
 * Two separate ways this fails, and they need different fixes: nobody can
 * reset if the mail path is unconfigured, and an individual cannot reset if
 * their account has no email — which is invisible until they are locked out
 * and phoning somebody.
 */
export function checkResetPath({ mailConfigured, remote }, owners = []) {
  const out = [];
  if (remote && !mailConfigured) {
    out.push(finding('warn', 'MAIL-NOT-CONFIGURED', 'Password reset by email is not available',
      'Every resident who forgets a password has to go through an admin. '
      + 'Needs GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN and MAIL_FROM.'));
  }

  const active = owners.filter((o) => o.active);
  const without = active.filter((o) => !o.email);
  if (active.length && without.length) {
    out.push(finding('info', 'NO-EMAIL-ON-FILE',
      `${without.length} of ${active.length} accounts cannot reset their own password`,
      'No email on file, so the emailed code has nowhere to go. They fall back '
      + 'to a superadmin reset, since admins no longer reset passwords at all. '
      + 'Onboarding asks for one, but it is optional.',
      without.map((o) => ({ flat: o.flat, name: o.name }))));
  }
  return out;
}

/**
 * Has the digest actually been running?
 *
 * The digest is the only thing that surfaces 22 of the warn codes, and it is
 * silent by design when nothing happened — so "no digest arrived" is
 * indistinguishable from "a quiet night" unless the watermark is checked.
 * A digest that quietly stopped would take every warning down with it.
 */
export function checkDigest({ lastDigestAt, remote, now = new Date() }) {
  if (!remote) return [];
  if (!lastDigestAt) {
    return [finding('info', 'DIGEST-NEVER', 'The daily digest has not run yet',
      'Expected until the first nightly run after deploying it.')];
  }
  const hours = (now - new Date(lastDigestAt)) / 3600_000;
  if (hours > 48) {
    return [finding('warn', 'DIGEST-STALE', 'The daily digest has not run for over 48 hours',
      'Warnings are accumulating unreported. Check the cron trigger and the '
      + 'Telegram secrets — the watermark only advances on a delivery that succeeded.',
      [{ lastRun: lastDigestAt, hoursAgo: Math.round(hours) }])];
  }
  return [];
}

/**
 * Is a copy of the data actually leaving the building?
 *
 * The failure mode here is silence, and it is a documented one: a refresh token
 * issued while the OAuth consent screen is in "Testing" mode expires after
 * seven days, at which point the nightly upload simply stops. Nothing throws
 * where anyone is looking, and a folder that stopped filling looks exactly like
 * a folder nobody has opened. backupHealth answers "would the token work right
 * now"; only the watermark answers "did a file actually land".
 *
 * Warn rather than fail, because D1's Time Travel is the real disaster-recovery
 * path. What this protects is the other promise: that the committee can open
 * the data in Excel without a developer, which is the mistake this whole
 * project exists to not repeat.
 *
 * Configuration is asked of both deployments, not one. Two Workers over one
 * database means secrets set on Pages never reach the cron Worker, and it is
 * the cron Worker that runs the upload — so the half-configured state reads as
 * healthy from inside the site while nothing at all is being written.
 */
export function checkBackup({ lastBackupAt, driveConfigured, committeeShared,
  remote, now = new Date() }) {
  if (!remote) return [];

  // Either shape, for the same reason as alerting: god mode can only see its
  // own bindings and answers with a boolean, while the CLI can ask both
  // deployments and answers with detail.
  const d = typeof driveConfigured === 'object' && driveConfigured !== null
    ? driveConfigured
    : { cron: driveConfigured, pages: driveConfigured };

  if (!d.cron && !d.pages) {
    return [finding('warn', 'BACKUP-NOT-CONFIGURED', 'Nothing is being backed up off-site',
      'runBackup returns early every night. The only copies of this building\'s '
      + 'billing history are in D1. Needs GOOGLE_BACKUP_FOLDER_ID, plus a client '
      + 'id, secret and refresh token — the GOOGLE_BACKUP_ ones if the backup has '
      + 'its own Google account, otherwise the shared GOOGLE_ ones. '
      + 'Run npm run google:auth.')];
  }
  if (!d.cron) {
    // The worst of the three states, and the one that looks best from inside
    // the site: the Export tab reports a valid token and a reachable folder,
    // because Pages has the secrets — but the backup runs on the cron Worker,
    // which does not, so it returns early every night and writes nothing.
    return [finding('warn', 'BACKUP-CRON-UNCONFIGURED',
      'The backup secrets are on Pages but not on the cron Worker',
      'Nothing is being backed up. The Export tab will say the token is valid, '
      + 'because that check runs on Pages; the nightly upload runs on the cron '
      + 'Worker and returns early. Set the four GOOGLE_ secrets with '
      + '`wrangler secret put` as well as `wrangler pages secret put`.')];
  }
  // Not a return: the copies are still being written, so the watermark below
  // remains the question worth asking. This only says the report is blind.
  const out = [];
  if (!d.pages) {
    // Harmless to the copies themselves, which is exactly why it is worth
    // naming separately: the backup works and the page that reports on it does
    // not, so the committee is told there is no backup when there is one.
    out.push(finding('info', 'BACKUP-PAGES-UNCONFIGURED',
      'The backup runs, but the Export tab cannot see it',
      'The cron Worker has the secrets and is writing nightly copies. Pages '
      + 'does not, so the admin Export tab reports "not set up yet" to a '
      + 'committee whose backup is fine. Add the same four secrets with '
      + '`wrangler pages secret put --project-name diamondpark`.'));
  }

  // Explicitly false, not merely falsy: a caller that did not ask the question
  // must not be told the answer is no.
  if (committeeShared === false) {
    // Sharing in Drive inherits downward. One folder shared with the committee
    // is the roster shared with the committee, and it happens the moment
    // somebody shares the parent to hand over the proof screenshots.
    out.push(finding('warn', 'BACKUP-ONE-FOLDER',
      'Proofs and the data export are in the same Drive folder',
      'That folder cannot be shared with the committee without also sharing the '
      + 'nightly CSV of every resident\'s name, mobile, email and payment '
      + 'history. Make a second folder and set GOOGLE_COMMITTEE_FOLDER_ID to it.'));
  }

  if (!lastBackupAt) {
    out.push(finding('info', 'BACKUP-NEVER', 'The nightly backup has not run yet',
      'Expected until the first 3am run after configuring it.'));
    return out;
  }
  const hours = (now - new Date(lastBackupAt)) / 3600_000;
  if (hours > 48) {
    out.push(finding('warn', 'BACKUP-STALE', 'The nightly backup has not run for over 48 hours',
      'Check the refresh token first — one issued in OAuth "Testing" mode expires '
      + 'after seven days and the upload then fails silently. The watermark only '
      + 'advances on an upload that returned.',
      [{ lastRun: lastBackupAt, hoursAgo: Math.round(hours) }]));
  }
  return out;
}

/** Things that are only wrong in production. */
export function checkConfig({ upiVpa, alerting, alertingConfigured, visionConfigured, remote }) {
  const out = [];
  if (!upiVpa) {
    out.push(finding(remote ? 'fail' : 'warn', 'CONFIG-NO-VPA', 'No UPI payee configured',
      'Every Pay button produces an invalid link.'));
  }
  if (!remote) return out;

  // Accepts either shape: a single boolean from the god-mode endpoint, which
  // can only see its own bindings, or per-deployment detail from the CLI.
  const a = alerting ?? { cron: alertingConfigured, pages: alertingConfigured };

  if (!a.cron && !a.pages) {
    out.push(finding('warn', 'CONFIG-NO-ALERTS', 'Error alerting is not configured',
      'Fatal errors land in error_log and are visible in the activity log, but nothing '
      + 'is pushed anywhere — you find out by looking.'));
  } else if (!a.cron || !a.pages) {
    // The trap worth naming: two Workers over one database, so secrets set on
    // one do not reach the other, and the half that works hides the half that
    // does not.
    out.push(finding('warn', 'CONFIG-HALF-ALERTS',
      `Alerting is configured on ${a.pages ? 'Pages' : 'the cron Worker'} only`,
      a.cron
        ? 'The nightly digest will send, but instant alerts from the site will not.'
        : 'Instant alerts will send, but the nightly digest will not.'));
  }

  // THE CHECK THAT WOULD HAVE SAVED A REHEARSAL. `wrangler pages secret put` was
  // run with the key pasted at the NAME prompt, so production carried a secret
  // called `gsk_...` and no GROQ_API_KEY at all. visionAvailable() returned
  // false, every upload short-circuited, and nothing anywhere said so — the
  // whole first proof round ran with no OCR and looked normal.
  //
  // A warning rather than a failure, and the wording matters: nobody is stopped
  // from paying a bill by this. The treasurer just types every amount by hand
  // and has no way to know that is why.
  if (!visionConfigured) {
    out.push(finding('warn', 'VISION-NOT-CONFIGURED', 'Payment screenshots are not being read',
      'No GROQ_API_KEY or GEMINI_API_KEY is bound, so every uploaded proof queues '
      + 'with its amount blank for the treasurer to fill in. Note that Pages binds '
      + 'secrets at DEPLOY time — setting one without redeploying leaves this '
      + 'warning true and correct.'));
  }
  return out;
}

/* ── assembling a report ─────────────────────────────────────────────────── */

/**
 * An empty table and an unreadable one are NOT the same thing.
 *
 * A transient failure reading `owners` once made this report SUPERADMIN-NONE —
 * "god mode is unreachable" — against a database whose superadmin was
 * perfectly fine. A health tool that cries wolf on a network blip teaches
 * people to ignore it, which is worse than not having one.
 *
 * So a caller that could not read something says so, and the checks depending
 * on it are skipped rather than fed an empty array.
 */
export function runChecks(data) {
  const missing = new Set(data.unavailable ?? []);
  const have = (...tables) => tables.every((t) => !missing.has(t));

  if (missing.size) {
    return [
      finding('warn', 'DATA-UNREADABLE', 'Some tables could not be read',
        'These checks were skipped, not passed. Re-run before drawing any '
        + 'conclusion from what is below.',
        [...missing].map((t) => ({ table: t }))),
      ...runAvailable(data, have),
    ];
  }
  return runAvailable(data, have);
}

function runAvailable(data, have) {
  return [
    ...(have('owners') ? checkMobiles(data.owners ?? []) : []),
    ...(have('owners') ? checkEmails(data.owners ?? []) : []),
    ...(have('owners') ? checkSuperadmin(data.owners ?? []) : []),
    ...(have('bills') ? checkBills(data.bills ?? []) : []),
    ...(have('periods') ? checkPeriods(data.periods ?? []) : []),
    ...(have('bills', 'payment_proofs') ? checkOwnership(data.bills ?? [], data.proofs ?? []) : []),
    ...(have('owners', 'flats', 'readings')
      ? checkIntegrity({ owners: data.owners ?? [], flats: data.flats ?? [], readings: data.readings ?? [] })
      : []),
    ...checkConfig(data.config ?? {}),
    ...(have('owners') ? checkResetPath(data.config ?? {}, data.owners ?? []) : []),
    ...(have('owners') ? checkTenancy(data.owners ?? []) : []),
    ...(have('owners') ? checkExemptions(data.owners ?? []) : []),
    ...(have('owners') ? checkDemoData(data.owners ?? [], data.demoMarker) : []),
    ...checkDigest({ ...(data.config ?? {}), lastDigestAt: data.lastDigestAt ?? null }),
    ...checkBackup({ ...(data.config ?? {}), lastBackupAt: data.lastBackupAt ?? null }),
  ].sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity));
}

export function summarise(findings) {
  const by = (s) => findings.filter((f) => f.severity === s).length;
  return { fail: by('fail'), warn: by('warn'), info: by('info'), healthy: by('fail') + by('warn') === 0 };
}

/**
 * Markdown, because the destination is a chat window. Rows are capped: a
 * report nobody pastes because it is 900 lines long has failed at its job.
 */
export function toMarkdown({ findings, errors = [], meta = {} }) {
  const s = summarise(findings);
  const lines = [
    `# Diamond Park — diagnostics`,
    '',
    `${meta.environment ?? 'unknown'} · ${meta.generatedAt ?? new Date().toISOString()}`,
    '',
    s.healthy
      ? '**Every check passed.**'
      : `**${s.fail} failing, ${s.warn} warnings, ${s.info} notes.**`,
    '',
  ];

  if (meta.counts) {
    lines.push('| | |', '|---|---|',
      ...Object.entries(meta.counts).map(([k, v]) => `| ${k} | ${v} |`), '');
  }

  for (const f of findings) {
    lines.push(`## ${f.severity.toUpperCase()} · ${f.id} — ${f.title}`, '', f.detail, '');
    if (f.rows.length) {
      const shown = f.rows.slice(0, 20);
      const cols = Object.keys(shown[0]);
      lines.push(`| ${cols.join(' | ')} |`, `|${cols.map(() => '---').join('|')}|`,
        ...shown.map((r) => `| ${cols.map((c) => r[c] ?? '').join(' | ')} |`));
      if (f.rows.length > shown.length) lines.push(`| …${f.rows.length - shown.length} more | |`);
      lines.push('');
    }
  }

  if (errors.length) {
    lines.push('## Recent errors', '', '| when | code | meaning |', '|---|---|---|',
      ...errors.slice(0, 25).map((e) => `| ${e.at ?? ''} | \`${e.code}\` | ${e.message ?? ''} |`), '');
  }

  lines.push('---', '',
    'Mobiles and emails are masked. No password hashes, session tokens or ',
    'screenshot contents appear here — this is written to be pasted as-is.', '');

  return lines.join('\n');
}
