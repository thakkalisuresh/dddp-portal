/**
 * Admin billing: the reading grid, and generation.
 *
 * Remember the labelling (plan §3a): the treasurer walks the building in JULY
 * and enters JUNE's readings. Everything here is keyed by the usage month.
 */

import {
  computeBill, computeConsumption, previewGeneration,
  assertRateSetForPeriod, rateSanity, DEFAULT_CONVERSION,
} from './billing.js';
import { fail } from './errors.js';

/** '2026-06' -> '2026-07' */
export function nextPeriod(period) {
  const [y, m] = period.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}

/** '2026-06' -> '2026-05' */
export function previousPeriod(period) {
  const [y, m] = period.split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

/** The month the meter is read in — one after the usage month it closes. */
export function readMonthFor(period) {
  return nextPeriod(period);
}

/**
 * Every active flat, with last month's reading and this month's if entered.
 * Flats without a reading are still returned — a missing flat must be visible,
 * because a partial month silently never bills someone.
 */
export async function readingGrid(env, period) {
  const prev = previousPeriod(period);

  const [periodRow, rows] = await Promise.all([
    env.DB.prepare('SELECT * FROM periods WHERE period = ?').bind(period).first(),
    env.DB.prepare(
      `SELECT f.flat, f.floor,
              cur.reading  AS reading,
              cur.read_on  AS read_on,
              prv.reading  AS previous
         FROM flats f
         LEFT JOIN readings cur ON cur.flat = f.flat AND cur.period = ?
         LEFT JOIN readings prv ON prv.flat = f.flat AND prv.period = ?
        WHERE f.active = 1
        ORDER BY f.floor, f.flat`
    ).bind(period, prev).all(),
  ]);

  const factor = periodRow?.conversion_factor ?? DEFAULT_CONVERSION;

  const flats = (rows.results ?? []).map((r) => {
    let consumption = null;
    let problem = null;
    if (r.reading != null && r.previous != null) {
      try {
        consumption = computeConsumption(r.reading, r.previous, factor);
      } catch (err) {
        problem = err.code === 'DDP-BILL-002' ? 'below-previous' : 'invalid';
      }
    } else if (r.reading != null && r.previous == null) {
      problem = 'no-previous';
    }
    return { ...r, consumption, problem };
  });

  return {
    period,
    readMonth: readMonthFor(period),
    rate: periodRow?.rate_per_kg ?? null,
    rateInherited: false,
    conversionFactor: factor,
    dueDate: periodRow?.due_date ?? null,
    lateFee: periodRow?.late_fee ?? 0,
    status: periodRow?.status ?? null,
    entered: flats.filter((f) => f.reading != null).length,
    total: flats.length,
    flats,
  };
}

/** Flag an implausible jump. Warns; never blocks. */
export const JUMP_MULTIPLE = 3;

export function jumpWarning(consumption, history) {
  const past = history.filter((n) => Number.isFinite(n) && n > 0);
  if (past.length < 2 || !Number.isFinite(consumption)) return null;
  const avg = past.reduce((a, b) => a + b, 0) / past.length;
  if (avg <= 0) return null;
  if (consumption > avg * JUMP_MULTIPLE) {
    return { level: 'warn', average: Math.round(avg * 100) / 100, multiple: +(consumption / avg).toFixed(1) };
  }
  return null;
}

/**
 * Generation. Refuses on a locked period, an inherited or absent rate, any
 * blocked row, or a partial month — a missing flat means someone silently
 * never gets billed, which is worse than a loud failure.
 *
 * Writes as one D1 batch so a half-generated month cannot exist.
 */
export async function generateBills(env, period, actorId) {
  const periodRow = await env.DB.prepare('SELECT * FROM periods WHERE period = ?').bind(period).first();
  if (!periodRow) fail('DDP-BILL-005', { period });
  if (periodRow.status === 'locked') fail('DDP-BILL-007', { period });
  assertRateSetForPeriod(periodRow);

  const existing = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM bills WHERE period = ?'
  ).bind(period).first();
  if ((existing?.n ?? 0) > 0) fail('DDP-BILL-006', { period, existing: existing.n });

  const grid = await readingGrid(env, period);
  const rows = grid.flats
    .filter((f) => f.reading != null && f.previous != null)
    .map((f) => ({ flat: f.flat, reading: f.reading, previous: f.previous }));

  const preview = previewGeneration({
    rows,
    ratePerKg: periodRow.rate_per_kg,
    conversionFactor: periodRow.conversion_factor,
    previousRate: (await env.DB.prepare('SELECT rate_per_kg FROM periods WHERE period = ?')
      .bind(previousPeriod(period)).first())?.rate_per_kg ?? null,
    expectedFlats: grid.total,
  });

  if (!preview.canGenerate) {
    fail('DDP-BILL-001', {
      period, blocked: preview.blocked, missing: preview.missing, rate: preview.rateSanity,
    });
  }

  const now = new Date().toISOString();
  const statements = rows.map((r) => {
    const consumption = computeConsumption(r.reading, r.previous, periodRow.conversion_factor);
    const { gasAmount, total } = computeBill({
      consumption, ratePerKg: periodRow.rate_per_kg,
    });
    const delta = Math.round((r.reading - r.previous) * 1000) / 1000;
    return env.DB.prepare(
      `INSERT INTO bills (flat, period, meter_delta, consumption, conversion_factor,
                          rate_per_kg, gas_amount, total, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'unpaid', ?)`
    ).bind(r.flat, period, delta, consumption, periodRow.conversion_factor,
           periodRow.rate_per_kg, gasAmount, total, now);
  });

  statements.push(
    env.DB.prepare("UPDATE periods SET status = 'locked' WHERE period = ?").bind(period)
  );

  await env.DB.batch(statements);

  return { period, generated: rows.length, totalAmount: preview.totalAmount, totalKg: preview.totalKg };
}

/**
 * Open a period. The rate is required here and never copied from last month
 * — see DDP-BILL-010; an inherited rate is the quietest catastrophe available.
 */
export async function openPeriod(env, { period, ratePerKg, dueDate, lateFee = 0,
                                        conversionFactor = DEFAULT_CONVERSION }) {
  const prev = await env.DB.prepare('SELECT rate_per_kg FROM periods WHERE period = ?')
    .bind(previousPeriod(period)).first();
  const sanity = rateSanity(ratePerKg, prev?.rate_per_kg ?? null);
  if (!sanity.ok) fail('DDP-BILL-005', { ratePerKg });

  await env.DB.prepare(
    `INSERT INTO periods (period, rate_per_kg, conversion_factor, due_date, late_fee,
                          late_fee_after, status, created_at)
     VALUES (?, ?, ?, ?, ?, 0, 'open', ?)`
  ).bind(period, ratePerKg, conversionFactor, dueDate, lateFee, new Date().toISOString()).run();

  return { period, ratePerKg, sanity };
}

/** Draft saves from the grid or a bulk import. Never generates. */
export async function saveReadings(env, period, entries, actorId) {
  const periodRow = await env.DB.prepare('SELECT status FROM periods WHERE period = ?')
    .bind(period).first();
  if (!periodRow) fail('DDP-BILL-005', { period });
  if (periodRow.status === 'locked') fail('DDP-BILL-007', { period });

  const now = new Date().toISOString();
  const readOn = `${readMonthFor(period)}-02`;
  const valid = entries.filter((e) => e.flat && Number.isFinite(Number(e.reading)));

  if (!valid.length) return { saved: 0, skipped: entries.length };

  await env.DB.batch(valid.map((e) =>
    env.DB.prepare(
      `INSERT INTO readings (flat, period, reading, read_on, entered_by, entered_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (flat, period) DO UPDATE SET
         reading = excluded.reading, entered_by = excluded.entered_by, entered_at = excluded.entered_at`
    ).bind(e.flat, period, Number(e.reading), readOn, actorId, now)
  ));

  return { saved: valid.length, skipped: entries.length - valid.length };
}

/**
 * Parse pasted or uploaded readings. Returns a DRAFT — never writes.
 * Unrecognised flats surface as errors rather than being silently dropped.
 */
export function parseReadings(text, knownFlats) {
  const known = new Map(knownFlats.map((f) => [normaliseFlat(f), f]));
  const rows = [];
  const errors = [];
  const seen = new Set();

  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split(/[\t,;]+|\s+/).filter(Boolean);
    if (parts.length < 2) { errors.push({ line, reason: 'malformed' }); continue; }

    // Take the LAST purely-numeric token as the reading, not simply the last
    // token: "4A  5.817 m3" ends in a unit, and stripping non-digits from that
    // would turn "m3" into 3. Everything before it is the flat, so "4 A" and
    // "4-A" survive too.
    let idx = -1;
    for (let i = parts.length - 1; i >= 1; i--) {
      if (/^\d+(\.\d+)?$/.test(parts[i])) { idx = i; break; }
    }
    if (idx < 1) { errors.push({ line, flat: parts[0], reason: 'not-a-number' }); continue; }

    const reading = Number(parts[idx]);
    const label = parts.slice(0, idx).join(' ');
    const key = normaliseFlat(label);

    if (!known.has(key)) { errors.push({ line, flat: label, reason: 'unknown-flat' }); continue; }
    if (seen.has(key)) { errors.push({ line, flat: label, reason: 'duplicate' }); continue; }

    seen.add(key);
    rows.push({ flat: known.get(key), reading });
  }

  return { rows, errors };
}

export function normaliseFlat(value) {
  return String(value).toUpperCase().replace(/[^A-Z0-9]/g, '');
}
