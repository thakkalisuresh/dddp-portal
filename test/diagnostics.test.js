import { describe, it, expect } from 'vitest';
import {
  checkMobiles, checkEmails, checkSuperadmin, checkBills, checkPeriods,
  checkOwnership, checkIntegrity, checkConfig, runChecks, summarise,
  toMarkdown, maskMobile, maskEmail,
} from '../functions/lib/diagnostics.js';

const owner = (o) => ({ id: 1, flat: '4A', name: 'A', mobile: '+919567791515',
                        email: null, role: 'owner', active: 1, ...o });
const bill = (b) => ({ id: 1, flat: '4A', period: '2026-06', owner_id: 1,
                       gas_amount: 328.5, other_charges: 0, additional_charges: 0,
                       late_fee: 0, total: 329, manual_total: 0, ...b });

/**
 * Each check is fed the exact bug it was written for. A check that cannot be
 * shown to fire is decoration — that is the whole lesson of this session.
 */
describe('the checks catch the bugs that actually happened', () => {
  it('catches a mobile that is not E.164 — the account that could never log in', () => {
    const f = checkMobiles([owner({ mobile: '9847011224' })]);
    expect(f.map((x) => x.id)).toContain('MOBILE-FORMAT');
    expect(f[0].severity).toBe('fail');
  });

  it('catches one number on two accounts across BOTH spellings', () => {
    // The live bug: '9567791515' and '+919567791515' are different strings, so
    // neither the UNIQUE index nor a naive comparison saw the collision.
    const f = checkMobiles([
      owner({ id: 1, flat: '4A', mobile: '+919567791515' }),
      owner({ id: 2, flat: '5A', mobile: '9567791515' }),
    ]);
    expect(f.map((x) => x.id)).toContain('MOBILE-DUPLICATE');
  });

  it('is quiet when every number is distinct and normalised', () => {
    expect(checkMobiles([
      owner({ id: 1, mobile: '+919567791515' }),
      owner({ id: 2, mobile: '+919846466511' }),
      owner({ id: 3, mobile: '+971501234567' }),
    ])).toEqual([]);
  });

  it('catches a bill that no longer adds up', () => {
    const f = checkBills([bill({ total: 200 })]);
    expect(f.map((x) => x.id)).toContain('BILL-MISMATCH');
    expect(f.find((x) => x.id === 'BILL-MISMATCH').rows[0])
      .toMatchObject({ total: 200, components: 329 });
  });

  it('does NOT flag an acknowledged override as corruption', () => {
    // Otherwise every goodwill adjustment reads as data loss and the real
    // signal is buried.
    const f = checkBills([bill({ total: 200, manual_total: 1, adjust_reason: 'AGM' })]);
    expect(f.map((x) => x.id)).not.toContain('BILL-MISMATCH');
    expect(f.map((x) => x.id)).toContain('BILL-OVERRIDE');
    expect(f.find((x) => x.id === 'BILL-OVERRIDE').severity).toBe('info');
  });

  it('catches a missing conversion factor — the 2.6x under-billing', () => {
    const f = checkPeriods([{ period: '2026-06', rate_per_kg: 75, conversion_factor: null }]);
    expect(f.map((x) => x.id)).toContain('PERIOD-NO-CONVERSION');
    expect(f.find((x) => x.id === 'PERIOD-NO-CONVERSION').severity).toBe('fail');
  });

  it('catches zero superadmins and more than one', () => {
    expect(checkSuperadmin([owner({ role: 'owner' })])[0].id).toBe('SUPERADMIN-NONE');
    expect(checkSuperadmin([
      owner({ id: 1, role: 'superadmin' }), owner({ id: 2, role: 'superadmin' }),
    ])[0].id).toBe('SUPERADMIN-MANY');
    expect(checkSuperadmin([owner({ role: 'superadmin' }), owner({ id: 2 })])).toEqual([]);
  });

  it('ignores a deactivated superadmin when counting', () => {
    const f = checkSuperadmin([
      owner({ id: 1, role: 'superadmin', active: 1 }),
      owner({ id: 2, role: 'superadmin', active: 0 }),
    ]);
    expect(f).toEqual([]);
  });

  it('catches a shared email, which would send two accounts one OTP', () => {
    expect(checkEmails([
      owner({ id: 1, email: 'a@b.com' }), owner({ id: 2, email: 'A@B.com' }),
    ])[0].id).toBe('EMAIL-DUPLICATE');
  });

  it('catches a meter that ran backwards', () => {
    const f = checkIntegrity({ owners: [], flats: [], readings: [
      { flat: '4A', period: '2026-05', reading: 100 },
      { flat: '4A', period: '2026-06', reading: 90 },
    ]});
    expect(f.map((x) => x.id)).toContain('READING-BACKWARDS');
  });

  it('does not confuse two flats for a backwards meter', () => {
    const f = checkIntegrity({ owners: [], flats: [], readings: [
      { flat: '4A', period: '2026-06', reading: 100 },
      { flat: '4B', period: '2026-06', reading: 10 },
    ]});
    expect(f).toEqual([]);
  });

  it('catches a resident whose flat is not on the register', () => {
    const f = checkIntegrity({ owners: [owner({ flat: '99Z' })], flats: [{ flat: '4A' }], readings: [] });
    expect(f.map((x) => x.id)).toContain('OWNER-NO-FLAT');
  });

  it('catches bills and proofs with no person attached', () => {
    const f = checkOwnership([bill({ owner_id: null })], [{ id: 1, bill_id: 1, owner_id: null }]);
    expect(f.map((x) => x.id)).toEqual(['BILL-NO-OWNER', 'PROOF-NO-OWNER']);
  });

  it('treats a missing UPI payee as fatal in production and minor locally', () => {
    expect(checkConfig({ upiVpa: '', remote: true })[0].severity).toBe('fail');
    expect(checkConfig({ upiVpa: '', remote: false })[0].severity).toBe('warn');
  });
});

/* ── the report is safe to paste ─────────────────────────────────────────── */

describe('redaction', () => {
  it('masks a mobile to something recognisable but not usable', () => {
    const masked = maskMobile('+919567791515');
    expect(masked).not.toContain('9567791515');
    expect(masked.startsWith('+9195')).toBe(true);
    expect(masked.endsWith('515')).toBe(true);
  });

  it('masks an email but keeps the domain', () => {
    expect(maskEmail('sabarish@example.com')).toBe('sa***@example.com');
    expect(maskEmail(null)).toBe(null);
  });

  it('never puts a full number in the report', () => {
    const md = toMarkdown({
      findings: runChecks({ owners: [owner({ mobile: '9567791515' })] }),
      meta: { environment: 'test' },
    });
    expect(md).not.toContain('9567791515');
  });

  it('never leaks a hash or token even if one is handed to it', () => {
    // The report is written to be pasted into a chat window, so the guarantee
    // has to hold against careless callers, not just careful ones.
    const md = toMarkdown({
      findings: runChecks({
        owners: [owner({ mobile: '9847011224', pw_hash: 'SECRETHASH', pw_salt: 'SECRETSALT' })],
      }),
      meta: { environment: 'test' },
    });
    expect(md).not.toContain('SECRETHASH');
    expect(md).not.toContain('SECRETSALT');
  });
});

describe('the report itself', () => {
  it('says so plainly when nothing is wrong', () => {
    const md = toMarkdown({ findings: [], meta: { environment: 'production' } });
    expect(md).toContain('Every check passed');
  });

  it('orders failures above warnings above notes', () => {
    const findings = runChecks({
      owners: [owner({ mobile: 'bare' })],                       // fail
      bills: [bill({ total: 200, manual_total: 1 })],            // info
      proofs: [{ id: 1, bill_id: 1, owner_id: null }],           // warn
    });
    expect(findings.map((f) => f.severity)).toEqual([...findings.map((f) => f.severity)].sort(
      (a, b) => ['fail', 'warn', 'info'].indexOf(a) - ['fail', 'warn', 'info'].indexOf(b)));
    expect(findings[0].severity).toBe('fail');
  });

  it('caps long tables so the report stays pasteable', () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      owner({ id: i, flat: `F${i}`, mobile: `98470112${String(i).padStart(2, '0')}` }));
    const md = toMarkdown({ findings: checkMobiles(many), meta: {} });
    expect(md).toMatch(/…20 more/);
  });

  it('summarises healthy as healthy only when nothing fails or warns', () => {
    expect(summarise([{ severity: 'info' }]).healthy).toBe(true);
    expect(summarise([{ severity: 'warn' }]).healthy).toBe(false);
  });
});
