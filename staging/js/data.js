/**
 * Mock data for the staging prototype.
 *
 * Shaped to match what /api/me and the admin endpoints actually return, so a
 * screen built here can be pointed at the real API by swapping this module out
 * rather than by being rewritten. Names and flats are invented; the building's
 * shape (99 flats, A–E on each floor, ~94 billed) is real.
 */

export const RATE = 92;

/* ── the four people you can be ────────────────────────────────────────── */

export const PERSONAS = {
  due: {
    id: 'p-due', role: 'resident', name: 'Rajan Menon', flat: '7B', floor: 7,
    mobile: '+91 98470 21188', email: 'rajan.menon@gmail.com',
    tenancy: { role: 'owner', description: 'You own and live in 7B' },
    label: 'Resident · bill due',
    blurb: 'The ordinary month. A bill is out, nothing is paid yet.',
  },
  overdue: {
    id: 'p-late', role: 'resident', name: 'Susan Thomas', flat: '11C', floor: 11,
    mobile: '+91 94950 33127', email: 'susanthomas11c@gmail.com',
    tenancy: { role: 'owner', description: 'You own and live in 11C' },
    label: 'Resident · overdue',
    blurb: 'Past the 20th. A late fee has landed and the screen has to say why.',
  },
  paid: {
    id: 'p-paid', role: 'resident', name: 'Ashraf Kunju', flat: '3D', floor: 3,
    mobile: '+971 50 442 8810', email: 'ashraf.k@outlook.com',
    tenancy: { role: 'owner', description: 'You own and live in 3D' },
    label: 'Resident · settled',
    blurb: 'Paid and verified. Every pay control is gone, not greyed out.',
  },
  landlord: {
    id: 'p-owner', role: 'resident', name: 'K. P. Varghese', flat: '9A', floor: 9,
    mobile: '+91 90370 66421', email: 'kpvarghese@yahoo.co.in',
    tenancy: { role: 'landlord', occupantName: 'Nikhil Menon', description: 'You own 9A. Nikhil Menon rents it.' },
    label: 'Owner · tenant pays',
    blurb: 'Reading someone else’s bill. The screen must not look like a demand.',
  },
  admin: {
    id: 'p-adm', role: 'admin', name: 'Sabarish Suresh', flat: '4A', floor: 4,
    mobile: '+91 98950 11002', email: 'treasurer@dddp.online',
    tenancy: { role: 'owner', description: 'You own and live in 4A' },
    label: 'Treasurer',
    blurb: 'The committee side: the month, the queue, the building.',
  },
};

/* ── the bill on the front screen ──────────────────────────────────────── */

const BILLS = {
  due: {
    id: 'b1', period: '2026-08', status: 'due', displayStatus: 'due', settled: false,
    consumption: 13.4, ratePerKg: RATE, gasAmount: 1233, otherCharges: 40,
    additionalCharges: 0, lateFee: 0, total: 1273,
    dueDate: '2026-09-20', showPayButton: true,
    lateFeeWarning: { amount: 50, after: '2026-09-20' },
  },
  overdue: {
    id: 'b2', period: '2026-08', status: 'overdue', displayStatus: 'overdue', settled: false,
    consumption: 18.9, ratePerKg: RATE, gasAmount: 1739, otherCharges: 40,
    additionalCharges: 0, lateFee: 50, total: 1829,
    dueDate: '2026-08-20', lateFeeAt: '2026-08-20', showPayButton: true,
  },
  paid: {
    id: 'b3', period: '2026-08', status: 'paid', displayStatus: 'paid', settled: true,
    consumption: 9.2, ratePerKg: RATE, gasAmount: 846, otherCharges: 40,
    additionalCharges: 0, lateFee: 0, total: 886,
    dueDate: '2026-09-20', paidAt: '2026-09-02', showPayButton: false,
  },
  landlord: {
    id: 'b4', period: '2026-08', status: 'awaiting', displayStatus: 'awaiting', settled: false,
    consumption: 15.1, ratePerKg: RATE, gasAmount: 1389, otherCharges: 40,
    additionalCharges: 0, lateFee: 0, total: 1429,
    dueDate: '2026-09-20', showPayButton: false,
  },
  admin: {
    id: 'b5', period: '2026-08', status: 'due', displayStatus: 'due', settled: false,
    consumption: 11.8, ratePerKg: RATE, gasAmount: 1086, otherCharges: 40,
    additionalCharges: 0, lateFee: 0, total: 1126,
    dueDate: '2026-09-20', showPayButton: true,
    lateFeeWarning: { amount: 50, after: '2026-09-20' },
  },
};

/* Twelve months of meter walks. `readOn` is the day the meter was actually
   read, which is always in the month AFTER the one being billed — the single
   most-asked question the old portal never answered on screen. */
const USE = {
  due:      [10.2, 11.8, 9.4, 8.1, 7.6, 8.9, 12.1, 14.6, 15.2, 12.7, 11.3, 13.4],
  overdue:  [15.1, 16.8, 14.2, 12.9, 11.4, 13.8, 17.2, 19.6, 20.1, 17.4, 16.2, 18.9],
  paid:     [7.8, 8.4, 6.9, 6.2, 5.8, 6.4, 8.8, 10.1, 10.6, 9.4, 8.2, 9.2],
  landlord: [12.4, 13.9, 11.2, 10.4, 9.8, 11.1, 14.2, 16.4, 17.1, 14.8, 13.2, 15.1],
  admin:    [9.1, 10.4, 8.6, 7.9, 7.2, 8.4, 11.2, 13.1, 13.8, 11.9, 10.4, 11.8],
};

const PERIODS = ['2025-09', '2025-10', '2025-11', '2025-12', '2026-01', '2026-02',
  '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08'];

function historyFor(key) {
  const use = USE[key];
  let meter = 214.5;
  const readings = [];
  const bills = [];
  use.forEach((c, i) => {
    meter += c;
    const period = PERIODS[i];
    const [y, m] = period.split('-').map(Number);
    const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
    readings.push({
      period, reading: Number(meter.toFixed(3)), consumption: c,
      readOn: `${next}-04`,
      // 11C's meter was swapped in March; the reading column drops by 200 and
      // the row has to say so or it reads as a fault in the portal.
      meterChangedOn: key === 'overdue' && period === '2026-03' ? '2026-04-04' : null,
    });
    const rate = i < 6 ? 88 : RATE;
    const total = Math.round(c * rate) + 40;
    bills.push({
      id: `h${i}`, period, consumption: c, rate_per_kg: rate, total,
      status: i === use.length - 1
        ? { due: 'due', overdue: 'overdue', paid: 'paid', landlord: 'awaiting', admin: 'due' }[key]
        : 'paid',
    });
  });
  if (key === 'overdue') readings[6].reading = Number((readings[6].reading - 200).toFixed(3));
  return { readings, bills: bills.reverse() };
}

export function me(key) {
  const p = PERSONAS[key];
  const { readings, bills } = historyFor(key);
  return {
    ...p,
    bill: BILLS[key],
    readings,
    bills,
    unreadNotices: key === 'paid' ? 0 : 2,
    pay: {
      target: 'android',
      manual: { vpa: 'dddparwa@okhdfcbank', amount: BILLS[key].total, note: `GAS ${p.flat}` },
    },
    support: { name: 'Sabarish', flat: '4A', wa: '919895011002', shown: 'evenings' },
  };
}

/* ── notices ───────────────────────────────────────────────────────────── */

export const NOTICES = [
  {
    id: 'n1', kind: 'notice', title: 'Water tank cleaning — Tuesday 9 September',
    postedAt: '2026-09-05', by: 'Committee', unread: true, pinned: true,
    body: 'Both overhead tanks will be drained and cleaned on Tuesday 9 September.\n\nSupply will be off from 9:00 am to about 3:00 pm. Please fill what you need on Monday night.\n\nThe pump room will be locked while the work is on. If you need water urgently during the day, the borewell tap near the gate stays open.',
    comments: [
      { by: 'Susan Thomas', flat: '11C', at: '2026-09-05', text: 'Will the lift be affected as well?' },
      { by: 'Committee', flat: null, at: '2026-09-05', text: 'No — only the water supply. Lifts run as usual.', official: true },
    ],
    commentsOpen: true,
  },
  {
    id: 'n2', kind: 'event', title: 'Onam celebration — 14 September, 5 pm',
    postedAt: '2026-09-02', by: 'Cultural sub-committee', unread: true,
    body: 'Pookkalam from 8 am in the portico, sadhya at 12:30, and games for the children from 5 pm in the play area.\n\nRegistration for the sadhya closes on 10 September. ₹250 a head, children under six free. Message Latha (6C) to add your family.',
    comments: [], commentsOpen: true,
  },
  {
    id: 'n3', kind: 'notice', title: 'Gas rate revised to ₹92 per kg from March',
    postedAt: '2026-03-01', by: 'Treasurer', unread: false,
    body: 'The bulk supplier has raised the rate. From the March bill the rate is ₹92 per kg, up from ₹88.\n\nBills already issued keep the rate they were issued at, so nothing before March changes.',
    comments: [], commentsOpen: false,
  },
  {
    id: 'n4', kind: 'notice', title: 'Annual general meeting — minutes',
    postedAt: '2026-02-16', by: 'Secretary', unread: false,
    body: 'The minutes of the AGM held on 9 February are attached. Corrections to the secretary within two weeks.',
    attachments: [{ name: 'AGM-minutes-2026.pdf', size: '240 KB' }],
    comments: [], commentsOpen: false,
  },
];

/* ── the treasurer's month ─────────────────────────────────────────────── */

const FLATS = [];
for (let floor = 1; floor <= 20; floor++) {
  for (const letter of ['A', 'B', 'C', 'D', 'E']) FLATS.push(`${floor}${letter}`);
}
export const ALL_FLATS = FLATS.slice(0, 99);

const NAMES = ['Rajan Menon', 'Susan Thomas', 'Ashraf Kunju', 'K. P. Varghese', 'Latha Nair',
  'Joseph Chacko', 'Meera Pillai', 'Anil Kumar', 'Fathima Beevi', 'George Mathew',
  'Sreelatha Devi', 'Vinod Raghavan', 'Bindu Krishnan', 'Thomas Zachariah', 'Radha Menon',
  'Suresh Babu', 'Elizabeth John', 'Mohammed Rafi', 'Girija Warrier', 'Prakash Nambiar'];

/** The meter walk — 94 rows, some entered, most not. */
export function readingGrid() {
  return ALL_FLATS.slice(0, 94).map((flat, i) => {
    const prev = 180 + ((i * 37) % 220) + i * 0.4;
    // The first 61 are already keyed in; the rest are the walk still to do.
    const entered = i < 61;
    const used = 6 + ((i * 13) % 15) + (i % 4) * 0.3;
    return {
      flat,
      name: NAMES[i % NAMES.length],
      prev: Number(prev.toFixed(3)),
      reading: entered ? Number((prev + used).toFixed(3)) : null,
      consumption: entered ? Number(used.toFixed(2)) : null,
      // Two rows that need a second look, which is the whole point of the screen.
      flag: i === 12 ? 'high' : i === 44 ? 'lower' : null,
      usual: Number((used * 0.55).toFixed(2)),
    };
  });
}

export const MONTH = {
  period: '2026-09',
  rate: RATE,
  otherCharges: 40,
  entered: 61,
  total: 94,
  published: false,
  dueDate: '2026-10-20',
};

/* ── the proof queue ───────────────────────────────────────────────────── */

export const PROOFS = [
  { id: 'pr1', flat: '7B', name: 'Rajan Menon', amount: 1273, expected: 1273, at: '2026-09-06',
    ref: 'UPI/628401993312', app: 'Google Pay', match: 'exact' },
  { id: 'pr2', flat: '2C', name: 'Latha Nair', amount: 1041, expected: 1041, at: '2026-09-06',
    ref: 'UPI/628399120044', app: 'PhonePe', match: 'exact' },
  { id: 'pr3', flat: '15D', name: 'Anil Kumar', amount: 1210, expected: 1041, at: '2026-09-05',
    ref: 'UPI/628377554120', app: 'Paytm', match: 'over',
    note: 'Paid ₹169 more than the bill. Ask whether it is meant for next month.' },
  { id: 'pr4', flat: '11C', name: 'Susan Thomas', amount: 1779, expected: 1829, at: '2026-09-05',
    ref: 'UPI/628366120991', app: 'Google Pay', match: 'short',
    note: 'Short by exactly the ₹50 late fee. Probably paid from an old screenshot.' },
  { id: 'pr5', flat: '6A', name: 'Joseph Chacko', amount: 968, expected: 968, at: '2026-09-04',
    ref: 'UPI/628340012765', app: 'Google Pay', match: 'exact' },
];

export const CLAIMED_NO_PROOF = [
  { flat: '13E', name: 'Meera Pillai', amount: 1394, tappedAt: '2026-09-04' },
  { flat: '8B', name: 'Vinod Raghavan', amount: 1102, tappedAt: '2026-09-03' },
];

/* ── the bank statement ────────────────────────────────────────────────── */

export const STATEMENT = [
  { id: 's1', date: '2026-09-06', ref: 'UPI/628401993312', amount: 1273, matched: '7B' },
  { id: 's2', date: '2026-09-06', ref: 'UPI/628399120044', amount: 1041, matched: '2C' },
  { id: 's3', date: '2026-09-05', ref: 'UPI/628377554120', amount: 1210, matched: '15D' },
  { id: 's4', date: '2026-09-04', ref: 'UPI/628340012765', amount: 968, matched: '6A' },
  { id: 's5', date: '2026-09-04', ref: 'IMPS/9920184471', amount: 1394, matched: null,
    hint: 'Amount matches 13E, who tapped Pay on 4 September but sent no screenshot.' },
  { id: 's6', date: '2026-09-03', ref: 'NEFT/DIAMONDPARK/AC', amount: 25000, matched: null,
    hint: 'Not a gas payment — this is the maintenance account transfer.' },
];

/* ── the building ──────────────────────────────────────────────────────── */

export const RESIDENTS = ALL_FLATS.slice(0, 40).map((flat, i) => {
  const tenanted = i % 7 === 3;
  return {
    flat,
    floor: parseInt(flat, 10),
    billed: i % 19 !== 17,
    people: tenanted
      ? [
          { name: NAMES[(i + 3) % NAMES.length], role: 'owner', mobile: `+91 9${(847000000 + i * 137).toString().slice(0, 9)}`, liable: true, loggedIn: i % 3 !== 0 },
          { name: NAMES[(i + 9) % NAMES.length], role: 'tenant', mobile: `+91 9${(495000000 + i * 211).toString().slice(0, 9)}`, pays: true, loggedIn: i % 2 === 0 },
        ]
      : [{ name: NAMES[i % NAMES.length], role: 'owner', mobile: `+91 9${(847000000 + i * 379).toString().slice(0, 9)}`, liable: true, pays: true, loggedIn: i % 5 !== 4 }],
  };
});

/* ── the admin home board ──────────────────────────────────────────────── */

export const BOARD = {
  period: '2026-09',
  proofs: PROOFS.length,
  claimed: CLAIMED_NO_PROOF.length,
  corrections: 1,
  messages: 2,
  readingsLeft: MONTH.total - MONTH.entered,
  overdue: 6,
  overdueValue: 7840,
  collected: 68240,
  billed: 94,
  paid: 71,
  neverLoggedIn: 9,
};
