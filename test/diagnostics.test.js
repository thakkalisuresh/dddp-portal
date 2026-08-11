import { describe, it, expect } from 'vitest';
import {
  checkMobiles, checkEmails, checkSuperadmin, checkBills, checkPeriods,
  checkOwnership, checkIntegrity, checkConfig, runChecks, summarise,
  toMarkdown, maskMobile, maskEmail, checkDigest, checkBackup, checkResetPath, checkTenancy,
  checkExemptions, checkDemoData,
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

describe('the digest is itself checked', () => {
  // The digest is silent when nothing happened, so "no message arrived" and
  // "the digest died three weeks ago" look identical from a phone. Only the
  // watermark can tell them apart.
  const now = new Date('2026-08-09T03:00:00Z');

  it('warns when the watermark has not moved in over 48 hours', () => {
    const f = checkDigest({ lastDigestAt: '2026-08-05T03:00:00Z', remote: true, now });
    expect(f[0].id).toBe('DIGEST-STALE');
    expect(f[0].rows[0].hoursAgo).toBe(96);
  });

  it('is quiet after a normal nightly run', () => {
    expect(checkDigest({ lastDigestAt: '2026-08-08T03:00:00Z', remote: true, now })).toEqual([]);
  });

  it('says so plainly before the first run, rather than warning', () => {
    expect(checkDigest({ lastDigestAt: null, remote: true, now })[0].severity).toBe('info');
  });

  it('stays out of the way locally', () => {
    expect(checkDigest({ lastDigestAt: null, remote: false, now })).toEqual([]);
  });
});

describe('the backup is itself checked', () => {
  // B12: written in phase 8, deployed, and never run once. Nothing said so,
  // because a backup that has never happened and a backup that stopped both
  // look like an empty folder nobody opens.
  const now = new Date('2026-08-09T03:00:00Z');

  it('says plainly that nothing is leaving the building', () => {
    const f = checkBackup({ driveConfigured: false, remote: true, now });
    expect(f[0].id).toBe('BACKUP-NOT-CONFIGURED');
    expect(f[0].severity).toBe('warn');
  });

  it('warns when the watermark has not moved in over 48 hours', () => {
    // The documented failure: a refresh token issued in OAuth "Testing" mode
    // expires after seven days and the upload then fails silently.
    const f = checkBackup({
      lastBackupAt: '2026-08-05T03:00:00Z', driveConfigured: true, remote: true, now });
    expect(f[0].id).toBe('BACKUP-STALE');
    expect(f[0].rows[0].hoursAgo).toBe(96);
  });

  it('is quiet after a normal nightly run', () => {
    expect(checkBackup({
      lastBackupAt: '2026-08-08T03:00:00Z', driveConfigured: true, remote: true, now })).toEqual([]);
  });

  it('says so plainly before the first run, rather than warning', () => {
    const f = checkBackup({ lastBackupAt: null, driveConfigured: true, remote: true, now });
    expect(f[0].id).toBe('BACKUP-NEVER');
    expect(f[0].severity).toBe('info');
  });

  it('stays out of the way locally — a laptop has no off-site folder', () => {
    expect(checkBackup({ driveConfigured: false, remote: false, now })).toEqual([]);
  });

  // Two Workers over one database. Secrets set on Pages do not reach the cron
  // Worker, and it is the cron Worker that runs the upload — so this state
  // looks healthy from inside the site while nothing is being written at all.
  it('names the half that matters when only Pages has the secrets', () => {
    const f = checkBackup({
      driveConfigured: { cron: false, pages: true }, remote: true, now });
    expect(f[0].id).toBe('BACKUP-CRON-UNCONFIGURED');
    expect(f[0].severity).toBe('warn');
  });

  it('does not call it unconfigured when one of the two deployments has it', () => {
    const ids = checkBackup({
      driveConfigured: { cron: false, pages: true }, remote: true, now }).map((x) => x.id);
    expect(ids).not.toContain('BACKUP-NOT-CONFIGURED');
  });

  it('still reports nothing at all when neither deployment has the secrets', () => {
    const f = checkBackup({
      driveConfigured: { cron: false, pages: false }, remote: true, now });
    expect(f[0].id).toBe('BACKUP-NOT-CONFIGURED');
  });

  it('says the report is blind, not the backup broken, when only the cron has it', () => {
    const f = checkBackup({
      lastBackupAt: '2026-08-08T03:00:00Z',
      driveConfigured: { cron: true, pages: false }, remote: true, now });
    expect(f[0].id).toBe('BACKUP-PAGES-UNCONFIGURED');
    expect(f[0].severity).toBe('info');
  });

  // The blind-report note must not swallow the question it sits next to: a
  // backup that stopped three days ago is still the more urgent fact.
  it('reports staleness even while the Export tab cannot see the backup', () => {
    const ids = checkBackup({
      lastBackupAt: '2026-08-05T03:00:00Z',
      driveConfigured: { cron: true, pages: false }, remote: true, now }).map((x) => x.id);
    expect(ids).toEqual(['BACKUP-PAGES-UNCONFIGURED', 'BACKUP-STALE']);
  });

  it('accepts the boolean god mode sends, which sees only its own bindings', () => {
    expect(checkBackup({
      lastBackupAt: '2026-08-08T03:00:00Z', driveConfigured: true, remote: true, now })).toEqual([]);
    expect(checkBackup({ driveConfigured: false, remote: true, now })[0].id)
      .toBe('BACKUP-NOT-CONFIGURED');
  });
});

describe('an unreadable table is not an empty one', () => {
  // This was a live false positive: one transient failure reading `owners`
  // made the report say "no active superadmin — god mode is unreachable"
  // against a database whose superadmin was perfectly fine. A health tool
  // that cries wolf on a network blip teaches people to ignore it.
  it('does not claim there is no superadmin when owners could not be read', () => {
    const f = runChecks({ owners: [], unavailable: ['owners'] });
    expect(f.map((x) => x.id)).not.toContain('SUPERADMIN-NONE');
    expect(f.map((x) => x.id)).toContain('DATA-UNREADABLE');
  });

  it('still reports SUPERADMIN-NONE when owners genuinely IS empty', () => {
    // The guard must not become a way to hide the real condition.
    expect(runChecks({ owners: [] }).map((x) => x.id)).toContain('SUPERADMIN-NONE');
  });

  it('names what it skipped, so "clean" cannot be misread', () => {
    const f = runChecks({ unavailable: ['owners', 'bills'] });
    const d = f.find((x) => x.id === 'DATA-UNREADABLE');
    expect(d.rows.map((r) => r.table)).toEqual(['owners', 'bills']);
    expect(d.detail).toMatch(/skipped, not passed/i);
  });

  it('keeps checking whatever it COULD read', () => {
    const f = runChecks({
      unavailable: ['owners'],
      periods: [{ period: '2026-06', rate_per_kg: 75, conversion_factor: null }],
    });
    expect(f.map((x) => x.id)).toContain('PERIOD-NO-CONVERSION');
  });
});

describe('alerting is configured on both deployments, or neither works properly', () => {
  it('says nothing when both have it', () => {
    expect(checkConfig({ upiVpa: 'x', alerting: { cron: true, pages: true }, remote: true }))
      .toEqual([]);
  });

  it('reports the whole thing missing as one finding, not two', () => {
    const f = checkConfig({ upiVpa: 'x', alerting: { cron: false, pages: false }, remote: true });
    expect(f.map((x) => x.id)).toEqual(['CONFIG-NO-ALERTS']);
  });

  it('names which half is missing — the two-Workers trap', () => {
    // Secrets on one deployment do not reach the other, and the half that
    // works hides the half that does not.
    const noCron = checkConfig({ upiVpa: 'x', alerting: { cron: false, pages: true }, remote: true });
    expect(noCron[0].id).toBe('CONFIG-HALF-ALERTS');
    expect(noCron[0].detail).toMatch(/digest will not/i);

    const noPages = checkConfig({ upiVpa: 'x', alerting: { cron: true, pages: false }, remote: true });
    expect(noPages[0].detail).toMatch(/instant alerts.*will not/i);
  });

  it('still accepts the single boolean the god endpoint can supply', () => {
    // That endpoint can only see its own bindings, not the other deployment's.
    expect(checkConfig({ upiVpa: 'x', alertingConfigured: true, remote: true })).toEqual([]);
    expect(checkConfig({ upiVpa: 'x', alertingConfigured: false, remote: true })[0].id)
      .toBe('CONFIG-NO-ALERTS');
  });
});

describe('who can actually reset their own password', () => {
  const o = (flat, email, active = 1) => ({ flat, name: flat, email, active });

  it('warns when the mail path is unconfigured — nobody can self-serve', () => {
    const f = checkResetPath({ mailConfigured: false, remote: true }, []);
    expect(f[0].id).toBe('MAIL-NOT-CONFIGURED');
  });

  it('names the residents with no email, since they are invisible until locked out', () => {
    const f = checkResetPath({ mailConfigured: true, remote: true },
      [o('4A', 'a@b.com'), o('4B', null), o('5A', '')]);
    const e = f.find((x) => x.id === 'NO-EMAIL-ON-FILE');
    expect(e.title).toMatch(/2 of 3/);
    expect(e.rows.map((r) => r.flat)).toEqual(['4B', '5A']);
  });

  it('ignores inactive accounts — they cannot log in anyway', () => {
    const f = checkResetPath({ mailConfigured: true, remote: true },
      [o('4A', 'a@b.com'), o('9Z', null, 0)]);
    expect(f).toEqual([]);
  });

  it('stays quiet locally about mail', () => {
    expect(checkResetPath({ mailConfigured: false, remote: false }, []).map((x) => x.id))
      .not.toContain('MAIL-NOT-CONFIGURED');
  });
});

describe('tenancy gaps that are invisible until money is owed', () => {
  const p = (flat, relationship, name, active = 1) => ({ flat, relationship, name, active });

  it('catches a let flat with nobody liable', () => {
    // The tenant is billed, but if they leave owing, the liability rule has
    // nothing to point at.
    const f = checkTenancy([p('4B', 'tenant', 'Priya')]);
    expect(f[0].id).toBe('TENANT-NO-OWNER');
    expect(f[0].rows[0]).toMatchObject({ flat: '4B', tenant: 'Priya' });
  });

  it('is quiet when the owner is on record', () => {
    expect(checkTenancy([p('4B', 'owner', 'Nair'), p('4B', 'tenant', 'Priya')])).toEqual([]);
  });

  it('catches two active tenants on one meter', () => {
    const f = checkTenancy([p('4B', 'owner', 'N'), p('4B', 'tenant', 'A'), p('4B', 'tenant', 'B')]);
    expect(f.map((x) => x.id)).toContain('TWO-TENANTS');
  });

  it('ignores a tenant who has moved out', () => {
    expect(checkTenancy([
      p('4B', 'owner', 'N'), p('4B', 'tenant', 'A'), p('4B', 'tenant', 'B', 0),
    ])).toEqual([]);
  });

  it('notes joint owners without calling them wrong', () => {
    const f = checkTenancy([p('4B', 'owner', 'A'), p('4B', 'owner', 'B')]);
    expect(f[0].id).toBe('TWO-OWNERS');
    expect(f[0].severity).toBe('info');
  });
});

describe('late fee exemptions are visible while they run', () => {
  const o = (flat, until, reason = 'AGM', active = 1) =>
    ({ flat, name: flat, active, late_fee_exempt_until: until, late_fee_exempt_reason: reason });

  it('lists an exemption that is still running', () => {
    const f = checkExemptions([o('4B', '2026-11-30')], '2026-08-09');
    expect(f[0].id).toBe('LATE-FEE-EXEMPT');
    expect(f[0].rows[0]).toMatchObject({ flat: '4B', until: '2026-11-30', reason: 'AGM' });
  });

  it('says nothing once it has expired — the date did its job', () => {
    expect(checkExemptions([o('4B', '2026-07-01')], '2026-08-09')).toEqual([]);
  });

  it('ignores people who have left', () => {
    expect(checkExemptions([o('4B', '2026-11-30', 'AGM', 0)], '2026-08-09')).toEqual([]);
  });

  it('is quiet when nobody is exempt', () => {
    expect(checkExemptions([{ flat: '4A', active: 1 }], '2026-08-09')).toEqual([]);
  });
});

describe('demo data announces itself', () => {
  // In the doctor rather than only in a document, because a document goes
  // stale the day the data is removed and a stale warning trains people to
  // ignore the next one.
  const demo = (flat) => ({ flat, name: `Someone [demo]`, active: 1 });

  it('reports generated residents', () => {
    const f = checkDemoData([demo('4A'), demo('4B'), { flat: '5A', name: 'Real Person' }], null);
    expect(f[0].id).toBe('DEMO-DATA-PRESENT');
    expect(f[0].rows[0]).toMatchObject({ residents: 2, flats: 2 });
  });

  it('says nothing once the demo is gone', () => {
    expect(checkDemoData([{ flat: '4A', name: 'Real Person' }], null)).toEqual([]);
  });

  it('still speaks up if only the marker survives a failed removal', () => {
    expect(checkDemoData([], '{"owners":[1,2]}')[0].id).toBe('DEMO-DATA-PRESENT');
  });
});
