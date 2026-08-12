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

  const [periodRow, rows, excludedRows] = await Promise.all([
    env.DB.prepare('SELECT * FROM periods WHERE period = ?').bind(period).first(),
    env.DB.prepare(
      `SELECT f.flat, f.floor,
              cur.reading  AS reading,
              cur.read_on  AS read_on,
              prv.reading  AS previous,
              o.name       AS resident
         FROM flats f
         LEFT JOIN readings cur ON cur.flat = f.flat AND cur.period = ?
         LEFT JOIN readings prv ON prv.flat = f.flat AND prv.period = ?
         LEFT JOIN owners  o   ON o.flat = f.flat AND o.active = 1
        WHERE f.active = 1
        GROUP BY f.flat
        ORDER BY f.floor, f.flat`
    ).bind(period, prev).all(),
    // Excluded flats come back too, or they become invisible: the grid filters
    // them out, so without this list there is no screen anywhere that admits
    // they exist, and no way to put one back.
    env.DB.prepare(
      `SELECT f.flat, f.floor, o.name AS resident
         FROM flats f
         LEFT JOIN owners o ON o.flat = f.flat AND o.active = 1
        WHERE f.active = 0
        GROUP BY f.flat
        ORDER BY f.floor, f.flat`
    ).all(),
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
    // `total` is what generation compares against (expectedFlats), so excluding
    // a flat lowers the bar as well as hiding the row. That is the whole point:
    // "every flat or nothing" becomes "every flat still being billed, or
    // nothing", and a month with unsold flats in it can close.
    total: flats.length,
    flats,
    excluded: excludedRows.results ?? [],
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

/**
 * What changing a month's rate would do to the bills already in it.
 *
 * Pure, so the consequence can be shown before it happens and asserted in a
 * test. `bills.rate_per_kg` is a snapshot rather than a join — a bill keeps the
 * rate it was generated with — so nothing recalculates by itself. This is the
 * deliberate act that rewrites them.
 *
 * The uncomfortable part is stated plainly rather than hidden: a resident who
 * already paid, against a bill that just got dearer, now owes the difference.
 * That is the caveat the screen shows before anything is written.
 */
export function planRateChange(bills, { ratePerKg, conversionFactor = DEFAULT_CONVERSION }) {
  if (!Number.isFinite(ratePerKg) || ratePerKg <= 0) fail('DDP-BILL-005', { ratePerKg });

  const changes = [];
  const skipped = [];

  for (const bill of bills) {
    // A manual total was somebody's considered decision, usually a goodwill
    // figure with a written reason attached. Recomputing would discard it
    // silently, so it is listed instead of overwritten.
    if (bill.manual_total) {
      skipped.push({ flat: bill.flat, billId: bill.id, total: bill.total, why: 'manually adjusted' });
      continue;
    }

    const consumption = bill.consumption;
    const { gasAmount, total } = computeBill({
      consumption,
      ratePerKg,
      otherCharges: bill.other_charges ?? 0,
      additionalCharges: bill.additional_charges ?? 0,
      lateFee: bill.late_fee ?? 0,
    });
    if (total === bill.total && gasAmount === bill.gas_amount) continue;

    const settled = bill.status === 'paid' || bill.status === 'waived';
    changes.push({
      billId: bill.id, flat: bill.flat, status: bill.status,
      was: bill.total, now: total, gasAmount,
      difference: Math.round((total - bill.total) * 100) / 100,
      // Only a settled bill that got DEARER creates a new debt. One that got
      // cheaper leaves the resident in credit, which is not the same problem
      // and must not be dressed up as one.
      owesAgain: settled && total > bill.total,
      inCredit: settled && total < bill.total,
    });
  }

  const sum = (list, key) => Math.round(list.reduce((t, c) => t + c[key], 0) * 100) / 100;
  const owesAgain = changes.filter((c) => c.owesAgain);
  const inCredit = changes.filter((c) => c.inCredit);

  return {
    changes,
    skipped,
    totals: {
      billsAffected: changes.length,
      skipped: skipped.length,
      owesAgainCount: owesAgain.length,
      owesAgainTotal: sum(owesAgain, 'difference'),
      inCreditCount: inCredit.length,
      inCreditTotal: Math.abs(sum(inCredit, 'difference')),
      netDifference: sum(changes, 'difference'),
    },
  };
}

/**
 * Change the rate on a month, recalculating the bills already in it.
 *
 * A LOCKED month is refused here rather than in the interface, because the
 * interface is not the only caller. Reopening one means every bill recalculated,
 * residents who already paid asked to pay again, and a month that was reconciled
 * needing to be reconciled afresh — a decision that belongs to Sabarish, not to
 * whoever happens to be holding the treasurer's login.
 */
export async function changeRate(env, { period, ratePerKg, reason, actorId, dryRun = false }) {
  const periodRow = await env.DB.prepare('SELECT * FROM periods WHERE period = ?').bind(period).first();
  if (!periodRow) fail('DDP-BILL-005', { period });
  if (periodRow.status === 'locked') fail('DDP-BILL-012', { period, ratePerKg });

  const text = String(reason ?? '').trim();
  if (text.length < 3) fail('DDP-ADMIN-011', { field: 'rate_per_kg' });

  const rows = await env.DB.prepare(
    `SELECT id, flat, consumption, gas_amount, other_charges, additional_charges,
            late_fee, total, status, manual_total
       FROM bills WHERE period = ?`
  ).bind(period).all();
  const bills = rows.results ?? [];

  const plan = planRateChange(bills, {
    ratePerKg, conversionFactor: periodRow.conversion_factor,
  });
  const sanity = rateSanity(ratePerKg, periodRow.rate_per_kg);

  if (dryRun) {
    return { period, from: periodRow.rate_per_kg, to: ratePerKg, sanity, dryRun: true, ...plan };
  }

  const now = new Date().toISOString();
  const statements = [
    env.DB.prepare('UPDATE periods SET rate_per_kg = ? WHERE period = ?').bind(ratePerKg, period),
  ];
  for (const c of plan.changes) {
    statements.push(env.DB.prepare(
      // A settled bill that grew is returned to 'unpaid' so it is chased like
      // any other. `late_fee_at` is untouched on purpose: it is the late-fee
      // cron's idempotency guard, so a bill that has already been charged one
      // will not be charged a second time for a debt we created.
      c.owesAgain
        ? `UPDATE bills SET rate_per_kg = ?, gas_amount = ?, total = ?, status = 'unpaid', paid_at = NULL WHERE id = ?`
        : `UPDATE bills SET rate_per_kg = ?, gas_amount = ?, total = ? WHERE id = ?`
    ).bind(ratePerKg, c.gasAmount, c.now, c.billId));
  }
  for (let i = 0; i < statements.length; i += 50) {
    await env.DB.batch(statements.slice(i, i + 50));
  }

  return { period, from: periodRow.rate_per_kg, to: ratePerKg, sanity,
           reason: text, actorId, changedAt: now, dryRun: false, ...plan };
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
 * Which columns a header row names, or null when the first line is data.
 *
 * THE BUG THIS EXISTS FOR. `downloadTemplate` hands out
 * `flat,floor,previous,reading` and its docstring promises "column order is
 * guaranteed on the way back" — and the way back did not honour it. The
 * heuristic below reads everything before the last number as the flat, so a
 * filled-in template row `4A,4,5.817,6.900` asked for a flat called
 * "4A 4 5.817" and every single row failed as unknown-flat. The app's own
 * export could not be imported by the app. Found on 2026-08-12 while adding
 * file upload, by round-tripping the template rather than reading the code.
 *
 * Recognised only when the line names BOTH columns and carries no number of
 * its own, so a data row is never mistaken for a header.
 */
function headerColumns(line) {
  const cells = line.split(/[\t,;]/).map((c) => normaliseFlat(c));
  if (cells.some((c) => /^\d+(\.\d+)?$/.test(c))) return null;
  const flat = cells.indexOf('FLAT');
  const reading = cells.indexOf('READING');
  if (flat === -1 || reading === -1) return null;
  return { flat, reading };
}

/**
 * Parse pasted or uploaded readings. Returns a DRAFT — never writes.
 * Unrecognised flats surface as errors rather than being silently dropped.
 *
 * Two shapes, and the header decides which. With a header the columns are read
 * BY NAME, which is what makes the template round-trip and what lets a
 * spreadsheet carry extra columns in any order. Without one, the original
 * heuristic still applies, because "4A 5.817" pasted out of a WhatsApp message
 * has no header and is how this was always used.
 */
export function parseReadings(text, knownFlats) {
  const known = new Map(knownFlats.map((f) => [normaliseFlat(f), f]));
  const rows = [];
  const errors = [];
  const seen = new Set();

  const lines = String(text).split(/\r?\n/);
  const firstData = lines.findIndex((l) => l.trim() !== '');
  const columns = firstData === -1 ? null : headerColumns(lines[firstData].trim());

  for (const [index, raw] of lines.entries()) {
    const line = raw.trim();
    if (!line) continue;
    // The header itself is not an error. It used to be reported as
    // "not-a-number", so every template import opened with a failure the
    // treasurer had to decide to ignore.
    if (columns && index === firstData) continue;

    if (columns) {
      // Split WITHOUT collapsing, so an empty cell keeps its position and
      // column 3 is still column 3 on a row whose reading has not been taken.
      const cells = line.split(/[\t,;]/).map((c) => c.trim());
      const label = cells[columns.flat] ?? '';
      const value = cells[columns.reading] ?? '';
      // A blank reading is a flat not yet read, not a bad row. The grid shows
      // it as still empty, which is exactly what it is.
      if (value === '') continue;
      if (!/^\d+(\.\d+)?$/.test(value)) {
        errors.push({ line, flat: label, reason: 'not-a-number' });
        continue;
      }
      const key = normaliseFlat(label);
      if (!known.has(key)) { errors.push({ line, flat: label, reason: 'unknown-flat' }); continue; }
      if (seen.has(key)) { errors.push({ line, flat: label, reason: 'duplicate' }); continue; }
      seen.add(key);
      rows.push({ flat: known.get(key), reading: Number(value) });
      continue;
    }

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
