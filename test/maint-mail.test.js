import { describe, it, expect } from 'vitest';
import {
  issuedEmail, dueSoonEmail, dueEmail, overdueEmail, letterFor,
  ccFor, permanentFailure, PLACEHOLDER_COPY, MAIL_KINDS, DRAIN_SIZE, MAX_ATTEMPTS,
} from '../functions/lib/maint-mail.js';
import { buildRawMessage } from '../functions/lib/mailer.js';
import {
  maintPayee, maintPayeeMode, maintNote, buildMaintUpiLinks, manualMaintPayment,
} from '../functions/lib/upi.js';
import { checkMaintPayee } from '../functions/lib/diagnostics.js';

const bill = (over = {}) => ({
  flat: '2B', quarter: '2026-Q4', total: 9000, dueDate: '2026-10-11', lateFee: 750, ...over,
});

/* ── the letters ─────────────────────────────────────────────────────────── */

describe('the four letters', () => {
  it('names the quarter the way residents see it, never the internal label', () => {
    const m = issuedEmail({ ...bill(), basis: 'owner', rate: 7500 });
    expect(m.subject).toContain('Q4 2026 (Oct–Dec)');
    expect(m.subject).not.toContain('2026-Q4');
    expect(m.text).not.toContain('2026-Q4');
  });

  it('calls it maintenance, not a bill, and says it is not the gas one', () => {
    const m = issuedEmail({ ...bill(), basis: 'owner', rate: 7500 });
    expect(m.text.toLowerCase()).toContain('maintenance');
    expect(m.text).toMatch(/separate from the gas/i);
  });

  it('shows a tenant why they pay more than their neighbour', () => {
    // A tenant billed 9,000 beside an owner billed 7,500 will ask, and the
    // answer belongs on the bill rather than in the committee's inbox.
    const tenant = issuedEmail({ ...bill(), basis: 'tenant', rate: 9000 });
    expect(tenant.text).toMatch(/let flat/i);
    const owner = issuedEmail({ ...bill(), total: 7500, basis: 'owner', rate: 7500 });
    expect(owner.text).toMatch(/owner-occupied/i);
  });

  it('never carries a payment link — only the portal', () => {
    // An unsolicited message asking for money is the shape of a fraud, and
    // upi:// links do not survive Gmail anyway.
    for (const m of [
      issuedEmail({ ...bill(), basis: 'owner', rate: 7500 }),
      dueSoonEmail(bill()), dueEmail(bill()),
      overdueEmail({ ...bill(), blocksVoting: false }),
    ]) {
      expect(m.text).not.toContain('upi://');
      expect(m.html).not.toContain('upi://');
      expect(m.text).toMatch(/ever send you a payment\s+link/i);
    }
  });

  it('points disputes at the committee, never at a person', () => {
    const m = dueEmail(bill());
    expect(m.text).toMatch(/committee/i);
    // No individual is named anywhere, and no reply-to-a-human instruction.
    expect(m.text).not.toMatch(/treasurer[’']s|contact \w+ on/i);
  });

  it('names the fee three days early, while it can still be avoided', () => {
    expect(dueSoonEmail(bill()).text).toContain('750');
  });

  it('says the due date itself is still payable — the rule that differs from gas', () => {
    // Gas is charged ON the due date at midnight. Maintenance leaves the due
    // date payable and charges the morning after. Residents have learned the
    // gas rule, so being vague here would cost somebody ₹750.
    const m = dueEmail(bill());
    expect(m.text).toMatch(/still payable/i);
    expect(m.text).toMatch(/added tomorrow/i);
  });

  it('warns about the vote only once the quarter has actually ended', () => {
    const blocked = overdueEmail({ ...bill(), blocksVoting: true });
    expect(blocked.text).toMatch(/cannot vote/i);
    // And says how to undo it, in the same breath.
    expect(blocked.text).toMatch(/treasurer confirms/i);

    const notYet = overdueEmail({ ...bill(), blocksVoting: false });
    expect(notYet.text).not.toMatch(/cannot vote/i);
  });

  it('decides the voting line from the quarter, not from the bill being unpaid', () => {
    const row = {
      flat: '2B', quarter: '2026-Q4', total: 9750, due_date: '2026-10-11',
      quarter_late_fee: 750, basis: 'owner', rate_applied: 7500,
    };
    // The day after Q4's due date — Q4 is still running, so nothing is blocked.
    expect(letterFor('overdue', row, { today: '2026-10-12' }).text).not.toMatch(/cannot vote/i);
    // The same bill, chased in January. Q4 has ended, so now it blocks.
    expect(letterFor('overdue', row, { today: '2027-01-15' }).text).toMatch(/cannot vote/i);
  });

  it('refuses an unknown kind rather than sending an empty letter', () => {
    expect(() => letterFor('nudge', { flat: '2B', quarter: '2026-Q4' })).toThrow(/unknown/i);
  });

  it('builds both halves of every letter', () => {
    for (const kind of MAIL_KINDS) {
      const m = letterFor(kind, {
        flat: '2B', quarter: '2026-Q4', total: 9000, due_date: '2026-10-11',
        quarter_late_fee: 750, basis: 'tenant', rate_applied: 9000,
      }, { today: '2026-10-12' });
      expect(m.subject, kind).toBeTruthy();
      expect(m.text, kind).toBeTruthy();
      expect(m.html, kind).toBeTruthy();
    }
  });

  it('is still flagged as placeholder copy', () => {
    // Flips to false when the committee has approved the wording. This assertion
    // is the thing that stops "we'll do the wording later" becoming "we shipped
    // the draft".
    expect(PLACEHOLDER_COPY).toBe(true);
  });
});

/* ── who else is told ────────────────────────────────────────────────────── */

describe('the rest of the household is copied', () => {
  const people = [
    { id: 1, relationship: 'owner', active: 1, email: 'owner1@x.com' },
    { id: 2, relationship: 'owner', active: 1, email: 'owner2@x.com' },
    { id: 3, relationship: 'tenant', active: 1, email: 'tenant@x.com' },
  ];

  it('copies every owner when the tenant is billed', () => {
    // All of them are liable and billAccess already shows them all the amount;
    // copying one would be the portal choosing which co-owner gets told.
    expect(ccFor({ people, billedToId: 3 })).toEqual(['owner1@x.com', 'owner2@x.com']);
  });

  it('copies the second tenant too — a household that shares a bill shares the letter', () => {
    const two = [...people, { id: 4, relationship: 'tenant', active: 1, email: 'tenant2@x.com' }];
    expect(ccFor({ people: two, billedToId: 3 })).toContain('tenant2@x.com');
  });

  it('never copies the person it is addressed to', () => {
    expect(ccFor({ people, billedToId: 3 })).not.toContain('tenant@x.com');
    expect(ccFor({ people, billedToId: 1 })).not.toContain('owner1@x.com');
  });

  it('copies nobody on an owner-occupied flat with a single owner', () => {
    expect(ccFor({ people: [people[0]], billedToId: 1 })).toEqual([]);
  });

  it('skips people who have left, and people with no address', () => {
    const mixed = [
      { id: 1, relationship: 'owner', active: 0, email: 'gone@x.com' },
      { id: 2, relationship: 'owner', active: 1, email: null },
      { id: 3, relationship: 'owner', active: 1, email: '   ' },
    ];
    expect(ccFor({ people: mixed, billedToId: 9 })).toEqual([]);
  });

  it('does not copy a shared address twice', () => {
    // A couple on one mailbox must not get two copies of the same letter.
    const couple = [
      { id: 1, relationship: 'owner', active: 1, email: 'both@x.com' },
      { id: 2, relationship: 'owner', active: 1, email: 'BOTH@x.com' },
    ];
    expect(ccFor({ people: couple, billedToId: 9 })).toEqual(['both@x.com']);
  });
});

describe('the mailer carries Cc', () => {
  const decode = (raw) => atob(raw.replace(/-/g, '+').replace(/_/g, '/'));

  it('writes a Cc header when there is somebody to copy', () => {
    const raw = decode(buildRawMessage({
      to: 'a@x.com', from: 'ddp@x.com', subject: 's', text: 't',
      cc: ['b@x.com', 'c@x.com'],
    }));
    expect(raw).toContain('Cc: b@x.com, c@x.com');
  });

  it('omits the header entirely when there is not', () => {
    // An empty `Cc:` renders in some clients as a blank recipient line, which
    // on a bill looks like the association failed to tell somebody.
    for (const cc of [null, [], ['   ']]) {
      expect(decode(buildRawMessage({
        to: 'a@x.com', from: 'ddp@x.com', subject: 's', text: 't', cc,
      }))).not.toContain('Cc:');
    }
  });

  it('refuses a line break in a Cc address, naming it as the cc', () => {
    // The same injection guard as to/from: a line break is how an attacker
    // writes their own Bcc header.
    expect(() => buildRawMessage({
      to: 'a@x.com', from: 'ddp@x.com', subject: 's', text: 't',
      cc: ['ok@x.com', 'b@x.com\r\nBcc: evil@x.test'],
    })).toThrow(/cc address/);
  });

  it('leaves a message with no Cc byte-for-byte as it was', () => {
    // Every existing caller is on this path and must stay on it.
    const before = buildRawMessage({ to: 'a@x.com', from: 'ddp@x.com', subject: 's', text: 't' });
    const after = buildRawMessage({ to: 'a@x.com', from: 'ddp@x.com', subject: 's', text: 't', cc: null });
    expect(after).toBe(before);
  });
});

/* ── the payee ───────────────────────────────────────────────────────────── */

describe('the maintenance payee is configuration, never code', () => {
  const account = {
    MAINT_PAYEE_MODE: 'account', MAINT_PAYEE_NAME: 'Test RWA',
    MAINT_ACCOUNT_NUMBER: '0000000000000000', MAINT_IFSC: 'TEST0000000',
  };
  const upi = { MAINT_PAYEE_MODE: 'upi', MAINT_PAYEE_NAME: 'Test RWA', MAINT_UPI_VPA: 'test@bank' };

  it('assembles the account address at runtime, so neither half is ever stored whole', () => {
    expect(maintPayee(account).vpa).toBe('0000000000000000@TEST0000000.ifsc.npci');
  });

  it('uses the UPI ID when the bank has issued one', () => {
    expect(maintPayee(upi).vpa).toBe('test@bank');
    expect(maintPayee(upi).bankDetails).toBe(null);
  });

  it('shows the bank details beside the address in account mode', () => {
    // PhonePe and Paytm both refuse account-number payments, so a resident
    // needs something to copy into a transfer by hand.
    expect(maintPayee(account).bankDetails).toEqual({
      account: '0000000000000000', ifsc: 'TEST0000000', name: 'Test RWA',
    });
  });

  it('defaults to account mode, since that is the state the bank left us in', () => {
    expect(maintPayeeMode({})).toBe('account');
    expect(maintPayeeMode({ MAINT_PAYEE_MODE: 'nonsense' })).toBe('account');
  });

  it('FAILS CLOSED on a half-configured payee', () => {
    // A Pay button addressed to nobody is worse than a missing one: the
    // resident finds out after they have decided to pay.
    expect(maintPayee({ MAINT_PAYEE_MODE: 'upi', MAINT_PAYEE_NAME: 'x' }).ok).toBe(false);
    expect(maintPayee({ ...account, MAINT_IFSC: '' }).reason).toBe('no-ifsc');
    expect(maintPayee({ ...account, MAINT_ACCOUNT_NUMBER: '' }).reason).toBe('no-account');
    expect(maintPayee({ ...account, MAINT_PAYEE_NAME: '' }).reason).toBe('no-payee-name');
  });

  it('refuses to build links at all rather than addressing them to nobody', () => {
    expect(() => buildMaintUpiLinks({
      env: { MAINT_PAYEE_MODE: 'upi' }, amount: 9000, flat: '2B', quarter: '2026-Q4',
    })).toThrow();
  });

  it('builds the same platform spread gas does', () => {
    const links = buildMaintUpiLinks({ env: account, amount: 9000, flat: '2B', quarter: '2026-Q4' });
    expect(links.generic).toMatch(/^upi:\/\/pay\?/);
    expect(links.intent).toContain('intent://pay?');
    expect(Object.keys(links.androidApps)).toContain('gpay');
    expect(links.gpay).toMatch(/^gpay:\/\/upi\/pay\?/);
  });

  it('carries no tr, exactly as the gas links do not', () => {
    // Without a merchant code, `tr` describes a P2M payment missing half its
    // fields, and PSP apps answer that with a refusal that looks like the app
    // declining to open.
    const links = buildMaintUpiLinks({ env: account, amount: 9000, flat: '2B', quarter: '2026-Q4' });
    expect(links.generic).not.toMatch(/[?&]tr=/);
  });

  it('offers something to type when no link worked', () => {
    const m = manualMaintPayment({ env: account, amount: 9000, flat: '2B', quarter: '2026-Q4' });
    expect(m.ok).toBe(true);
    expect(m.note).toBe('(2B_MAINT_Q4_26)');
    expect(m.bankDetails.ifsc).toBe('TEST0000000');
  });
});

describe('the payment note', () => {
  it('carries the year, because the amounts do not distinguish anything', () => {
    // The whole point. Maintenance is the same rupee for every flat of a kind,
    // so the paise fingerprint gas relies on does not exist and the note is one
    // of only two things reconciliation has.
    expect(maintNote('2B', '2026-Q4')).toBe('(2B_MAINT_Q4_26)');
    expect(maintNote('2B', '2027-Q4')).toBe('(2B_MAINT_Q4_27)');
    expect(maintNote('2B', '2026-Q4')).not.toBe(maintNote('2B', '2027-Q4'));
  });

  it('distinguishes flats and quarters', () => {
    expect(maintNote('12F', '2026-Q1')).toBe('(12F_MAINT_Q1_26)');
    expect(maintNote('2B', '2026-Q1')).not.toBe(maintNote('2B', '2026-Q2'));
  });

  it('is undefined rather than malformed when it cannot be built', () => {
    expect(maintNote('2B', '2026-10')).toBeUndefined();
    expect(maintNote(null, '2026-Q4')).toBeUndefined();
  });
});

describe('the payee diagnostics check', () => {
  it('fails loudly when residents could not pay', () => {
    const out = checkMaintPayee({ MAINT_PAYEE_MODE: 'account' });
    expect(out).toHaveLength(1);
    expect(out[0].severity).toBe('fail');
    expect(out[0].id).toBe('MAINT-PAYEE');
  });

  it('names the settings and never their values', () => {
    // The report is written to be pasted into a chat window.
    const out = checkMaintPayee({ MAINT_PAYEE_MODE: 'account', MAINT_ACCOUNT_NUMBER: '123456' });
    expect(JSON.stringify(out)).not.toContain('123456');
    expect(JSON.stringify(out)).toContain('MAINT_IFSC');
  });

  it('says nothing when the payee is complete', () => {
    expect(checkMaintPayee({
      MAINT_PAYEE_MODE: 'upi', MAINT_UPI_VPA: 'a@b', MAINT_PAYEE_NAME: 'x',
    })).toEqual([]);
  });

  it('notices a UPI ID that has arrived but not been switched on', () => {
    const out = checkMaintPayee({
      MAINT_PAYEE_MODE: 'account', MAINT_PAYEE_NAME: 'x',
      MAINT_ACCOUNT_NUMBER: '1', MAINT_IFSC: 'A', MAINT_UPI_VPA: 'a@b',
    });
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('MAINT-PAYEE-MODE');
    expect(out[0].severity).toBe('info');
  });

  it('reminds that Pages binds secrets at deploy time', () => {
    // Setting a secret and testing immediately reproduces the exact symptom
    // just fixed — this has cost a round of debugging before.
    expect(checkMaintPayee({})[0].detail).toMatch(/redeploy/i);
  });
});

describe('retry policy', () => {
  it('never retries a refusal, and always retries a timeout', () => {
    expect(permanentFailure('gmail-400')).toBe(true);
    expect(permanentFailure('gmail-403')).toBe(true);
    expect(permanentFailure('gmail-429')).toBe(false);
    expect(permanentFailure('gmail-408')).toBe(false);
    expect(permanentFailure('gmail-500')).toBe(false);
    expect(permanentFailure('threw')).toBe(false);
  });

  it('keeps the drain inside the subrequest budget', () => {
    // One send is two outbound fetches; a token minted once makes a batch of N
    // cost N+1. Twenty plus one is 21, against a cap of 50.
    expect(DRAIN_SIZE + 1).toBeLessThan(50);
    expect(MAX_ATTEMPTS).toBe(3);
  });
});
