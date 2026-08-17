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

/**
 * Payment references, in the forms the apps actually print them.
 *
 * The 12-digit NPCI reference (UTR/RRN) is the canonical one: it is the only
 * form that survives the trip to the association's bank statement, so it is
 * always preferred when a screenshot shows one. But it is not the only thing
 * residents send us, and treating it as such cost us the duplicate guard
 * entirely for some apps — `parsed.utr` came back null, the uniqueness check
 * at upload was skipped, and the same payment could be claimed on two bills.
 *
 * Observed in the residents' group:
 *   Google Pay / bank apps  621932447570               12 digits
 *   NEFT "Reference (RRN)"  618622601669               12 digits
 *   PhonePe                 T2608051827501900771902    T + 22 digits
 *   Kiwi (UPI on card)      AXBbc0389e4af71ea4ca1a...  alphanumeric
 *
 * A PhonePe or Kiwi id identifies the payment within that app, not at the
 * bank, so it will never match a statement narration — see lib/statement.js,
 * which falls back to amount and date. It is still worth storing, because
 * uniqueness across our own proofs is exactly what stops a double claim.
 */
const RRN_RE = /\b(\d{12})\b/;
const PHONEPE_RE = /\bT\d{15,30}\b/i;
/** Mixed letters and digits — must contain both, or it is a word or an account number. */
const ALNUM_RE = /\b(?=[A-Z0-9]*[A-Z])(?=[A-Z0-9]*\d)([A-Z0-9]{12,40})\b/i;
/** A long run of digits, accepted only when it is the whole value. */
const LONG_DIGITS_RE = /^(\d{13,22})$/;

/**
 * @returns {string|null} the reference, uppercased, or null
 */
export function extractUtr(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return null;

  const rrn = raw.match(RRN_RE);
  if (rrn) return rrn[1];

  const phonepe = raw.match(PHONEPE_RE);
  if (phonepe) return phonepe[0].toUpperCase();

  // Only when the whole field is the number. Plucking a long digit run out of
  // surrounding prose finds the association's account number, not a reference.
  const digits = raw.match(LONG_DIGITS_RE);
  if (digits) return digits[1];

  const alnum = raw.match(ALNUM_RE);
  if (alnum) return alnum[1].toUpperCase();

  return null;
}

/** What kind of reference this is, for display and for match strategy. */
export function referenceKind(reference) {
  if (!reference) return null;
  if (RRN_RE.test(reference) && /^\d{12}$/.test(reference)) return 'rrn';
  if (PHONEPE_RE.test(reference)) return 'phonepe';
  return 'app';
}

/** Only an RRN is comparable against a bank statement. */
export function isBankComparable(reference) {
  return referenceKind(reference) === 'rrn';
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

  // Ordered by how comparable the value is against a bank statement: an RRN
  // beats an app's own transaction id, so ask for the RRN keys first.
  const utrRaw = pick(
    'utr', 'UTR', 'rrn', 'RRN', 'referenceNumber', 'reference_number', 'referenceNo', 'reference',
    'transactionId', 'transaction_id', 'txnId', 'upiTransactionId', 'upi_transaction_id',
  );
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
      // Names no cause. The amount is absent either because the image was poor
      // or because the vision provider never answered, and this function cannot
      // tell the two apart — the old wording ("We couldn't read the amount")
      // blamed the photograph either way, which during a provider outage means
      // telling ninety-nine residents their screenshots were bad.
      message: 'The treasurer will check this by hand.',
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
export function shapeQueue({ proofs = [], claimed = [], decided = [] }) {
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
    // What was already decided, so a decision can be checked afterwards rather
    // than vanishing. `reviewer` is the admin who pressed the button — a
    // rejection with no name attached is not an audit trail.
    decided: decided.map((p) => ({
      proofId: p.id,
      billId: p.bill_id,
      flat: p.flat,
      name: p.name,
      period: p.period,
      billed: p.total,
      claimedAmount: p.parsed_amount,
      utr: p.utr,
      status: p.status,
      reviewer: p.reviewer,
      reviewedAt: p.reviewed_at,
    })),
  };
}

export function r2Key(flat, period, hash) {
  return `proofs/${period}/${flat}/${hash.slice(0, 16)}.jpg`;
}
