import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { generateBills } from '../functions/lib/admin.js';
import {
  publishBills, drainAnnouncements, announcementCounts, announcementEmail,
  permanentFailure, pendingAnnouncementPeriods, unreachableFlats, DRAIN_SIZE, MAX_ATTEMPTS,
} from '../functions/lib/announce.js';
import { planReadingCorrection, priceCorrectionTotals } from '../functions/lib/corrections.js';
import { planRateChange } from '../functions/lib/admin.js';
import { BILL_FIELDS, MONEY_FIELDS, reasonRequired } from '../functions/lib/godedit.js';
import { checkBills } from '../functions/lib/diagnostics.js';
import { TABLES } from '../functions/lib/backup.js';

/**
 * The Billing tab: publishing, the announcement outbox, and the two ways a
 * published month can be corrected.
 *
 * No network and no D1. The outbox tests stub `fetch` rather than the mailer,
 * because the thing most likely to go wrong here is the NUMBER OF OUTBOUND
 * CALLS — a token refresh per send is what puts a month at ~178 subrequests
 * against a cap of 50 — and stubbing the mailer would hide exactly that.
 */

/* ── a building ──────────────────────────────────────────────────────────── */

const OPEN = {
  period: '2026-08', status: 'open', rate_per_kg: 78, conversion_factor: 2.6,
  due_date: '2026-09-10', late_fee: 50,
};

/**
 * Ninety flats over fifteen floors.
 *
 * FIFTEEN, not twelve. The building has floors above 12 — a fixture that stops
 * there is a stand-in that would let a floor-numbering bug through — and the
 * count matters more than it looks: these tests exist to catch what only breaks
 * at a building's worth of flats, so five would prove nothing about either the
 * subrequest cap or the drain.
 */
function building({ billed = 90, noEmail = 0, ownerless = 0 } = {}) {
  const flats = [];
  const people = [];
  let id = 1;
  outer: for (let floor = 1; floor <= 15; floor += 1) {
    for (const unit of ['A', 'B', 'C', 'D', 'E', 'F']) {
      if (flats.length >= billed) break outer;
      const flat = `${floor}${unit}`;
      flats.push({ flat, floor });
      // The last `ownerless` flats get nobody at all: billed, switched on, and
      // no one to send a bill to.
      if (flats.length > billed - ownerless) continue;
      people.push({
        id: id++, flat, name: `Resident ${flat}`, relationship: 'owner', active: 1,
        // The last `noEmail` flats that DO have somebody have no address.
        email: flats.length > billed - ownerless - noEmail ? null : `${flat.toLowerCase()}@example.test`,
      });
    }
  }
  return { flats, people };
}

/** Just enough D1 to run readingGrid, generateBills and the outbox. */
function fakeDb({ period = OPEN, flats = [], people = [], readings = [], bills = [],
                  announcements = [] } = {}) {
  const batches = [];
  const runs = [];
  let nextBillId = 1000;

  const route = (sql, args) => ({
    first: async () => first(sql, args),
    all: async () => all(sql, args),
    run: async () => { runs.push({ sql, args }); return { meta: {} }; },
    sql, args,
  });

  const first = async (sql, args) => {
    if (/FROM periods WHERE period/.test(sql)) {
      return args[0] === period?.period ? period : null;
    }
    if (/rate_per_kg FROM periods/.test(sql)) return null;   // no previous month
    if (/COUNT\(\*\) AS n FROM bills/.test(sql)) return { n: bills.length };
    return null;
  };

  const all = async (sql, args) => {
    if (/FROM flats f/.test(sql) && /f\.active = 1/.test(sql)) {
      const [cur, prv] = args;
      return { results: flats.map((f) => ({
        flat: f.flat, floor: f.floor,
        reading: readings.find((r) => r.flat === f.flat && r.period === cur)?.reading ?? null,
        read_on: null,
        previous: readings.find((r) => r.flat === f.flat && r.period === prv)?.reading ?? null,
        mc_old_final: null, mc_new_start: null, mc_changed_on: null, mc_note: null,
      })) };
    }
    if (/FROM flats f/.test(sql)) return { results: [] };
    if (/FROM owners/.test(sql)) return { results: people };
    if (/FROM bill_announcements a/.test(sql)) {
      // The drain's query: still to send, joined to its bill and its person.
      //
      // WHICH STATUSES IT PICKS UP IS READ OUT OF THE SQL, not restated here.
      // Restating it made this fake answer the question the code was supposed
      // to answer: with the WHERE clause reimplemented, a drain that selected
      // `sent` rows and mailed the building twice still passed every
      // idempotency test in this file. A fake that hard-codes the thing under
      // test is not a fake, it is the answer key.
      const [, , limit] = args;
      const wanted = [...sql.matchAll(/a\.status = '(\w+)'/g)].map((m) => m[1]);
      const capped = /a\.attempts < \?/.test(sql);
      const open = announcements
        .filter((a) => wanted.includes(a.status)
          && !(a.status === 'failed' && capped && a.attempts >= MAX_ATTEMPTS))
        .slice(0, limit);
      return { results: open.map((a) => {
        const bill = bills.find((b) => b.id === a.bill_id);
        const who = people.find((p) => p.id === bill.owner_id);
        return {
          bill_id: a.bill_id, attempts: a.attempts, flat: bill.flat, period: bill.period,
          total: bill.total, consumption: bill.consumption, rate_per_kg: bill.rate_per_kg,
          due_date: period.due_date, email: who?.email ?? null,
        };
      }) };
    }
    if (/status, COUNT\(\*\) AS n FROM bill_announcements/.test(sql)) {
      const byStatus = new Map();
      for (const a of announcements) byStatus.set(a.status, (byStatus.get(a.status) ?? 0) + 1);
      return { results: [...byStatus].map(([status, n]) => ({ status, n })) };
    }
    if (/SELECT period, COUNT\(\*\) AS n FROM bill_announcements/.test(sql)) {
      const open = announcements.filter((a) => a.status === 'queued'
        || (a.status === 'failed' && a.attempts < MAX_ATTEMPTS));
      return { results: open.length ? [{ period: open[0].period, n: open.length }] : [] };
    }
    if (/FROM bill_announcements a/.test(sql) || /a\.status = 'unreachable'/.test(sql)) {
      return { results: [] };
    }
    return { results: [] };
  };

  const DB = {
    prepare(sql) {
      return {
        bind: (...args) => route(sql, args),
        first: () => first(sql, []),
        all: () => all(sql, []),
        run: async () => { runs.push({ sql, args: [] }); return { meta: {} }; },
      };
    },
    async batch(statements) {
      batches.push(statements);
      // The announcement queue is INSERT…SELECT over the bills written earlier
      // in this same batch, so the fake has to honour the ordering the real
      // thing depends on: apply the inserts first, then the queue.
      for (const st of statements) {
        if (/INSERT INTO bills/.test(st.sql)) {
          const [flat, p, ownerId, , consumption, factor, rate, gas, total] = st.args;
          bills.push({ id: nextBillId++, flat, period: p, owner_id: ownerId,
                       consumption, conversion_factor: factor, rate_per_kg: rate,
                       gas_amount: gas, total, status: 'unpaid', manual_total: 0 });
        }
        if (/INSERT INTO bill_announcements/.test(st.sql)) {
          const [now, p] = st.args;
          // Whether an address-less resident is queued or marked unreachable is
          // read out of the statement, for the same reason the drain's WHERE
          // clause is: deciding it here would make this fake the thing under
          // test. Dropping the CASE and queueing everybody used to pass.
          const marksUnreachable = /'unreachable'/.test(st.sql) && /o\.email IS NULL/.test(st.sql);
          for (const b of bills.filter((x) => x.period === p)) {
            if (announcements.some((a) => a.bill_id === b.id)) continue;   // ON CONFLICT DO NOTHING
            const who = people.find((x) => x.id === b.owner_id);
            announcements.push({
              bill_id: b.id, period: p, attempts: 0, queued_at: now,
              status: (who?.email || !marksUnreachable) ? 'queued' : 'unreachable',
            });
          }
        }
      }
    },
  };

  // Every write the drain makes goes through .run(); reflect it so the next
  // call sees what the last one did, which is the whole idempotency claim.
  const origPrepare = DB.prepare.bind(DB);
  DB.prepare = (sql) => {
    const stmt = origPrepare(sql);
    const bind = stmt.bind;
    stmt.bind = (...args) => {
      const bound = bind(...args);
      const run = bound.run;
      bound.run = async () => {
        if (/UPDATE bill_announcements/.test(sql)) {
          const [status, attempts, lastError, , sentAt, billId] = args;
          const row = announcements.find((a) => a.bill_id === billId);
          if (row) {
            row.status = status;
            row.attempts = attempts;
            row.last_error = lastError;
            if (status === 'sent') row.sent_at = sentAt;
          }
        }
        return run();
      };
      return bound;
    };
    return stmt;
  };

  return {
    DB, batches, runs, bills, announcements,
    env: { DB,
      GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'secret',
      GOOGLE_REFRESH_TOKEN: 'refresh', MAIL_FROM: 'rwa@example.test' },
  };
}

/** Every flat read, every reading valid. */
const readingsFor = (flats, period, prev) => [
  ...flats.map((f) => ({ flat: f.flat, period: prev, reading: 100 })),
  ...flats.map((f) => ({ flat: f.flat, period, reading: 105 })),
];

/* ── the network, counted ────────────────────────────────────────────────── */

let calls;

beforeEach(() => {
  calls = { token: 0, send: 0, sendStatus: 200 };
  vi.stubGlobal('fetch', async (url) => {
    if (String(url).includes('oauth2.googleapis.com')) {
      calls.token += 1;
      return { ok: true, json: async () => ({ access_token: 'tok' }) };
    }
    if (String(url).includes('gmail.googleapis.com')) {
      calls.send += 1;
      return { ok: calls.sendStatus === 200, status: calls.sendStatus };
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
});

afterEach(() => vi.unstubAllGlobals());

/* ── publishing ──────────────────────────────────────────────────────────── */

describe('publishing a month', () => {
  it('queues exactly one announcement per bill, in the same batch as the bills', async () => {
    // A month generated but not queued would look published on every screen
    // and tell nobody, and nothing downstream would ever notice.
    const { flats, people } = building();
    const db = fakeDb({ flats, people, readings: readingsFor(flats, '2026-08', '2026-07') });

    const result = await publishBills(db.env, '2026-08', 1);

    expect(result.generated).toBe(90);
    expect(db.announcements).toHaveLength(90);
    expect(new Set(db.announcements.map((a) => a.bill_id)).size).toBe(90);
    // One batch, not two. Two would mean a window where the bills exist and
    // the queue does not.
    expect(db.batches).toHaveLength(1);
  });

  it('queues a resident with no email as unreachable, never as queued', async () => {
    // They are the WhatsApp list. A drain must never spend a subrequest
    // discovering an address that was never there.
    const { flats, people } = building({ noEmail: 5 });
    const db = fakeDb({ flats, people, readings: readingsFor(flats, '2026-08', '2026-07') });

    await publishBills(db.env, '2026-08', 1);

    const counts = await announcementCounts(db.env, '2026-08');
    expect(counts.unreachable).toBe(5);
    expect(counts.queued).toBe(85);
    // `unreachable` is not outstanding work — it is as finished as the drain
    // can make it, and counting it as remaining would leave the progress bar
    // permanently short of the end.
    expect(counts.remaining).toBe(85);
  });

  it('refuses a flat with nobody to bill, and names it', async () => {
    // Production has five of these today: 8B, 9E, 11D, 14A, 16D. One of them
    // blocks the month for the whole building, which is why the publish step
    // has to surface it as its own blocker rather than as a missing reading.
    const { flats, people } = building({ ownerless: 5 });
    const db = fakeDb({ flats, people, readings: readingsFor(flats, '2026-08', '2026-07') });

    await expect(publishBills(db.env, '2026-08', 1)).rejects.toMatchObject({
      code: 'DDP-BILL-015',
    });
    // Nothing queued, because nothing was generated.
    expect(db.announcements).toHaveLength(0);
  });

  it('refuses a locked month', async () => {
    const { flats, people } = building({ billed: 6 });
    const db = fakeDb({
      period: { ...OPEN, status: 'locked' }, flats, people,
      readings: readingsFor(flats, '2026-08', '2026-07'),
    });
    await expect(publishBills(db.env, '2026-08', 1)).rejects.toMatchObject({
      code: 'DDP-BILL-007',
    });
  });

  it('refuses a partial month — a missing flat means somebody never gets billed', async () => {
    const { flats, people } = building({ billed: 6 });
    const short = readingsFor(flats, '2026-08', '2026-07')
      .filter((r) => !(r.flat === '1C' && r.period === '2026-08'));
    const db = fakeDb({ flats, people, readings: short });

    await expect(publishBills(db.env, '2026-08', 1)).rejects.toMatchObject({
      code: 'DDP-BILL-001',
    });
    expect(db.announcements).toHaveLength(0);
  });

  it('keeps every refusal generateBills already had', async () => {
    // publishBills is generation plus an outbox, not a way round generation.
    const { flats, people } = building({ billed: 6 });
    const db = fakeDb({
      period: { ...OPEN, rate_per_kg: null }, flats, people,
      readings: readingsFor(flats, '2026-08', '2026-07'),
    });
    await expect(publishBills(db.env, '2026-08', 1)).rejects.toMatchObject({
      code: 'DDP-BILL-005',
    });
  });

  it('leaves generateBills usable on its own, without an outbox', async () => {
    const { flats, people } = building({ billed: 6 });
    const db = fakeDb({ flats, people, readings: readingsFor(flats, '2026-08', '2026-07') });
    const result = await generateBills(db.env, '2026-08', 1);
    expect(result.generated).toBe(6);
    expect(db.announcements).toHaveLength(0);
  });
});

/* ── the outbox ──────────────────────────────────────────────────────────── */

describe('draining the announcements', () => {
  /** A published building, ready to be told about. */
  async function published(opts = {}) {
    const { flats, people } = building(opts);
    const db = fakeDb({ flats, people, readings: readingsFor(flats, '2026-08', '2026-07') });
    await publishBills(db.env, '2026-08', 1);
    calls.token = 0;
    calls.send = 0;
    return db;
  }

  it('refreshes the token ONCE per drain, not once per send', async () => {
    // THE NUMBER THIS WHOLE MODULE EXISTS FOR. sendEmail refreshes on every
    // call and nothing caches it, so a month is ~178 outbound fetches against
    // a 50-subrequest cap. Twenty sends plus one refresh is 21.
    const db = await published();

    const res = await drainAnnouncements(db.env, '2026-08');

    expect(res.sent).toBe(DRAIN_SIZE);
    expect(calls.send).toBe(DRAIN_SIZE);
    expect(calls.token).toBe(1);
    // The assertion that matters, stated as the cap rather than as a count.
    expect(calls.send + calls.token).toBeLessThan(50);
  });

  it('sends a whole building of 90 across successive drains, and stops', async () => {
    // Tested at 90, not at 5. This fails only at scale — twenty flats locally
    // would never show it.
    const db = await published();

    let sent = 0;
    let rounds = 0;
    let res;
    do {
      res = await drainAnnouncements(db.env, '2026-08');
      sent += res.sent;
      rounds += 1;
    } while (res.remaining && rounds < 20);

    expect(sent).toBe(90);
    expect(res.remaining).toBe(0);
    expect(rounds).toBe(Math.ceil(90 / DRAIN_SIZE));
    // One refresh per drain, still — not one per message, and not one per flat.
    expect(calls.token).toBe(rounds);
    expect(calls.send).toBe(90);
  });

  it('is idempotent: a second drain over a finished month sends nothing', async () => {
    // The failure that matters, because the second email arrives at a
    // neighbour rather than in a log file.
    const db = await published({ billed: 10 });
    await drainAnnouncements(db.env, '2026-08');
    const before = calls.send;

    const again = await drainAnnouncements(db.env, '2026-08');

    expect(again.sent).toBe(0);
    expect(calls.send).toBe(before);
    expect(db.announcements.every((a) => a.status === 'sent')).toBe(true);
  });

  it('resumes a partial drain without re-sending what already went', async () => {
    const db = await published({ billed: 30 });
    const one = await drainAnnouncements(db.env, '2026-08');
    expect(one.sent).toBe(20);
    expect(one.remaining).toBe(10);

    const two = await drainAnnouncements(db.env, '2026-08');

    expect(two.sent).toBe(10);
    expect(calls.send).toBe(30);          // thirty flats, thirty messages
    expect(two.remaining).toBe(0);
  });

  it('never attempts a resident with no email', async () => {
    const db = await published({ billed: 10, noEmail: 4 });

    const res = await drainAnnouncements(db.env, '2026-08');

    expect(res.sent).toBe(6);
    expect(calls.send).toBe(6);           // not 10
    expect(db.announcements.filter((a) => a.status === 'unreachable')).toHaveLength(4);
  });

  it('does not retry a 4xx — the same message will be refused forever', async () => {
    // The reminder path learned this on 2026-08-14: a locked month retried
    // every two seconds and pushed 56 Telegram alerts in a minute.
    const db = await published({ billed: 3 });
    calls.sendStatus = 400;

    const res = await drainAnnouncements(db.env, '2026-08');
    expect(res.failed).toBe(3);
    expect(db.announcements.every((a) => a.attempts === MAX_ATTEMPTS)).toBe(true);

    // Parked at the ceiling, so the nightly sweep does not pick them up again.
    const after = await drainAnnouncements(db.env, '2026-08');
    expect(after.sent).toBe(0);
    expect(calls.send).toBe(3);
  });

  it('does retry a 5xx, up to three attempts', async () => {
    const db = await published({ billed: 2 });
    calls.sendStatus = 503;

    await drainAnnouncements(db.env, '2026-08');
    expect(db.announcements.every((a) => a.attempts === 1)).toBe(true);

    await drainAnnouncements(db.env, '2026-08');
    await drainAnnouncements(db.env, '2026-08');
    expect(db.announcements.every((a) => a.attempts === MAX_ATTEMPTS)).toBe(true);

    // And then left for a human rather than tried forever.
    const done = await drainAnnouncements(db.env, '2026-08');
    expect(done.sent + done.failed).toBe(0);
  });

  it('recovers a month that was failing once Gmail comes back', async () => {
    const db = await published({ billed: 4 });
    calls.sendStatus = 503;
    await drainAnnouncements(db.env, '2026-08');
    calls.sendStatus = 200;

    const res = await drainAnnouncements(db.env, '2026-08');

    expect(res.sent).toBe(4);
    expect(res.remaining).toBe(0);
  });

  it('publishes fine with email unconfigured, and says so', async () => {
    // Gmail is still unconfigured in production (W1). Publishing must succeed
    // with zero emails sent — the WhatsApp list is the fallback, and every
    // resident has a mobile.
    const db = await published({ billed: 4 });
    const env = { DB: db.DB };            // no GOOGLE_* credentials at all

    const res = await drainAnnouncements(env, '2026-08');

    expect(res.reason).toBe('not-configured');
    expect(res.sent).toBe(0);
    expect(calls.send).toBe(0);
    // Nothing is marked failed: the rows wait for the day the credentials land.
    expect(db.announcements.every((a) => a.status === 'queued')).toBe(true);
  });

  it('offers the cron only the months with something still to send', async () => {
    const db = await published({ billed: 4 });
    expect(await pendingAnnouncementPeriods(db.env)).toEqual(['2026-08']);

    let res;
    do { res = await drainAnnouncements(db.env, '2026-08'); } while (res.remaining);

    expect(await pendingAnnouncementPeriods(db.env)).toEqual([]);
  });
});

describe('which failures are worth trying again', () => {
  it('treats a 4xx as permanent', () => {
    for (const status of [400, 401, 403, 404, 422]) {
      expect(permanentFailure(`gmail-${status}`), String(status)).toBe(true);
    }
  });

  it('excepts a timeout and a rate limit — both are "later", not "never"', () => {
    expect(permanentFailure('gmail-408')).toBe(false);
    expect(permanentFailure('gmail-429')).toBe(false);
  });

  it('treats a 5xx and anything unrecognised as worth retrying', () => {
    expect(permanentFailure('gmail-500')).toBe(false);
    expect(permanentFailure('gmail-503')).toBe(false);
    expect(permanentFailure('threw')).toBe(false);
    expect(permanentFailure(null)).toBe(false);
  });
});

describe('the announcement email', () => {
  const mail = () => announcementEmail({
    flat: '4A', period: '2026-08', total: 1261, dueDate: '2026-09-10',
    consumption: 16.17, ratePerKg: 78, origin: 'https://staging.example.test',
  });

  it('carries both bodies, so a client that will not render HTML still shows one', () => {
    const m = mail();
    expect(m.text).toBeTruthy();
    expect(m.html).toBeTruthy();
  });

  it('names the flat, the amount and the due date in both', () => {
    const m = mail();
    for (const body of [m.text, m.html]) {
      expect(body).toContain('4A');
      expect(body).toContain('1261');
      expect(body).toContain('10 September');
    }
  });

  it('carries no payment link — an unsolicited request for money is a fraud shape', () => {
    const m = mail();
    expect(m.text).not.toContain('upi://');
    expect(m.html).not.toContain('upi://');
  });

  it('links to the request\'s own origin, so a staging drain links to staging', () => {
    expect(mail().html).toContain('https://staging.example.test/dashboard');
  });

  it('signs off once, in the template’s spelling of the name', () => {
    // The email used to pass a `footer:` of its own carrying a second,
    // differently spelled name, which renderEmail printed directly above the
    // ASSOCIATION constant — so both bodies signed off twice and disagreed
    // with themselves about whether the association is a Welfare one.
    const m = mail();
    for (const body of [m.text, m.html]) {
      expect(body.match(/Association/g)).toHaveLength(1);
      expect(body).toContain("DD Diamond Park Residents' Welfare Association");
    }
  });

  it('falls back to the portal when there is no request — the 3am sweep', () => {
    const m = announcementEmail({
      flat: '4A', period: '2026-08', total: 1261, dueDate: '2026-09-10',
      consumption: 16.17, ratePerKg: 78,
    });
    expect(m.html).toContain('https://diamondpark.pages.dev/dashboard');
  });
});

/* ── corrections ─────────────────────────────────────────────────────────── */

describe('correcting a reading', () => {
  const bill = {
    flat: '4A', total: 1261, gas_amount: 1261.26, other_charges: 0,
    additional_charges: 0, late_fee: 0,
  };

  it('produces the total the corrected reading implies', () => {
    const plan = planReadingCorrection({
      bill, previous: 100, reading: 110, ratePerKg: 78, conversionFactor: 2.6,
    });
    // 10 units × 2.6 = 26 kg × ₹78 = ₹2028, rounded up to a whole rupee.
    expect(plan.consumption).toBe(26);
    expect(plan.total).toBe(2028);
    expect(plan.difference).toBe(767);
  });

  it('refuses a meter that runs backwards', () => {
    expect(() => planReadingCorrection({
      bill, previous: 100, reading: 95, ratePerKg: 78, conversionFactor: 2.6,
    })).toThrow(/DDP-BILL-002/);
  });

  it('keeps a late fee already charged', () => {
    // A meter misread in August does not undo a fee earned in September by not
    // paying. Dropping it would be an adjustment nobody asked for.
    const plan = planReadingCorrection({
      bill: { ...bill, late_fee: 50 }, previous: 100, reading: 110,
      ratePerKg: 78, conversionFactor: 2.6,
    });
    expect(plan.total).toBe(2078);
  });

  it('stores the gas that MOVED across a meter swap, not the raw difference', () => {
    // Subtracting the readings would store a negative delta beside a positive
    // consumption — a bill contradicting itself, which is the DDP-BILL-003
    // condition arrived at by our own hand.
    const plan = planReadingCorrection({
      bill, previous: 100, reading: 5, ratePerKg: 78, conversionFactor: 2.6,
      meterChange: { old_final: 108, new_start: 0 },
    });
    expect(plan.delta).toBe(13);          // (108 - 100) + (5 - 0)
    expect(plan.consumption).toBeGreaterThan(0);
  });
});

describe('correcting the month\'s price of gas', () => {
  const bills = [
    { id: 1, flat: '4A', consumption: 10, gas_amount: 780, total: 780, status: 'unpaid',
      other_charges: 0, additional_charges: 0, late_fee: 0, manual_total: 0 },
    { id: 2, flat: '4B', consumption: 20, gas_amount: 1560, total: 1560, status: 'paid',
      other_charges: 0, additional_charges: 0, late_fee: 0, manual_total: 0 },
    { id: 3, flat: '4C', consumption: 30, gas_amount: 2340, total: 2340, status: 'unpaid',
      other_charges: 0, additional_charges: 0, late_fee: 0, manual_total: 1 },
  ];

  it('recalculates every bill in the month, and totals both sides', () => {
    const plan = planRateChange(bills, { ratePerKg: 80 });
    const totals = priceCorrectionTotals(plan, bills);

    expect(totals.billsAffected).toBe(2);
    expect(totals.totalBefore).toBe(780 + 1560 + 2340);
    // 4A and 4B move to the new price; 4C carries a typed amount and is left.
    expect(totals.totalAfter).toBe(800 + 1600 + 2340);
  });

  it('names the paid bills that go back to unpaid when the price rises', () => {
    // The uncomfortable part, stated before it happens rather than discovered.
    const plan = planRateChange(bills, { ratePerKg: 80 });
    expect(plan.totals.owesAgainCount).toBe(1);
    expect(plan.changes.find((c) => c.flat === '4B').owesAgain).toBe(true);
  });

  it('leaves an already-paid bill that got cheaper marked paid, in credit', () => {
    const plan = planRateChange(bills, { ratePerKg: 70 });
    expect(plan.totals.owesAgainCount).toBe(0);
    expect(plan.totals.inCreditCount).toBe(1);
  });

  it('skips a bill carrying a typed amount, and says how many', () => {
    const plan = planRateChange(bills, { ratePerKg: 80 });
    expect(plan.totals.skipped).toBe(1);
    expect(plan.skipped[0].flat).toBe('4C');
  });
});

/* ── the amount is never editable ────────────────────────────────────────── */

describe('a bill\'s amount', () => {
  it('is not a field editBill accepts', () => {
    // Decided 2026-08-20: visible, never editable, for everyone including the
    // superadmin. The two things that can be wrong with a bill are the reading
    // and the price of gas, and both are corrected as themselves.
    expect(BILL_FIELDS).not.toContain('total');
    expect(BILL_FIELDS).toContain('gas_amount');
    expect(BILL_FIELDS).toContain('status');
  });

  it('still requires a reason on the record, for the rows already written that way', () => {
    // The route is closed; the history is not rewritten. A reason was required
    // for those edits and that stays true of the record.
    expect(MONEY_FIELDS).toContain('total');
    expect(reasonRequired('total')).toBe(true);
  });

  it('is counted by the doctor so the number can go to zero', () => {
    const findings = checkBills([
      { flat: '4A', period: '2026-07', total: 200, gas_amount: 329, other_charges: 0,
        additional_charges: 0, late_fee: 0, manual_total: 1, adjust_reason: 'AGM' },
    ]);
    const override = findings.find((f) => f.id === 'BILL-OVERRIDE');
    expect(override.count).toBe(1);
    // Info, not a failure: these are real bills, and nothing can add to them.
    expect(override.severity).toBe('info');
  });

  it('reports nothing once no bill carries one', () => {
    const clean = [{ flat: '4A', period: '2026-07', total: 329, gas_amount: 329,
                     other_charges: 0, additional_charges: 0, late_fee: 0, manual_total: 0 }];
    expect(checkBills(clean).find((f) => f.id === 'BILL-OVERRIDE')).toBeUndefined();
  });
});

/* ── counts come from billable flats ─────────────────────────────────────── */

describe('what the counts are counted over', () => {
  it('bills, and tells, only the flats that have somebody', async () => {
    // The Flats tile read 88 while Gas and Total summed all 89, because the
    // totals ran over every flat rather than the billable ones — the same
    // off-by-one-set as the publish button counting from the whole building.
    const { flats, people } = building({ billed: 10 });
    // One flat switched on with nobody on it, and no reading for it either —
    // which is the ordinary way this arises: no owner, no meter walk.
    const readings = readingsFor(flats.slice(0, 9), '2026-08', '2026-07');
    const db = fakeDb({ flats: flats.slice(0, 9), people, readings });

    const result = await publishBills(db.env, '2026-08', 1);

    expect(result.generated).toBe(9);
    expect(db.announcements).toHaveLength(9);
    const counts = await announcementCounts(db.env, '2026-08');
    expect(counts.total).toBe(9);
  });

  it('has no unreachable list before a month is published', async () => {
    const { flats, people } = building({ billed: 4 });
    const db = fakeDb({ flats, people });
    // Before publishing there is no bill to tell anyone about, and a message
    // quoting a figure that could still change is worse than no message.
    expect(await unreachableFlats(db.env, '2026-08')).toEqual([]);
  });
});

/* ── the outbox survives a restore ───────────────────────────────────────── */

describe('backing the outbox up', () => {
  it('is in the bundle, after the bills it points at', () => {
    // A restore that brought back the bills without it would find the rows
    // missing, queue them afresh and mail the whole building a second time
    // about a month they were told about weeks ago.
    expect(TABLES).toContain('bill_announcements');
    expect(TABLES.indexOf('bill_announcements')).toBeGreaterThan(TABLES.indexOf('bills'));
  });
});
