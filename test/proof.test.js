import { describe, it, expect } from 'vitest';
import {
  normaliseVisionResult, assessProof, validateUpload, extractUtr, shapeQueue, r2Key, MAX_BYTES,
} from '../functions/lib/proof.js';
import { safeJson, bytesToBase64 } from '../functions/lib/vision.js';

const bill = { total: 329.04 };

describe('reading what the model returned', () => {
  it('accepts the keys different models actually use', () => {
    expect(normaliseVisionResult({ amount: 329.04 }).amount).toBe(329.04);
    expect(normaliseVisionResult({ total: 329.04 }).amount).toBe(329.04);
    expect(normaliseVisionResult({ amount_paid: 329.04 }).amount).toBe(329.04);
  });

  it('strips rupee symbols and thousands separators', () => {
    expect(normaliseVisionResult({ amount: '₹1,588.51' }).amount).toBe(1588.51);
    expect(normaliseVisionResult({ amount: ' 329.04 ' }).amount).toBe(329.04);
  });

  it('returns null rather than zero for an unreadable amount', () => {
    // Zero would read as a genuine ₹0.00 payment and could be approved.
    for (const junk of ['unknown', 'Rs.', '', null, 'n/a', 0, -5]) {
      expect(normaliseVisionResult({ amount: junk }).amount, String(junk)).toBe(null);
    }
  });

  it('pulls a 12-digit UTR out of surrounding text', () => {
    expect(extractUtr('UTR: 421877390021')).toBe('421877390021');
    expect(extractUtr('Ref no 421877390021 · SBI')).toBe('421877390021');
  });

  it('rejects reference numbers of the wrong length', () => {
    expect(extractUtr('12345')).toBe(null);
    expect(extractUtr('')).toBe(null);
  });

  it('survives a model returning nothing useful', () => {
    expect(normaliseVisionResult(null)).toEqual({ amount: null, utr: null, date: null, payee: null });
    expect(normaliseVisionResult('garbage')).toEqual({ amount: null, utr: null, date: null, payee: null });
  });
});

describe('unwrapping model output', () => {
  it('parses a bare JSON object', () => {
    expect(safeJson('{"amount":329.04}')).toEqual({ amount: 329.04 });
  });

  it('parses JSON inside a code fence', () => {
    expect(safeJson('```json\n{"amount":329.04}\n```')).toEqual({ amount: 329.04 });
  });

  it('digs JSON out of surrounding prose', () => {
    expect(safeJson('Here you go: {"amount":329.04} hope that helps')).toEqual({ amount: 329.04 });
  });

  it('returns null rather than throwing on nonsense', () => {
    expect(safeJson('no json here')).toBe(null);
    expect(safeJson('')).toBe(null);
    expect(safeJson(null)).toBe(null);
  });
});

describe('assessing a claim against the bill', () => {
  it('accepts an exact match', () => {
    expect(assessProof({ amount: 329.04 }, bill)).toMatchObject({ verdict: 'match', matches: true });
  });

  it('tells the resident immediately when they have short-paid', () => {
    const r = assessProof({ amount: 150 }, bill);
    expect(r.verdict).toBe('short');
    expect(r.short).toBe(179.04);
    expect(r.message).toContain('₹150.00');
    expect(r.message).toContain('₹329.04');
  });

  it('flags an overpayment too', () => {
    expect(assessProof({ amount: 500 }, bill).verdict).toBe('over');
  });

  it('catches a one-paisa miss — the paise identify the flat', () => {
    expect(assessProof({ amount: 329.05 }, bill).matches).toBe(false);
  });

  it('queues an unreadable amount rather than guessing', () => {
    const r = assessProof({ amount: null }, bill);
    expect(r.verdict).toBe('unreadable');
    expect(r.matches).toBe(false);
    expect(r.message).toContain('by hand');
  });

  it('compares in paise, so float noise cannot cause a false mismatch', () => {
    expect(assessProof({ amount: 0.1 + 0.2 }, { total: 0.3 }).matches).toBe(true);
  });
});

describe('upload validation', () => {
  it('accepts the formats a phone actually produces', () => {
    for (const type of ['image/jpeg', 'image/png', 'image/webp']) {
      expect(validateUpload({ type, size: 90_000 }).ok).toBe(true);
    }
  });

  it('rejects a PDF or anything else', () => {
    expect(validateUpload({ type: 'application/pdf', size: 90_000 }).ok).toBe(false);
  });

  it('rejects an empty file', () => {
    expect(validateUpload({ type: 'image/jpeg', size: 0 }).ok).toBe(false);
  });

  it('rejects an oversized upload with advice, not a code', () => {
    const r = validateUpload({ type: 'image/jpeg', size: MAX_BYTES + 1 });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/compress/);
  });
});

describe('the treasurer queue', () => {
  const proofs = [
    { id: 1, bill_id: 11, flat: '7C', name: 'Priya Menon', period: '2026-06', total: 412.07, parsed_amount: 412.07, utr: '421877390088', created_at: 'x' },
    { id: 2, bill_id: 12, flat: '4A', name: 'Sabarish Nair', period: '2026-06', total: 329.04, parsed_amount: 329.04, utr: '421877390021', created_at: 'x' },
    { id: 3, bill_id: 13, flat: '11D', name: 'Rajan Pillai', period: '2026-06', total: 287.11, parsed_amount: 150, utr: null, created_at: 'x' },
    { id: 4, bill_id: 14, flat: '2B', name: 'Anil', period: '2026-06', total: 210.02, parsed_amount: null, utr: null, created_at: 'x' },
  ];
  const claimed = [
    { id: 20, flat: '5A', name: 'Sekharan', period: '2026-06', total: 162.07, last_intent: 'y' },
  ];

  it('separates exact matches so they can be approved in bulk', () => {
    const q = shapeQueue({ proofs, claimed });
    expect(q.exactMatches).toEqual([1, 2]);
  });

  it('leaves only the exceptions needing thought', () => {
    const q = shapeQueue({ proofs, claimed });
    expect(q.needsAttention.map((p) => p.flat)).toEqual(['11D', '2B']);
  });

  it('marks an unreadable proof distinctly from a mismatched one', () => {
    const q = shapeQueue({ proofs, claimed });
    expect(q.needsAttention.find((p) => p.flat === '2B').unreadable).toBe(true);
    expect(q.needsAttention.find((p) => p.flat === '11D').unreadable).toBe(false);
  });

  it('lists residents who tapped Pay and sent nothing — the normal case', () => {
    const q = shapeQueue({ proofs, claimed });
    expect(q.claimedNoProof).toHaveLength(1);
    expect(q.claimedNoProof[0].flat).toBe('5A');
  });

  it('copes with an empty month', () => {
    const q = shapeQueue({});
    expect(q.awaiting).toEqual([]);
    expect(q.exactMatches).toEqual([]);
    expect(q.claimedNoProof).toEqual([]);
  });
});

describe('storage keys', () => {
  it('partitions by period and flat, and is stable for a given image', () => {
    const hash = 'a'.repeat(64);
    expect(r2Key('4A', '2026-06', hash)).toBe('proofs/2026-06/4A/aaaaaaaaaaaaaaaa.jpg');
  });
});

describe('base64 encoding', () => {
  it('round-trips bytes without blowing the stack on a large image', () => {
    const bytes = new Uint8Array(300_000).map((_, i) => i % 256);
    const b64 = bytesToBase64(bytes);
    expect(b64.length).toBeGreaterThan(300_000);
    expect(Buffer.from(b64, 'base64').length).toBe(bytes.length);
  });
});
