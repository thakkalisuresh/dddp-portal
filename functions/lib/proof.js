/**
 * Payment proofs.
 *
 * A screenshot is a CLAIM, not proof. Ground truth is the treasurer's bank
 * statement. Everything here exists to make the treasurer's review fast and to
 * catch honest mistakes — not to establish that money moved.
 */

import { fail } from './errors.js';

export const MAX_BYTES = 2 * 1024 * 1024;   // after client-side compression
export const ACCEPTED = ['image/jpeg', 'image/png', 'image/webp'];

/** UPI reference numbers are 12 digits. */
const UTR_RE = /\b(\d{12})\b/;

export function extractUtr(text) {
  const match = String(text ?? '').match(UTR_RE);
  return match ? match[1] : null;
}

/**
 * Normalise whatever the vision model returned into the four fields we use.
 * Models are inconsistent about keys, currency symbols and thousands
 * separators, so this is deliberately forgiving about shape and strict about
 * the value it produces.
 */
export function normaliseVisionResult(raw) {
  if (!raw || typeof raw !== 'object') return { amount: null, utr: null, date: null, payee: null };

  const pick = (...keys) => {
    for (const k of keys) {
      const v = raw[k];
      if (v != null && v !== '') return v;
    }
    return null;
  };

  const rawAmount = pick('amount', 'total', 'amountPaid', 'amount_paid', 'value');
  let amount = null;
  if (rawAmount != null) {
    const cleaned = String(rawAmount).replace(/[₹,\s]/g, '');
    const n = Number(cleaned);
    // A model that returns "Rs." or "unknown" must yield null, not 0 — zero
    // would read as a real ₹0.00 payment.
    amount = Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
  }

  const utrRaw = pick('utr', 'UTR', 'referenceNumber', 'reference', 'transactionId', 'txnId');
  const utr = utrRaw ? extractUtr(utrRaw) : null;

  return {
    amount,
    utr,
    date: pick('date', 'paidOn', 'transactionDate'),
    payee: pick('payee', 'to', 'paidTo', 'merchant'),
  };
}

/**
 * Compare a claim against the bill. Returns a verdict for the resident
 * immediately — telling them at upload beats the treasurer finding it days
 * later.
 */
export function assessProof(parsed, bill) {
  if (!bill) fail('DDP-PROOF-003', { reason: 'no bill' });

  const expected = Math.round(bill.total * 100);
  const claimed = parsed?.amount == null ? null : Math.round(parsed.amount * 100);

  if (claimed == null) {
    return {
      verdict: 'unreadable',
      matches: false,
      message: "We couldn't read the amount. The treasurer will check it by hand.",
    };
  }
  if (claimed === expected) {
    return { verdict: 'match', matches: true, message: null };
  }
  if (claimed < expected) {
    return {
      verdict: 'short',
      matches: false,
      short: (expected - claimed) / 100,
      message: `This screenshot shows ₹${(claimed / 100).toFixed(2)} but your bill is ₹${bill.total.toFixed(2)}.`,
    };
  }
  return {
    verdict: 'over',
    matches: false,
    over: (claimed - expected) / 100,
    message: `This screenshot shows ₹${(claimed / 100).toFixed(2)}, more than your bill of ₹${bill.total.toFixed(2)}.`,
  };
}

/** Reject an upload before it costs anything. */
export function validateUpload({ type, size }) {
  if (!ACCEPTED.includes(type)) {
    return { ok: false, message: 'Upload a photo or screenshot (JPEG, PNG or WebP).' };
  }
  if (!Number.isFinite(size) || size <= 0) {
    return { ok: false, message: 'That file appears to be empty.' };
  }
  if (size > MAX_BYTES) {
    return { ok: false, message: 'That image is too large. Try again — it should compress automatically.' };
  }
  return { ok: true };
}

/**
 * The treasurer's queue has TWO sections, because most residents pay and never
 * upload anything — that is the normal case, not an edge case (plan §4b).
 */
export function shapeQueue({ proofs = [], claimed = [] }) {
  const withProof = proofs.map((p) => ({
    proofId: p.id,
    billId: p.bill_id,
    flat: p.flat,
    name: p.name,
    period: p.period,
    billed: p.total,
    claimedAmount: p.parsed_amount,
    utr: p.utr,
    createdAt: p.created_at,
    matches: p.parsed_amount != null && Math.round(p.parsed_amount * 100) === Math.round(p.total * 100),
    unreadable: p.parsed_amount == null,
  }));

  return {
    // Exact matches bulk-approve; only exceptions need thought.
    awaiting: withProof,
    exactMatches: withProof.filter((p) => p.matches).map((p) => p.proofId),
    needsAttention: withProof.filter((p) => !p.matches),
    // Tapped Pay, sent nothing. Reconciled by matching the amount and the
    // payer's name against the bank statement — no UTR to go on.
    claimedNoProof: claimed.map((b) => ({
      billId: b.id, flat: b.flat, name: b.name, period: b.period,
      billed: b.total, since: b.last_intent,
    })),
  };
}

export function r2Key(flat, period, hash) {
  return `proofs/${period}/${flat}/${hash.slice(0, 16)}.jpg`;
}
