/**
 * Portal analytics — who is actually using this thing.
 *
 * WHY THIS EXISTS. The activity log answers "what happened to 4A on Tuesday".
 * It cannot answer "is anyone using the portal at all", and that is the
 * question that decides whether the next month is billed here or on WhatsApp.
 * 99 flats and a log 400 rows deep is not a dataset a person can read.
 *
 * Nothing here records anything new. Every number is counted from rows the
 * portal already writes — `activity`, `audit_log`, `error_log` — so switching
 * this screen on adds no tracking whatsoever. See docs/PRIVACY.md.
 *
 * Two deliberate constraints:
 *
 *   - Everything is bucketed in IST. Timestamps are stored in UTC, and the
 *     building's evening — 7pm to 10pm, when people actually open a bill —
 *     lands in the *previous* UTC day. Counting "today" in UTC would move
 *     five and a half hours of the day into yesterday, which is exactly the
 *     busiest part of it.
 *   - Every function here is pure. The grouping is done in SQL, where it is
 *     cheap; the shaping, gap-filling and labelling are done here, where they
 *     can be tested without a database.
 */

const IST_OFFSET_MS = 5.5 * 3600_000;

/** The IST calendar day a UTC timestamp falls in, as YYYY-MM-DD. */
export function istDay(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** The IST hour of day, 0–23. */
export function istHour(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return new Date(d.getTime() + IST_OFFSET_MS).getUTCHours();
}

/**
 * The last `days` IST days, oldest first, ending with today.
 *
 * A window is a list of days, not a start date, because the chart must show
 * the days with nothing on them. A quiet Sunday that silently vanishes from
 * the series turns a flat week into a rising line.
 */
export function dayRange(days, now = new Date().toISOString()) {
  const span = Math.max(1, Math.min(Number(days) || 1, 365));
  const end = new Date(new Date(now).getTime() + IST_OFFSET_MS);
  const out = [];
  for (let i = span - 1; i >= 0; i--) {
    out.push(new Date(end.getTime() - i * 86_400_000).toISOString().slice(0, 10));
  }
  return out;
}

/**
 * The UTC instant at which the window starts — midnight IST on its first day.
 *
 * This is what the SQL `WHERE at >= ?` uses, and it is 18:30 UTC on the day
 * before, which is the whole reason it is computed rather than eyeballed.
 */
export function windowStart(days, now = new Date().toISOString()) {
  const first = dayRange(days, now)[0];
  return new Date(Date.parse(`${first}T00:00:00.000Z`) - IST_OFFSET_MS).toISOString();
}

/** Index rows by their `day` column so a series can be filled from them. */
function byDay(rows) {
  const map = new Map();
  for (const r of rows ?? []) map.set(r.day, r);
  return map;
}

const n = (v) => Number(v ?? 0) || 0;

/**
 * One row per day in the window, whether or not anything happened on it.
 *
 * `people` is deliberately a per-day distinct count taken from SQL rather than
 * summed here: a resident who opens the portal on three days is three
 * day-actives and one person, and only the database can tell those apart.
 */
export function mergeDaily({ activity = [], logins = [], errors = [] }, range) {
  const a = byDay(activity);
  const l = byDay(logins);
  const e = byDay(errors);

  return range.map((day) => ({
    day,
    events: n(a.get(day)?.events),
    pageViews: n(a.get(day)?.pages),
    // Kept apart from page views so a day can be stacked into what people
    // looked at, what they did, and what broke. "Events went up" is not an
    // answer when the increase might be errors.
    actions: n(a.get(day)?.actions),
    people: n(a.get(day)?.people),
    logins: n(l.get(day)?.logins),
    loggedIn: n(l.get(day)?.people),
    errors: n(e.get(day)?.errors),
  }));
}

/** SQLite's %w: 0 is Sunday. Kept in that order because IST weeks start there. */
export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * The 7 × 24 grid, every cell present.
 *
 * The flat hour histogram cannot tell Sunday evening from Tuesday evening, and
 * those are different facts: one says when residents read their bill, the other
 * says when a deploy would interrupt the fewest of them.
 *
 * `peak` rides along because the caller needs it to shade the cells and
 * recomputing it from a nested array in the browser is a second place to get
 * the same maximum wrong.
 */
export function weekHeat(rows = []) {
  const map = new Map();
  for (const r of rows) map.set(`${Number(r.weekday)}:${Number(r.hour)}`, n(r.events));

  const grid = WEEKDAYS.map((label, weekday) => ({
    weekday, label,
    hours: Array.from({ length: 24 }, (_, hour) => ({
      hour, events: map.get(`${weekday}:${hour}`) ?? 0,
    })),
  }));

  const peak = Math.max(0, ...grid.flatMap((d) => d.hours.map((h) => h.events)));
  const busiest = grid
    .flatMap((d) => d.hours.map((h) => ({ ...h, weekday: d.weekday, label: d.label })))
    .reduce((best, cell) => (best == null || cell.events > best.events ? cell : best), null);

  return { grid, peak, busiest: busiest?.events ? busiest : null };
}

/**
 * The rollout curve: how many flats had EVER logged in, as of each day.
 *
 * Cumulative and monotonic by construction — it counts first logins, so it can
 * only rise. That is the point: daily actives bounce around and tell you
 * nothing about progress, while "61 of 99 flats have now used this at least
 * once" is the sentence the committee is waiting for.
 *
 * Days before the window are folded into the starting figure rather than
 * dropped, or a portal that was adopted last year would appear to start at zero
 * every time the window is shortened.
 */
export function adoptionCurve({ firstLogins = [], range = [], residents = 0 }) {
  const byDate = new Map();
  let before = 0;

  for (const row of firstLogins) {
    const day = istDay(row.at ?? row.first_at);
    if (!day) continue;
    if (day < range[0]) { before += 1; continue; }
    byDate.set(day, (byDate.get(day) ?? 0) + 1);
  }

  let running = before;
  const points = range.map((day) => {
    running += byDate.get(day) ?? 0;
    return { day, everLoggedIn: running, newThisDay: byDate.get(day) ?? 0 };
  });

  return {
    points,
    residents,
    startedAt: before,
    gained: running - before,
    // Ratio, not a percentage string: the page decides how to phrase it.
    share: residents ? running / residents : 0,
  };
}

/**
 * Per-key daily series, for the sparkline that belongs inside a table row.
 *
 * One query grouped by name and day becomes one small array per name here,
 * gap-filled against the same range as every other chart so two sparklines on
 * the page are always the same number of days wide.
 */
export function seriesByKey(rows = [], range = [], { key = 'name', value = 'count' } = {}) {
  const byName = new Map();
  for (const r of rows) {
    const name = String(r[key] ?? '');
    if (!byName.has(name)) byName.set(name, new Map());
    byName.get(name).set(r.day, n(r[value]));
  }

  const out = {};
  for (const [name, days] of byName) out[name] = range.map((d) => days.get(d) ?? 0);
  return out;
}

/**
 * The paying funnel: opened the bill → tapped Pay → sent a proof → approved.
 *
 * Counted in PEOPLE, not events, because one resident who taps Pay four times
 * is one resident who tried to pay. Each step is a distinct-owner count from
 * rows the portal already writes.
 *
 * THE HONEST CAVEAT, and it must stay visible on the page: this is not a
 * conversion rate. A resident who copies the UPI ID and pays from their own app
 * without uploading a screenshot has paid in full and still shows here as a
 * drop-off, and the treasurer reconciling a bank statement never appears at
 * all. Read it as "how far people get inside the portal", never as "how many
 * people paid" — the bills table is the only thing that knows that.
 */
export function funnelOf({ opened = 0, intents = 0, proofs = 0, approvals = 0 }) {
  const steps = [
    { key: 'opened', label: 'Opened their bill', people: n(opened) },
    { key: 'intent', label: 'Tapped Pay or copied the UPI ID', people: n(intents) },
    { key: 'proof', label: 'Sent a payment screenshot', people: n(proofs) },
    { key: 'approved', label: 'Screenshot approved', people: n(approvals) },
  ];

  const top = steps[0].people || 1;
  return steps.map((step, i) => ({
    ...step,
    share: step.people / top,
    // Drop from the step above, which is where a funnel is actually read.
    lostFromPrevious: i === 0 ? 0 : Math.max(0, steps[i - 1].people - step.people),
  }));
}

/**
 * User agent → a word a human can act on.
 *
 * Deliberately coarse. The useful question is "should I be testing this on a
 * phone" — which is answered by four buckets — and a browser-and-version
 * breakdown would be a fingerprint of an individual resident in a building
 * where most people own exactly one device.
 */
export function classifyDevice(ua) {
  const s = String(ua ?? '').toLowerCase();
  if (!s) return 'unknown';
  if (/ipad|tablet|playbook|silk/.test(s) || (/android/.test(s) && !/mobile/.test(s))) return 'tablet';
  if (/iphone|ipod|android|mobile|windows phone/.test(s)) return 'phone';
  if (/windows|macintosh|mac os x|linux|cros/.test(s)) return 'desktop';
  return 'unknown';
}

/** Collapse raw user-agent rows into device buckets, busiest first. */
export function deviceSplit(rows = []) {
  const buckets = new Map();
  for (const r of rows) {
    const key = classifyDevice(r.user_agent);
    const cur = buckets.get(key) ?? { device: key, events: 0, people: 0 };
    cur.events += n(r.events);
    // People cannot be summed across user-agent strings without double
    // counting one resident who has both a phone and a laptop. Overstating a
    // split is better than pretending the laptop visit never happened, and the
    // events column is the honest one — so this is labelled "visits" on screen.
    cur.people += n(r.people);
    buckets.set(key, cur);
  }
  return [...buckets.values()].sort((x, y) => y.events - x.events);
}

/**
 * Window totals, plus the comparison that makes them mean anything.
 *
 * A number with nothing beside it is a number nobody can act on. "412 page
 * views" is noise; "412, up from 96" is a rollout working.
 */
export function summarise(daily, previous = []) {
  const sum = (rows, key) => rows.reduce((t, r) => t + n(r[key]), 0);

  const busiest = daily.reduce(
    (best, r) => (best == null || r.events > best.events ? r : best), null);

  return {
    events: sum(daily, 'events'),
    pageViews: sum(daily, 'pageViews'),
    logins: sum(daily, 'logins'),
    errors: sum(daily, 'errors'),
    // Peak daily actives, not a sum: summing distinct-per-day counts the same
    // resident once per day they showed up, which is a bigger number than the
    // building has people in it.
    peakDailyPeople: daily.reduce((m, r) => Math.max(m, n(r.people)), 0),
    busiestDay: busiest && busiest.events ? busiest.day : null,
    previous: {
      events: sum(previous, 'events'),
      pageViews: sum(previous, 'pageViews'),
      logins: sum(previous, 'logins'),
      errors: sum(previous, 'errors'),
    },
  };
}

/**
 * Rollout reach — the number the committee actually asks for.
 *
 * "How many residents have ever logged in" is the adoption figure; the flats
 * that never have are the door-knocking list. Both are counted from login
 * audit rows, so an account created by the roster import but never used is
 * correctly counted as never used.
 */
export function reachOf({ owners = [], lastLogins = [], activeIds = [], now, dormantDays = 30 }) {
  const seen = new Map((lastLogins ?? []).map((r) => [Number(r.actor_id), r.at]));
  const active = new Set((activeIds ?? []).map(Number));
  const cutoff = new Date(new Date(now ?? Date.now()).getTime() - dormantDays * 86_400_000)
    .toISOString();

  const residents = owners.filter((o) => Number(o.active) === 1);
  const never = residents.filter((o) => !seen.has(Number(o.id)));
  const dormant = residents
    .filter((o) => seen.has(Number(o.id)) && seen.get(Number(o.id)) < cutoff)
    .map((o) => ({ flat: o.flat, name: o.name, lastAt: seen.get(Number(o.id)) }))
    .sort((a, b) => (a.lastAt < b.lastAt ? -1 : 1));

  return {
    residents: residents.length,
    everLoggedIn: residents.length - never.length,
    activeInWindow: residents.filter((o) => active.has(Number(o.id))).length,
    neverLoggedIn: never.map((o) => ({ flat: o.flat, name: o.name })),
    dormantDays,
    dormant: dormant.slice(0, 20),
    dormantCount: dormant.length,
  };
}

/** Trim a grouped top-N list to the shape the page renders. */
export function topList(rows = [], { key = 'name', count = 'count' } = {}) {
  return rows
    .filter((r) => r[key] != null)
    .map((r) => ({ ...r, [key]: String(r[key]), [count]: n(r[count]) }));
}
