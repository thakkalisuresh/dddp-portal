/**
 * The rules a poll must obey, shared by the browser and the Worker.
 *
 * IN public/ AND IMPORTED BY functions/, the same direction association.js
 * already runs. The form and the server have to agree about what a valid poll
 * is — a form that shows friendlier rules than the server enforces is a form
 * that lies, and the creator finds out after writing the whole thing.
 *
 * Nothing in here touches D1, the DOM, or `fail()`. Every function returns
 * `{ ok, message }` and the caller decides whether that becomes a red line
 * under a field or a 400.
 */

export const MAX_TITLE = 140;
export const MAX_BODY = 2000;
export const MAX_OPTION = 120;
export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 10;

/**
 * Words that make a pair of options a yes/no question.
 *
 * Used for ONE purpose: refusing a multi-select whose two options are a yes and
 * a no. "Pick up to 2 of {Yes, No}" is not a question, it is a mistake — and a
 * mistake that produces a result nobody can read rather than an error anybody
 * can fix.
 *
 * Deliberately a small closed list rather than anything clever. It has to be
 * explainable in the error message, and a creator who is refused needs to know
 * why in the same sentence.
 */
const AFFIRMATIVE = new Set(['yes', 'y', 'agree', 'for', 'approve', 'accept']);
const NEGATIVE = new Set(['no', 'n', 'disagree', 'against', 'reject', 'decline']);

const norm = (s) => String(s ?? '').trim().toLowerCase();

/** Exactly two options, one reading as yes and the other as no. */
export function isYesNoPair(labels = []) {
  if (labels.length !== 2) return false;
  const [a, b] = labels.map(norm);
  return (AFFIRMATIVE.has(a) && NEGATIVE.has(b))
      || (NEGATIVE.has(a) && AFFIRMATIVE.has(b));
}

/**
 * Everything that must be true before a poll may be posted.
 *
 * Returns `{ ok, message }` rather than throwing, matching validateComment and
 * validateAttachment: the caller turns it into a 400 with the message shown to
 * the person who typed it. A creator who is refused should be told what to
 * change, never just that something was wrong.
 */
export function validatePoll({
  title, body, multi = false, maxChoices = null, options = [], closesAt, now,
} = {}) {
  const t = String(title ?? '').trim();
  const b = String(body ?? '').trim();
  if (!t) return { ok: false, message: 'Give the poll a question as its title.' };
  if (t.length > MAX_TITLE) return { ok: false, message: `Keep the title under ${MAX_TITLE} characters.` };
  if (!b) return { ok: false, message: 'Say what the poll is about.' };
  if (b.length > MAX_BODY) return { ok: false, message: `Keep the description under ${MAX_BODY} characters.` };

  const labels = options.map((o) => String(o?.label ?? '').trim()).filter(Boolean);
  if (labels.length < MIN_OPTIONS) {
    return { ok: false, message: `A poll needs at least ${MIN_OPTIONS} options.` };
  }
  if (labels.length > MAX_OPTIONS) {
    return { ok: false, message: `A poll can have at most ${MAX_OPTIONS} options.` };
  }
  if (labels.some((l) => l.length > MAX_OPTION)) {
    return { ok: false, message: `Keep each option under ${MAX_OPTION} characters.` };
  }
  // Two options with the same text produce a result nobody can act on: the
  // count splits between them and neither figure is the answer.
  if (new Set(labels.map(norm)).size !== labels.length) {
    return { ok: false, message: 'Two options say the same thing. Make each one distinct.' };
  }

  if (multi) {
    // The guard asked for on 2026-09-09, and the reason it is an error rather
    // than a warning: there is no reading of "pick up to two of yes and no"
    // that produces an answer.
    if (isYesNoPair(labels)) {
      return {
        ok: false,
        message: 'A yes/no question cannot be multi-select — a flat cannot pick '
          + 'both. Make it single choice, or give it more options.',
      };
    }
    const cap = Number(maxChoices);
    if (!Number.isInteger(cap) || cap < 1) {
      return { ok: false, message: 'Say how many options a flat may pick.' };
    }
    // "Up to 1" IS single choice, and allowing both spellings would put the
    // same poll in the database two ways — multi with a cap of one, and
    // single. Two representations of one thing drift, and the counting code
    // would have to know about both for ever.
    if (cap === 1) {
      return {
        ok: false,
        message: 'Picking up to 1 is the same as single choice. '
          + 'Raise the limit, or switch to “pick one option”.',
      };
    }
    // A ceiling at or above the option count is not a ceiling. It lets a flat
    // tick everything, which is an abstention that looks like participation.
    if (cap >= labels.length) {
      return {
        ok: false,
        message: `Picking up to ${cap} of ${labels.length} lets a flat choose `
          + 'everything. Lower the limit, or make it single choice.',
      };
    }
  } else if (maxChoices != null) {
    return { ok: false, message: 'A single-choice poll has no pick limit.' };
  }

  const closes = Date.parse(closesAt);
  if (!Number.isFinite(closes)) {
    return { ok: false, message: 'Give the poll a closing date and time.' };
  }
  if (now != null && closes <= Date.parse(now)) {
    return { ok: false, message: 'The closing time has already passed.' };
  }

  return { ok: true };
}

/**
 * How fast this portal can mail the building, and what that means for a poll.
 *
 * The numbers are not ours to choose. `sendEmail` refreshes an OAuth token per
 * call, so a naive loop costs two subrequests per message against the free
 * plan's 50 per invocation; announce.js solves it by minting one token per
 * drain and taking twenty rows at a time. Three crons a day times twenty is
 * sixty sends, and an admin draining by hand from the console is the only way
 * to go faster.
 *
 * Repeated here rather than imported because this module is pure and its tests
 * should not have to load the mailer, the PDF builder and the letterhead to ask
 * an arithmetic question. If DRAIN_SIZE moves in announce.js, move it here.
 */
export const DRAIN_SIZE = 20;
export const CRON_RUNS_PER_DAY = 3;
export const SENDS_PER_DAY = DRAIN_SIZE * CRON_RUNS_PER_DAY;

const DAY_MS = 86_400_000;

/**
 * Warnings the creation form shows BEFORE a short poll is posted.
 *
 * There is no minimum duration — the creator decides, and that was deliberate.
 * But a poll closing sooner than the emails can be delivered is a poll of
 * whoever happened to open the portal, and the creator should meet that fact
 * while they can still change the date rather than afterwards.
 *
 * Returns plain sentences, not codes. They are shown, not branched on.
 */
export function deliveryWarnings({ createdAt, closesAt, recipients = 0 }) {
  const from = Date.parse(createdAt);
  const to = Date.parse(closesAt);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return [];
  if (!recipients) return [];

  const daysToSend = recipients / SENDS_PER_DAY;
  const openDays = (to - from) / DAY_MS;
  const out = [];

  if (openDays < daysToSend) {
    out.push(
      `Emailing ${recipients} owners takes about ${fmtDays(daysToSend)}, and this `
      + `poll closes in ${fmtDays(openDays)}. Some will hear about it after voting ends.`
    );
  }
  // The reminder is queued at the midpoint and drains at the same rate, so it
  // needs half the poll's life to be at least as long as one mailing.
  if (openDays / 2 < daysToSend) {
    out.push(
      'The reminder goes out halfway through, which is too late for it to reach '
      + 'everyone before this poll closes.'
    );
  }
  return out;
}

const fmtDays = (d) => {
  if (d < 1) {
    const h = Math.max(1, Math.round(d * 24));
    return `${h} hour${h === 1 ? '' : 's'}`;
  }
  const r = Math.round(d * 10) / 10;
  return `${r} day${r === 1 ? '' : 's'}`;
};

/**
 * Is this ballot one the poll will accept?
 *
 * Checked here rather than in the handler so the rule can be tested without a
 * database, and so the client and the server cannot disagree about it — the
 * form greys its Submit using the same function.
 */
export function validateBallot(poll, optionIds = [], validIds = []) {
  const ids = [...new Set(optionIds.map(Number))].filter(Number.isInteger);
  if (!ids.length) return { ok: false, message: 'Choose an option first.' };

  const known = new Set(validIds.map(Number));
  if (ids.some((id) => !known.has(id))) {
    // Not a message a resident should ever meet: it means the form and the poll
    // disagree, which is a stale page or a hand-made request.
    return { ok: false, message: 'That option is not on this poll.' };
  }
  if (!poll?.multi) {
    if (ids.length > 1) return { ok: false, message: 'This poll takes one answer.' };
    return { ok: true, ids };
  }
  const cap = Number(poll.max_choices);
  if (ids.length > cap) {
    return { ok: false, message: `Pick at most ${cap} option${cap === 1 ? '' : 's'}.` };
  }
  return { ok: true, ids };
}

/**
 * Are the options frozen?
 *
 * Title and description stay editable for ever; the options stop being editable
 * the moment the first vote is cast. Changing "Deccan ₹3,80,000" after
 * thirty-four flats chose it silently rewrites what they agreed to, and a
 * recorded edit explains that afterwards rather than preventing it.
 */
export const optionsFrozen = (voteCount) => Number(voteCount) > 0;
