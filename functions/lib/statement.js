/**
 * Bank statement reconciliation.
 *
 * The treasurer uploads the association's statement, we match its credits
 * against what residents claimed, and we report only the disagreements. The
 * statement itself is working material, not a record: nothing here is meant to
 * outlive the review. See `finishStatement` in index.js for the deletion, and
 * migration 0017 for which table survives and which does not.
 *
 * The ground truth in this building has always been the bank statement — a
 * screenshot is a claim (lib/proof.js). This module is where the claim finally
 * meets the truth, so it is deliberately conservative: it will report a thing
 * as unexplained rather than guess a match that lets real money go missing.
 */

import { extractUtr, isBankComparable } from './proof.js';
import { fail, reportError } from './errors.js';

/** A review left open this long is abandoned; the statement should not wait overnight twice. */
export const SWEEP_AFTER_HOURS = 12;

/**
 * Delete the credit rows of any review nobody finished.
 *
 * The treasurer keeping a statement open is the one way the "deleted when
 * you're done" promise could quietly become "kept forever", so the cron closes
 * it for them. Verdicts are not written — nobody reviewed anything — but the
 * session row stays, marked swept, so the gap is visible afterwards.
 */
export async function sweepAbandonedStatements(env, now = Date.now()) {
  const cutoff = new Date(now - SWEEP_AFTER_HOURS * 3_600_000).toISOString();
  const stale = await env.DB.prepare(
    "SELECT id, row_count FROM statement_sessions WHERE status = 'open' AND created_at < ?"
  ).bind(cutoff).all();

  const sessions = stale.results ?? [];
  for (const s of sessions) {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM statement_credits WHERE session_id = ?').bind(s.id),
      env.DB.prepare("UPDATE statement_sessions SET status = 'swept', finished_at = ? WHERE id = ?")
        .bind(new Date(now).toISOString(), s.id),
    ]);
    await reportError(env, 'DDP-RECON-006', { sessionId: s.id, rows: s.row_count });
  }
  return { swept: sessions.length };
}

/** A statement is small; this is a guard against someone uploading a disk image. */
export const MAX_STATEMENT_BYTES = 5 * 1024 * 1024;
export const ACCEPTED_STATEMENT = [
  'text/csv', 'application/csv', 'text/plain',
  'application/vnd.ms-excel',          // what browsers often label a .csv
  'application/pdf',
];

/** How far apart a payment and its proof may sit before we stop assuming they are the same event. */
export const DEFAULT_DAY_WINDOW = 3;

export function validateStatement({ type, size, name = '' }) {
  const looksCsv = /\.csv$/i.test(name);
  const looksPdf = /\.pdf$/i.test(name);
  if (!ACCEPTED_STATEMENT.includes(type) && !looksCsv && !looksPdf) {
    return { ok: false, message: 'Upload the statement as CSV or PDF.' };
  }
  if (!Number.isFinite(size) || size <= 0) return { ok: false, message: 'That file appears to be empty.' };
  if (size > MAX_STATEMENT_BYTES) return { ok: false, message: 'That statement is too large.' };
  return { ok: true };
}

/* ── money and dates ────────────────────────────────────────────────────── */

/** Bank exports carry ₹, commas, footnote daggers and a trailing Cr/Dr. */
export function parseAmount(value) {
  if (value == null) return null;
  let s = String(value).trim();
  if (!s) return null;
  const trailing = /\b(cr|dr)\b\.?$/i.exec(s);
  s = s.replace(/\b(cr|dr)\b\.?$/i, '').replace(/[₹,\s"]/g, '').trim();
  if (s.startsWith('(') && s.endsWith(')')) s = `-${s.slice(1, -1)}`; // accounting negative
  const n = Number(s);
  if (!Number.isFinite(n) || n === 0) return null;
  const signed = trailing && trailing[1].toLowerCase() === 'dr' ? -Math.abs(n) : n;
  return Math.round(signed * 100) / 100;
}

const MONTHS = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};

/**
 * Indian bank exports are overwhelmingly day-first. An ambiguous 05/08/2026 is
 * read as 5 August, not 8 May — guessing the other way would silently shift
 * every match window by months.
 */
export function parseDate(value) {
  if (!value) return null;
  const s = String(value).trim();

  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;

  m = /^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/.exec(s);
  if (m) {
    const [, d, mo, y] = m;
    const year = y.length === 2 ? `20${y}` : y;
    return `${year}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }

  m = /^(\d{1,2})[\s\-]([A-Za-z]{3})[A-Za-z]*[\s\-](\d{2,4})/.exec(s);
  if (m) {
    const mo = MONTHS[m[2].toLowerCase()];
    if (!mo) return null;
    const year = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${year}-${mo}-${m[1].padStart(2, '0')}`;
  }
  return null;
}

function daysBetween(a, b) {
  if (!a || !b) return Infinity;
  const ms = Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`));
  return Number.isFinite(ms) ? ms / 86_400_000 : Infinity;
}

const paise = (n) => (n == null ? null : Math.round(n * 100));

/* ── CSV ────────────────────────────────────────────────────────────────── */

/** A real CSV reader: quoted fields, embedded commas, doubled quotes, CRLF. */
export function parseCsv(text, delimiter = null) {
  const src = String(text ?? '').replace(/^﻿/, '');
  const delim = delimiter ?? sniffDelimiter(src);
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < src.length; i += 1) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 1; } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') { quoted = true; continue; }
    if (c === delim) { row.push(field); field = ''; continue; }
    if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i += 1;
      row.push(field); field = '';
      if (row.some((v) => v.trim() !== '')) rows.push(row);
      row = [];
      continue;
    }
    field += c;
  }
  row.push(field);
  if (row.some((v) => v.trim() !== '')) rows.push(row);
  return rows.map((r) => r.map((v) => v.trim()));
}

function sniffDelimiter(text) {
  const head = text.slice(0, 4000);
  const counts = [',', ';', '\t', '|'].map((d) => [d, head.split(d).length]);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 1 ? counts[0][0] : ',';
}

const HEADER_PATTERNS = {
  date: /\b(txn|transaction|value|posting|tran)?\s*\.?\s*date\b|^date$/i,
  narration: /narration|description|particular|remark|detail|transaction remarks/i,
  credit: /credit|deposit|cr\s*amount|amount\s*\(cr\)/i,
  debit: /debit|withdraw|dr\s*amount|amount\s*\(dr\)/i,
  amount: /^amount|transaction amount|txn amount/i,
  type: /\b(dr\s*\/?\s*cr|cr\s*\/?\s*dr|type|indicator)\b/i,
  reference: /\b(ref|utr|rrn|cheque|chq|instrument)\b/i,
};

/** Bank exports bury the table under account-holder preamble. Find the real header row. */
export function findHeader(rows) {
  for (let i = 0; i < Math.min(rows.length, 40); i += 1) {
    const cells = rows[i];
    if (cells.length < 3) continue;
    const hasDate = cells.some((c) => HEADER_PATTERNS.date.test(c));
    const hasMoney = cells.some((c) =>
      HEADER_PATTERNS.credit.test(c) || HEADER_PATTERNS.amount.test(c) || HEADER_PATTERNS.debit.test(c));
    if (hasDate && hasMoney) return { index: i, columns: mapColumns(cells) };
  }
  return null;
}

function mapColumns(cells) {
  const columns = {};
  cells.forEach((cell, i) => {
    for (const [key, re] of Object.entries(HEADER_PATTERNS)) {
      if (columns[key] === undefined && re.test(cell)) columns[key] = i;
    }
  });
  return columns;
}

/**
 * Credits only. A debit is the association spending money and has nothing to
 * reconcile against; including them would invent discrepancies out of thin air.
 */
export function creditsFromCsv(text) {
  const rows = parseCsv(text);
  const header = findHeader(rows);
  if (!header) fail('DDP-RECON-001', { reason: 'no header row found' });

  const { columns } = header;
  const warnings = [];
  const ambiguous = columns.credit === undefined && columns.type === undefined;
  if (ambiguous && columns.amount === undefined) {
    fail('DDP-RECON-001', { reason: 'no credit or amount column' });
  }
  if (ambiguous) {
    warnings.push('This export has no separate credit column, so positive amounts were treated as money in. Check the totals before finishing.');
  }

  const credits = [];
  for (let i = header.index + 1; i < rows.length; i += 1) {
    const cells = rows[i];
    const at = (idx) => (idx === undefined ? '' : cells[idx] ?? '');

    let amount = null;
    if (columns.credit !== undefined) {
      amount = parseAmount(at(columns.credit));
    } else if (columns.type !== undefined && columns.amount !== undefined) {
      const kind = at(columns.type).trim().toLowerCase();
      if (kind.startsWith('c')) amount = parseAmount(at(columns.amount));
    } else if (columns.amount !== undefined) {
      const value = parseAmount(at(columns.amount));
      if (value != null && value > 0) amount = value;
    }
    if (amount == null || amount <= 0) continue;

    const narration = at(columns.narration);
    const refCell = at(columns.reference);
    credits.push({
      date: parseDate(at(columns.date)),
      amount,
      // The 12-digit RRN usually lives inside the narration (UPI/CR/6219.../NAME),
      // not in the reference column, which often holds a cheque number.
      reference: extractUtr(refCell) ?? extractUtr(narration),
      narration,
    });
  }

  if (!credits.length) fail('DDP-RECON-002', { rows: rows.length });
  return { credits, warnings };
}

/* ── PDF ────────────────────────────────────────────────────────────────── */

/**
 * Pull the text layer out of a PDF, with no library and no third party.
 *
 * This matters more than it looks: the obvious way to read a PDF here would be
 * to hand it to the vision model that already reads receipts. That would mean
 * posting the association's full bank statement — every member's name and
 * payment history — to an external API, which is the opposite of what a
 * statement that gets deleted in an hour is for. So we read it ourselves, and
 * when we cannot, we say so and ask for the CSV.
 *
 * A scanned or secured statement has no text layer and will fail here by
 * design. DDP-RECON-007 tells the treasurer to download the CSV instead.
 */
export async function extractPdfText(bytes) {
  const view = new Uint8Array(bytes);
  const latin = new TextDecoder('latin1').decode(view);
  const chunks = [];

  // Uncompressed content streams first — some banks emit them.
  for (const m of latin.matchAll(/stream\r?\n([\s\S]*?)endstream/g)) {
    const body = m[1];
    if (/^[\x00-\x08\x0e-\x1f]/.test(body) === false && /\bTJ\b|\bTj\b/.test(body)) {
      chunks.push(body);
    }
  }

  // Then Flate-compressed ones, inflated with the platform's own decompressor.
  const offsets = [...latin.matchAll(/stream\r?\n/g)].map((m) => m.index + m[0].length);
  for (const start of offsets) {
    const end = latin.indexOf('endstream', start);
    if (end < 0) continue;
    const slice = view.subarray(start, end);
    if (slice.length < 2 || slice[0] !== 0x78) continue;   // zlib header
    try {
      const stream = new Blob([slice]).stream().pipeThrough(new DecompressionStream('deflate'));
      const text = await new Response(stream).text();
      if (/\bTJ\b|\bTj\b/.test(text)) chunks.push(text);
    } catch {
      // A stream we cannot inflate is an image or a font; skip it.
    }
  }

  if (!chunks.length) fail('DDP-RECON-007', { reason: 'no text layer' });
  return chunks.map(textFromContentStream).join('\n');
}

/** Turn PDF text-showing operators back into lines. */
export function textFromContentStream(content) {
  const out = [];
  let line = '';
  // Td/TD/T* move the cursor; treat a vertical move as a line break.
  const token = /\((?:\\.|[^\\()])*\)|<[0-9A-Fa-f\s]+>|\bT[dD]\b|\bT\*\b|\bTJ\b|\bTj\b|\bET\b/g;
  for (const m of content.matchAll(token)) {
    const t = m[0];
    if (t === 'Td' || t === 'TD' || t === 'T*' || t === 'ET') {
      if (line.trim()) out.push(line.trim());
      line = '';
    } else if (t.startsWith('(')) {
      line += unescapePdfString(t.slice(1, -1));
    } else if (t.startsWith('<')) {
      line += hexToText(t.slice(1, -1));
    }
  }
  if (line.trim()) out.push(line.trim());
  return out.join('\n');
}

function unescapePdfString(s) {
  return s.replace(/\\([nrtbf()\\]|[0-7]{1,3})/g, (_, esc) => {
    switch (esc) {
      case 'n': return '\n';
      case 'r': return '';
      case 't': return ' ';
      case 'b': case 'f': return '';
      case '(': return '(';
      case ')': return ')';
      case '\\': return '\\';
      default: return String.fromCharCode(parseInt(esc, 8));
    }
  });
}

function hexToText(hex) {
  const clean = hex.replace(/\s+/g, '');
  let out = '';
  for (let i = 0; i + 1 < clean.length; i += 2) {
    const code = parseInt(clean.slice(i, i + 2), 16);
    if (code >= 32 && code < 127) out += String.fromCharCode(code);
  }
  return out;
}

/**
 * Read credits out of statement text extracted from a PDF.
 *
 * Line-oriented and deliberately loose: a line is a candidate when it holds a
 * date and at least one amount. The last amount on a bank statement line is
 * almost always the running balance, so it is dropped.
 */
export function creditsFromText(text) {
  const credits = [];
  const warnings = ['Read from the PDF text layer. Check the totals against the statement before finishing.'];
  const moneyRe = /\d[\d,]*\.\d{2}\b|\b\d[\d,]{2,}\b/g;

  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const date = parseDate(line) ?? parseDate((/\b\d{1,2}[\/\-][A-Za-z0-9]{2,3}[\/\-]\d{2,4}\b/.exec(line) ?? [])[0]);
    if (!date) continue;

    const amounts = (line.match(moneyRe) ?? []).map(parseAmount).filter((n) => n != null && n > 0);
    if (amounts.length < 2) continue;          // need at least an amount and a balance
    const isDebit = /\b(dr|debit|withdraw)\b/i.test(line);
    if (isDebit) continue;
    if (!/\b(cr|credit|deposit|upi|neft|imps|rtgs|transfer)\b/i.test(line)) continue;

    const amount = amounts[amounts.length - 2];   // last is the running balance
    credits.push({ date, amount, reference: extractUtr(line), narration: line.slice(0, 200) });
  }

  if (!credits.length) fail('DDP-RECON-002', { reason: 'no credit lines in pdf text' });
  return { credits, warnings };
}

/** One entry point for either format. */
export async function parseStatement({ bytes, type, name = '' }) {
  const isPdf = type === 'application/pdf' || /\.pdf$/i.test(name);
  if (isPdf) return creditsFromText(await extractPdfText(bytes));
  return creditsFromCsv(new TextDecoder('utf-8').decode(bytes));
}

/* ── matching ───────────────────────────────────────────────────────────── */

/**
 * Match credits to proofs, then report what is left over on both sides.
 *
 * Two passes, strongest evidence first:
 *   1. the 12-digit RRN, which both sides can carry
 *   2. amount and date, and only when exactly one candidate fits
 *
 * A PhonePe or Kiwi reference never reaches the statement, so those proofs
 * always fall to pass 2. That is expected, not a failure.
 *
 * @param {object[]} credits  parsed statement credits
 * @param {object[]} proofs   pending proofs joined to their bills
 * @param {object[]} openBills unpaid bills, to suggest an owner for stray credits
 */
export function reconcile({ credits = [], proofs = [], openBills = [], dayWindow = DEFAULT_DAY_WINDOW } = {}) {
  const creditState = credits.map((c, i) => ({ ...c, index: i, proofId: null }));

  // Deduplicated by proofId before anything else. A caller whose SQL fans out
  // — a flat with an owner AND a tenant matching `owners.flat` — hands us the
  // same proof twice, and two identical rows sharing one reference is exactly
  // what the duplicate check below is looking for. That bug reported honest
  // residents as double-claiming, which is the most damaging thing this file
  // could get wrong, so it is defended here as well as in the query.
  const seenProofs = new Set();
  const proofState = proofs
    .filter((p) => {
      if (seenProofs.has(p.proofId)) return false;
      seenProofs.add(p.proofId);
      return true;
    })
    .map((p) => ({ ...p, creditIndex: null, how: null }));

  const duplicates = findDuplicateReferences(proofState);

  // Pass 1 — reference.
  const byReference = new Map();
  for (const c of creditState) {
    if (c.reference) {
      if (!byReference.has(c.reference)) byReference.set(c.reference, []);
      byReference.get(c.reference).push(c);
    }
  }
  for (const p of proofState) {
    if (!p.utr || !isBankComparable(p.utr)) continue;
    const candidates = (byReference.get(p.utr) ?? []).filter((c) => c.proofId == null);
    if (candidates.length === 1) {
      candidates[0].proofId = p.proofId;
      p.creditIndex = candidates[0].index;
      p.how = 'reference';
    }
  }

  // Pass 2 — amount and date, unambiguous only.
  for (const p of proofState) {
    if (p.creditIndex != null) continue;
    const want = paise(p.claimedAmount ?? p.billed);
    if (want == null) continue;
    const on = (p.createdAt ?? '').slice(0, 10);
    const candidates = creditState.filter((c) =>
      c.proofId == null && paise(c.amount) === want && daysBetween(c.date, on) <= dayWindow);
    if (candidates.length === 1) {
      candidates[0].proofId = p.proofId;
      p.creditIndex = candidates[0].index;
      p.how = 'amount-and-date';
    }
  }

  const confirmed = [];
  const discrepancies = [];

  for (const p of proofState) {
    if (duplicates.has(p.proofId)) {
      discrepancies.push({
        kind: 'duplicate_reference', proofId: p.proofId, billId: p.billId, flat: p.flat, name: p.name,
        period: p.period, billed: p.billed, claimed: p.claimedAmount, reference: p.utr,
        detail: 'The same payment reference was uploaded on more than one bill.',
      });
      continue;
    }
    if (p.creditIndex == null) {
      discrepancies.push({
        kind: 'proof_no_credit', proofId: p.proofId, billId: p.billId, flat: p.flat, name: p.name,
        period: p.period, billed: p.billed, claimed: p.claimedAmount, reference: p.utr,
        detail: 'A screenshot was uploaded but no matching credit appears on the statement.',
      });
      continue;
    }
    const credit = creditState[p.creditIndex];
    const claimed = paise(p.claimedAmount);
    if (claimed != null && paise(credit.amount) !== claimed) {
      discrepancies.push({
        kind: 'amount_mismatch', proofId: p.proofId, billId: p.billId, flat: p.flat, name: p.name,
        period: p.period, billed: p.billed, claimed: p.claimedAmount,
        reference: credit.reference ?? p.utr, bankAmount: credit.amount, txnDate: credit.date,
        detail: `The screenshot claims ₹${p.claimedAmount} but the bank shows ₹${credit.amount}.`,
      });
      continue;
    }
    confirmed.push({
      proofId: p.proofId, billId: p.billId, flat: p.flat, name: p.name, period: p.period,
      billed: p.billed, amount: credit.amount, reference: credit.reference ?? p.utr,
      txnDate: credit.date, how: p.how,
      // Matched money that does not settle the bill is still worth flagging.
      settles: paise(credit.amount) === paise(p.billed),
    });
  }

  // Money in the bank that nobody claimed — in this building, the residents who
  // pay by UPI and never open the portal at all.
  for (const c of creditState) {
    if (c.proofId != null) continue;
    const suggestions = openBills
      .filter((b) => paise(b.total) === paise(c.amount))
      .slice(0, 5)
      .map((b) => ({ billId: b.id, flat: b.flat, name: b.name, period: b.period, total: b.total }));
    discrepancies.push({
      kind: 'credit_no_proof', amount: c.amount, txnDate: c.date,
      reference: c.reference, narration: c.narration, suggestions,
      detail: suggestions.length
        ? 'Money arrived with no screenshot. One or more unpaid bills match this amount.'
        : 'Money arrived with no screenshot and no unpaid bill matches the amount.',
    });
  }

  return {
    confirmed,
    discrepancies,
    totals: summarise(creditState, confirmed, discrepancies),
  };
}

/**
 * Split a reconciliation into what a treasurer actually has to DO about it.
 *
 * B25. Seventeen residents paying perfectly still produced a page of
 * "discrepancies", because the bank pays interest into the account and no
 * resident will ever upload a screenshot for it. Same for refunds, reversals,
 * the maintenance transfer and the Onam collection. Everything that was not a
 * matched proof landed in one list, so the list stopped being read.
 *
 * REJECTED, AND IT SHOULD STAY REJECTED: reconciling only against the month's
 * expected bill amounts. It deletes the case the feature exists for — a flat
 * billed ₹310 that pays ₹300 by UPI and never opens the portal stops appearing
 * anywhere at all, takes a late fee, and the money sits in the account unseen.
 * That flat's credit is exactly what lands in `unmatched` below, which is why
 * that bucket is shown rather than filtered away.
 *
 * Pure, and it invents nothing. `suggestions` is already computed by reconcile
 * — whether any unpaid bill has this exact amount — and that is the only signal
 * used here. No new guessing, just the existing answer put where it can be read.
 */
export function bucketReconciliation({ confirmed = [], discrepancies = [] } = {}) {
  const credits = discrepancies.filter((d) => d.kind === 'credit_no_proof');

  return {
    // Money matched to a screenshot somebody uploaded.
    confirmed,
    // A real problem with a real claim: the amounts disagree, a reference was
    // used twice, or a proof claims money the bank never received.
    needsAttention: discrepancies.filter((d) => d.kind !== 'credit_no_proof'),
    // Almost certainly a resident who paid and never opened the portal: an
    // unpaid bill matches this amount to the paisa. One tap to settle.
    likelyResident: credits.filter((c) => (c.suggestions?.length ?? 0) > 0),
    // Nothing matches. Bank interest and refunds live here — and so does the
    // resident who underpaid, which is why this is a bucket and not a bin.
    unmatched: credits.filter((c) => (c.suggestions?.length ?? 0) === 0),
  };
}

function findDuplicateReferences(proofs) {
  const seen = new Map();
  const dupes = new Set();
  for (const p of proofs) {
    if (!p.utr) continue;
    if (seen.has(p.utr)) { dupes.add(p.proofId); dupes.add(seen.get(p.utr)); }
    else seen.set(p.utr, p.proofId);
  }
  return dupes;
}

function summarise(credits, confirmed, discrepancies) {
  const sum = (list, key) => Math.round(list.reduce((t, x) => t + (x[key] ?? 0), 0) * 100) / 100;
  const counts = {};
  for (const d of discrepancies) counts[d.kind] = (counts[d.kind] ?? 0) + 1;
  return {
    creditRows: credits.length,
    creditTotal: sum(credits, 'amount'),
    confirmedCount: confirmed.length,
    confirmedTotal: sum(confirmed, 'amount'),
    unmatchedCreditTotal: sum(credits.filter((c) => c.proofId == null), 'amount'),
    discrepancyCount: discrepancies.length,
    byKind: counts,
  };
}
