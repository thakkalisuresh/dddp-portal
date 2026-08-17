import { describe, it, expect } from 'vitest';
import {
  normaliseVisionResult, assessProof, validateUpload, extractUtr, shapeQueue, r2Key, MAX_BYTES,
  referenceKind, isBankComparable,
} from '../functions/lib/proof.js';
import { safeJson, bytesToBase64 } from '../functions/lib/vision.js';
import { proofVerdict } from '../public/js/ui.js';

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

  // The references residents actually send. Before these were accepted,
  // extractUtr returned null for PhonePe and Kiwi, the uniqueness check at
  // upload was skipped entirely, and the same payment could be claimed twice.
  it('reads a PhonePe transaction id', () => {
    expect(extractUtr('T2608051827501900771902')).toBe('T2608051827501900771902');
    expect(extractUtr('PhonePe Transaction ID T2608051827501900771902')).toBe('T2608051827501900771902');
  });

  it('reads an alphanumeric app reference', () => {
    expect(extractUtr('AXBbc0389e4af71ea4ca1a9a1ea673e5318'))
      .toBe('AXBBC0389E4AF71EA4CA1A9A1EA673E5318');
  });

  it('prefers the 12-digit RRN when a screenshot shows both', () => {
    // Only the RRN reaches the bank statement, so it is the one worth keeping.
    expect(extractUtr('UTR 621932447570 · txn T2608051827501900771902')).toBe('621932447570');
  });

  it('does not mistake the association account number for a reference', () => {
    // 0184073000000744 is printed on every payment screenshot in the building.
    expect(extractUtr('To A/c 0184073000000744 South Indian Bank')).toBe(null);
  });

  it('accepts a long numeric reference only when it is the whole value', () => {
    expect(extractUtr('110369293853')).toBe('110369293853');
    expect(extractUtr('12345678901234567')).toBe('12345678901234567');
  });

  it('ignores words that happen to be long', () => {
    expect(extractUtr('PAYMENTSUCCESSFUL')).toBe(null);
    expect(extractUtr('DD DIAMOND PARK RESIDENTS WELFARE ASSOCIATION')).toBe(null);
  });
});

describe('which references can be checked against a bank statement', () => {
  it('knows an RRN can, and an app id cannot', () => {
    expect(isBankComparable('621932447570')).toBe(true);
    expect(isBankComparable('T2608051827501900771902')).toBe(false);
    expect(isBankComparable('AXBBC0389E4AF71EA4CA1A9A1EA673E5318')).toBe(false);
    expect(isBankComparable(null)).toBe(false);
  });

  it('names the kind for display', () => {
    expect(referenceKind('621932447570')).toBe('rrn');
    expect(referenceKind('T2608051827501900771902')).toBe('phonepe');
    expect(referenceKind('AXBBC0389E4AF71EA4CA1A9A1EA673E5318')).toBe('app');
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

  it('does not blame the photograph for an amount it could not read', () => {
    // A provider outage and a blurry screenshot arrive here identically, so
    // the message must not assert either one.
    const r = assessProof({ amount: null }, bill);
    expect(r.message).not.toMatch(/read|blur|photo|image|screenshot/i);
  });
});

describe('how a proof reads in the review queue', () => {
  it('states the direction of an overpayment', () => {
    // The regression this exists for: the line hardcoded "short by" and
    // clamped at zero, so overpaying ₹45 rendered as "short by ₹0".
    const v = proofVerdict({ claimedAmount: 244, billed: 199 });
    expect(v.text).toContain('over by');
    expect(v.text).toContain('45');
    expect(v.text).not.toContain('short');
    expect(v.tone).toBe('bad');
  });

  it('states the direction of an underpayment', () => {
    const v = proofVerdict({ claimedAmount: 213, billed: 263 });
    expect(v.text).toContain('short by');
    expect(v.text).toContain('50');
    expect(v.tone).toBe('bad');
  });

  it('says nothing but "matches" when the two agree', () => {
    const v = proofVerdict({ claimedAmount: 500, billed: 500 });
    expect(v.text).toContain('matches');
    expect(v.tone).toBe('ok');
  });

  it('asks for a human when there is no amount, without naming a cause', () => {
    const v = proofVerdict({ claimedAmount: null, billed: 500 });
    expect(v.text).toContain('check by hand');
    expect(v.text).not.toMatch(/readable|blur|photo/i);
    expect(v.tone).toBe('muted');
  });

  it('compares in paise, so float noise is not a mismatch', () => {
    expect(proofVerdict({ claimedAmount: 0.1 + 0.2, billed: 0.3 }).tone).toBe('ok');
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

  // A decided proof used to leave the system's view entirely: every query
  // filtered on 'pending', so approving was the last anyone saw of it.
  describe('what was already decided', () => {
    const decided = [
      { id: 5, bill_id: 15, flat: '9B', name: 'Latha', period: '2026-05', total: 300, parsed_amount: 300, utr: '421877390099', status: 'approved', reviewer: 'Demo Admin', reviewed_at: '2026-06-02T04:00:00Z' },
      { id: 6, bill_id: 16, flat: '3D', name: 'Anju', period: '2026-05', total: 275, parsed_amount: null, utr: null, status: 'rejected', reviewer: 'Demo Admin', reviewed_at: '2026-06-02T05:00:00Z' },
    ];

    it('keeps approvals and rejections visible after the decision', () => {
      const q = shapeQueue({ proofs, claimed, decided });
      expect(q.decided.map((p) => p.status)).toEqual(['approved', 'rejected']);
    });

    it('names who decided, so a rejection can be traced back to a person', () => {
      const q = shapeQueue({ proofs, claimed, decided });
      expect(q.decided[1].reviewer).toBe('Demo Admin');
      expect(q.decided[1].reviewedAt).toBe('2026-06-02T05:00:00Z');
    });

    it('does not mix decided proofs into the waiting queue', () => {
      const q = shapeQueue({ proofs, claimed, decided });
      expect(q.awaiting.map((p) => p.proofId)).not.toContain(5);
      expect(q.exactMatches).not.toContain(5);
    });

    it('carries an unreadable decided proof without inventing an amount', () => {
      const q = shapeQueue({ proofs, claimed, decided });
      expect(q.decided[1].claimedAmount).toBeNull();
    });
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
