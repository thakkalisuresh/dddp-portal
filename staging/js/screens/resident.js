/**
 * The resident's five screens: the bill, paying it, proving it, the history,
 * and the notice board.
 *
 * The governing rule is one dominant thing per screen. A resident opens this
 * app to answer one question — "what do I owe and is it settled?" — and every
 * screen either answers that or gets out of the way.
 */

import {
  el, icon, svg, I, money, kg, periodLabel, periodShort, dayLabel, dayFull, ago,
  row, list, group, statusChip, banner, empty, field, kv, sheet, toast, segmented,
} from '../ui.js';
import { me, NOTICES } from '../data.js';

/* ═══ 1 · the bill ═══════════════════════════════════════════════════════ */

export function dashboard(ctx) {
  const m = me(ctx.persona);
  const b = m.bill;
  const landlord = m.tenancy.role === 'landlord';

  return [
    // An owner reading a tenant's bill is told so before they read a number.
    // Without this the screen is indistinguishable from a demand for money
    // they do not owe, which is how the old portal read to two owners abroad.
    landlord ? banner('info',
      el('div', {}, el('strong', {}, `This is ${m.tenancy.occupantName}'s bill.`),
        ` They rent ${m.flat} and they pay it. You are liable only if it goes unpaid.`),
      el('p', { class: 'tiny' }, 'Payment screenshots are not shown to owners.')) : null,

    hero(b, landlord),

    !landlord && b.showPayButton ? payCta(ctx, b) : null,

    b.status === 'awaiting' ? banner('warn',
      el('div', {}, el('strong', {}, 'The treasurer is checking your payment.'),
        ' Nothing more to do — you will see it turn to Paid, usually within a day.')) : null,

    b.settled ? banner('good',
      el('div', {}, el('strong', {}, 'Nothing due.'), ' Your next bill arrives in early October.')) : null,

    breakdown(b),

    group('This month', list(
      row({ title: 'Gas used', value: kg(b.consumption), icon: 'flame', tint: 'var(--warn)' }),
      row({ title: 'Meter read on', value: dayLabel('2026-09-04'), icon: 'meter', tint: 'var(--info)' }),
      row({ title: 'How you compare', sub: 'Building average this month is 12.6 kg',
            value: b.consumption > 12.6 ? 'Above' : 'Below', icon: 'chart', tint: 'var(--accent)',
            onClick: () => ctx.go('#/usage') }),
    ), 'August’s gas is read in early September — that is why the dates do not match.'),

    el('a', { class: 'btn btn--outline btn--block', href: '#', onclick: (e) => { e.preventDefault(); toast('The PDF would download here'); } },
      icon('download', { size: 20 }), 'Download this bill'),
  ];
}

function hero(b, landlord) {
  return el('section', { class: 'card' },
    el('div', { class: 'row row--between' },
      el('span', { class: 'hero__label' }, periodLabel(b.period)),
      statusChip(b.displayStatus)),

    el('div', { class: 'hero' },
      el('p', { class: 'hero__amount' + (b.settled ? ' hero__amount--settled' : '') }, money(b.total)),
      el('p', { class: 'hero__due' },
        b.settled
          ? `Paid ${dayLabel(b.paidAt)}`
          : landlord
            ? ['Due ', el('strong', {}, dayLabel(b.dueDate))]
            // "Due 20 September" was read as "the 20th is fine". It is not:
            // the fee lands at midnight that morning. State the instant it
            // expires, not the day it falls on.
            : ['Pay before ', el('strong', {}, dayLabel(b.dueDate))])),

    b.lateFeeWarning ? el('p', { class: 'small', style: 'color:var(--warn)' },
      `${money(b.lateFeeWarning.amount)} is added if it is unpaid on ${dayLabel(b.lateFeeWarning.after)}.`) : null,

    b.displayStatus === 'overdue' ? banner('bad',
      el('div', {}, el('strong', {}, `Late fee of ${money(b.lateFee)} added on ${dayLabel(b.lateFeeAt)}.`),
        ' It is already included in the amount above.')) : null);
}

function payCta(ctx, b) {
  return el('div', { class: 'stack stack--sm' },
    el('button', { class: 'btn btn--lg btn--block', type: 'button', onclick: () => ctx.go('#/pay') },
      icon('rupee', { size: 20 }), `Pay ${money(b.total)}`),
    el('button', { class: 'btn btn--plain btn--block btn--sm', type: 'button', onclick: () => ctx.go('#/proof') },
      'Already paid? Send the screenshot'));
}

function breakdown(b) {
  return el('details', { class: 'disclose' },
    el('summary', {}, icon('doc', { size: 20 }), 'How this was worked out'),
    el('div', { class: 'disclose__body' },
      kv('Gas used', kg(b.consumption)),
      kv('Rate', `${money(b.ratePerKg)} per kg`),
      kv('Gas', money(b.gasAmount)),
      kv('Common charges', money(b.otherCharges)),
      b.lateFee ? kv('Late fee', money(b.lateFee)) : null,
      kv('Total', money(b.total), 'kv--total'),
      el('p', { class: 'tiny muted' },
        'Rounded up to the nearest rupee. Each bill keeps the rate it was issued at, so a rate change never alters a past month.')));
}

/* ═══ 2 · paying ═════════════════════════════════════════════════════════
   Its own screen rather than a section of the bill. Paying is the one thing
   somebody came here to do; giving it the whole viewport removes every
   competing target at the moment it matters most.                           */

export function pay(ctx) {
  const m = me(ctx.persona);
  const b = m.bill;

  const stuck = banner('warn',
    el('div', {}, el('strong', {}, 'Your UPI app did not open.'),
      ' Some apps refuse a payment link that comes from a browser — that is the app’s own rule, and nothing is wrong with your phone.'),
    el('p', { class: 'small' }, 'Scan the QR code below, or copy the UPI ID. Both always work.'));
  stuck.hidden = true;

  return [
    el('section', { class: 'card', style: 'align-items:center;text-align:center' },
      el('p', { class: 'hero__label' }, `Flat ${m.flat} · ${periodLabel(b.period)}`),
      el('p', { class: 'hero__amount' }, money(b.total)),
      el('p', { class: 'small muted' }, 'Pay exactly this amount and leave the note as it is.')),

    el('button', {
      class: 'btn btn--lg btn--block', type: 'button',
      onclick: () => { stuck.hidden = false; stuck.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); },
    }, icon('rupee', { size: 20 }), 'Open my UPI app'),
    el('p', { class: 'tiny muted', style: 'text-align:center' }, 'Google Pay, PhonePe, Paytm — whichever you use'),

    stuck,

    group('Or choose your app', list(
      ...[['Google Pay', '#1A73E8', 'GP'], ['PhonePe', '#5F259F', 'Pe'], ['Paytm', '#00BAF2', 'Pm']]
        .map(([label, colour, mark]) => el('button', { class: 'list__row list__row--iconed', type: 'button', onclick: () => toast(`${label} would open here`) },
          el('span', { class: 'list__icon', style: `background:${colour};font-weight:700;font-size:12px` }, mark),
          el('span', { class: 'list__body' }, el('span', { class: 'list__title' }, label)),
          svg(I.chevron, { size: 15, width: 2.4 }))))),

    group('Or scan it', el('div', { class: 'card', style: 'align-items:center;gap:var(--sp-3)' },
      fakeQr(),
      el('p', { class: 'small muted', style: 'text-align:center' },
        'Scan with any UPI app — or screenshot this and scan it from your gallery.')),
      'The QR is the one route no app can refuse.'),

    group('Or type it in by hand', el('div', { class: 'card card--tight' },
      copyRow('UPI ID', 'dddparwa@okhdfcbank'),
      copyRow('Amount', String(b.total)),
      copyRow('Note', `GAS ${m.flat}`),
      el('p', { class: 'tiny', style: 'color:var(--warn)' },
        `The note is how the treasurer knows the money came from flat ${m.flat}.`))),

    el('button', { class: 'btn btn--tinted btn--block', type: 'button', onclick: () => ctx.go('#/proof') },
      icon('camera', { size: 20 }), 'I have paid — send the screenshot'),
  ];
}

function copyRow(label, value) {
  const val = el('span', { class: 'code', style: 'flex:1;min-width:0' }, value);
  return el('div', { class: 'stack stack--xs' },
    el('span', { class: 'field__label' }, label),
    el('div', { class: 'row' }, val,
      el('button', {
        class: 'btn btn--tinted btn--sm', type: 'button',
        onclick: (e) => {
          navigator.clipboard?.writeText(value).catch(() => {});
          e.currentTarget.textContent = 'Copied';
          setTimeout(() => { e.currentTarget.textContent = 'Copy'; }, 1800);
        },
      }, 'Copy')));
}

/** A drawn stand-in, so the layout is honest about how much room a QR takes. */
function fakeQr() {
  const n = 25, cell = 8, pad = 12;
  const size = n * cell + pad * 2;
  const node = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  node.setAttribute('viewBox', `0 0 ${size} ${size}`);
  node.setAttribute('width', '212'); node.setAttribute('height', '212');
  node.setAttribute('role', 'img');
  node.setAttribute('aria-label', 'UPI payment QR code');
  let s = `<rect width="${size}" height="${size}" rx="10" fill="#fff"/>`;
  const on = (x, y) => {
    // Deterministic noise, plus the three finder squares in their real places.
    const finder = (fx, fy) => x >= fx && x < fx + 7 && y >= fy && y < fy + 7
      && !(x > fx + 1 && x < fx + 5 && y > fy + 1 && y < fy + 5) || (x >= fx + 2 && x <= fx + 4 && y >= fy + 2 && y <= fy + 4);
    if (finder(0, 0) || finder(n - 7, 0) || finder(0, n - 7)) return true;
    if ((x < 8 && y < 8) || (x > n - 9 && y < 8) || (x < 8 && y > n - 9)) return false;
    return ((x * 7 + y * 13 + ((x * y) % 5)) % 3) === 0;
  };
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    if (on(x, y)) s += `<rect x="${pad + x * cell}" y="${pad + y * cell}" width="${cell}" height="${cell}" fill="#17171C"/>`;
  }
  node.innerHTML = s;
  return node;
}

/* ═══ 3 · proof of payment ═══════════════════════════════════════════════ */

export function proof(ctx) {
  const m = me(ctx.persona);
  const b = m.bill;
  const preview = el('div', { class: 'stack stack--sm' });

  const input = el('input', { type: 'file', accept: 'image/*', class: 'sr', id: 'shot' });
  input.addEventListener('change', () => {
    preview.replaceChildren(
      banner('good', el('div', {}, el('strong', {}, 'Screenshot read.'),
        ` We found ${money(b.total)} and a reference ending 3312 — that matches your bill exactly.`)),
      el('button', { class: 'btn btn--lg btn--block', type: 'button', onclick: () => { toast('Sent to the treasurer'); ctx.go('#/bill'); } },
        'Send it'));
  });

  return [
    el('div', { class: 'stack stack--xs' },
      el('h1', { class: 'largetitle' }, 'Send your screenshot'),
      el('p', { class: 'largetitle__sub' }, `Flat ${m.flat} · ${periodLabel(b.period)} · ${money(b.total)}`)),

    banner('info', el('div', {}, 'A screenshot is not required. It just means the treasurer can confirm your payment the same day instead of waiting for the bank statement.')),

    el('label', { class: 'btn btn--lg btn--block', for: 'shot', style: 'cursor:pointer' },
      icon('camera', { size: 20 }), 'Choose a screenshot'),
    input,
    el('p', { class: 'tiny muted', style: 'text-align:center' }, 'From your gallery, or take a photo of the payment receipt'),

    preview,

    group('What we look for', list(
      row({ title: 'The amount', sub: `It should read ${money(b.total)}`, icon: 'rupee', tint: 'var(--accent)' }),
      row({ title: 'The reference number', sub: 'The long UPI or transaction number', icon: 'doc', tint: 'var(--info)' }),
      row({ title: 'The date', sub: 'Any date on or after the bill was issued', icon: 'clock', tint: 'var(--warn)' }),
    ), 'The screenshot is deleted after 24 months. Only the committee can see it, never other residents.'),
  ];
}

/* ═══ 4 · usage ══════════════════════════════════════════════════════════ */

export function usage(ctx) {
  const m = me(ctx.persona);
  const withUse = m.readings.filter((r) => r.consumption != null);
  const paidFor = new Map(m.bills.map((b) => [b.period, b.total]));
  const peak = Math.max(...withUse.map((r) => r.consumption));
  const avg = withUse.reduce((a, r) => a + r.consumption, 0) / withUse.length;

  const latest = withUse[withUse.length - 1];
  // Starts filled in, on the month people came to look at, rather than showing
  // an instruction. An empty readout that says "tap a bar" is a line of text
  // doing no work for the majority who only wanted this month's figure.
  const readout = el('p', { class: 'chart__readout' },
    el('strong', {}, periodLabel(latest.period)), ` · ${kg(latest.consumption)}`,
    paidFor.has(latest.period) ? ` · ${money(paidFor.get(latest.period))}` : '',
    el('span', { class: 'tiny', style: 'display:block;color:var(--label-3)' }, 'Tap any bar for that month.'));
  const cols = withUse.map((r, i) => {
    const col = el('button', {
      class: 'chart__col', type: 'button',
      'aria-selected': String(i === withUse.length - 1),
      'aria-label': `${periodLabel(r.period)}, ${kg(r.consumption)}`,
      onclick: () => {
        cols.forEach((c) => c.setAttribute('aria-selected', 'false'));
        col.setAttribute('aria-selected', 'true');
        readout.replaceChildren(
          el('strong', {}, periodLabel(r.period)), ` · ${kg(r.consumption)}`,
          paidFor.has(r.period) ? ` · ${money(paidFor.get(r.period))}` : '');
      },
    },
      el('span', { class: 'chart__track' },
        el('span', { class: 'chart__bar', style: `height:${Math.max(4, (r.consumption / peak) * 100)}%` })),
      // One letter, not three. Twelve months across 375px leaves 26px a column,
      // and "Sep" wrapped to "Se / p" on every one of them. The month is named
      // in full in the readout and again in the list below, so the axis only
      // has to keep your place.
      el('span', { class: 'chart__tick' }, periodShort(r.period)[0]));
    return col;
  });

  return [
    el('div', { class: 'stack stack--xs' },
      el('h1', { class: 'largetitle' }, 'Your gas use'),
      el('p', { class: 'largetitle__sub' }, `Flat ${m.flat} · last ${withUse.length} months`)),

    el('section', { class: 'card' },
      el('div', { class: 'chart' }, ...cols),
      readout,
      el('hr', { class: 'rule' }),
      el('div', { class: 'stats' },
        stat('Your average', kg(avg)),
        stat('Building average', kg(12.6)),
        stat('Your highest', kg(peak)))),

    group('Every month', el('div', { class: 'list' },
      ...m.bills.map((b) => {
        const r = m.readings.find((x) => x.period === b.period);
        return row({
          title: periodLabel(b.period),
          sub: `${kg(b.consumption)} at ${money(b.rate_per_kg)}/kg${r?.meterChangedOn ? ' · new meter fitted' : ''}`,
          chip: statusChip(b.status),
          value: null,
          onClick: () => monthSheet(b, r),
        });
      })),
      'Tap a month for its meter readings.'),
  ];
}

const stat = (k, v) => el('div', {},
  el('span', { class: 'tiny muted', style: 'display:block' }, k),
  el('strong', { class: 'num' }, v));

function monthSheet(b, r) {
  sheet(periodLabel(b.period),
    r ? el('div', { class: 'card card--tight' },
      kv('Meter read on', r.readOn ? dayFull(r.readOn) : '—'),
      kv('Reading', r.reading.toFixed(3)),
      kv('Used', kg(b.consumption)),
      r.meterChangedOn ? el('p', { class: 'tiny', style: 'color:var(--warn)' },
        `A new meter was fitted on ${dayLabel(r.meterChangedOn)}, so the reading starts again from a lower number. Your usage is unaffected.`) : null) : null,
    el('div', { class: 'card card--tight' },
      kv('Rate', `${money(b.rate_per_kg)} per kg`),
      kv('Gas', money(b.consumption * b.rate_per_kg)),
      kv('Common charges', money(40)),
      kv('Total', money(b.total), 'kv--total')));
}

/* ═══ 5 · notices ════════════════════════════════════════════════════════ */

export function notices(ctx) {
  const filter = ctx.state.noticeFilter ?? 'all';
  const shown = filter === 'all' ? NOTICES : NOTICES.filter((n) => n.kind === filter);

  return [
    el('div', { class: 'stack stack--xs' },
      el('h1', { class: 'largetitle' }, 'Notices'),
      el('p', { class: 'largetitle__sub' }, 'From the committee')),

    segmented([
      { value: 'all', label: 'Everything' },
      { value: 'notice', label: 'Notices' },
      { value: 'event', label: 'Events' },
    ], filter, (v) => { ctx.state.noticeFilter = v; ctx.render(); }),

    shown.length ? el('div', { class: 'stack stack--sm' }, ...shown.map((n) => noticeCard(ctx, n)))
      : empty('bell', 'Nothing here yet', 'Notices from the committee will appear on this screen.'),
  ];
}

function noticeCard(ctx, n) {
  return el('button', {
    class: 'card card--tight', type: 'button', style: 'text-align:left;cursor:pointer;border:0;width:100%',
    onclick: () => ctx.go(`#/notice/${n.id}`),
  },
    el('div', { class: 'row row--wrap', style: 'gap:var(--sp-2)' },
      n.kind === 'event'
        ? el('span', { class: 'chip chip--warn' }, icon('bell', { size: 15 }), 'Event')
        : el('span', { class: 'chip chip--quiet' }, icon('doc', { size: 15 }), 'Notice'),
      n.unread ? el('span', { class: 'chip chip--info' }, icon('info', { size: 15 }), 'New') : null,
      el('span', { class: 'spacer' }),
      el('span', { class: 'tiny muted' }, ago(n.postedAt))),
    el('h3', {}, n.title),
    el('p', { class: 'small muted', style: 'display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden' },
      n.body.split('\n')[0]),
    el('div', { class: 'row', style: 'gap:var(--sp-2);color:var(--accent);font-size:var(--t-subhead);font-weight:600' },
      n.comments.length ? `${n.comments.length} ${n.comments.length === 1 ? 'reply' : 'replies'}` : 'Read',
      svg(I.chevron, { size: 14, width: 2.4 })));
}

export function notice(ctx) {
  const n = NOTICES.find((x) => x.id === ctx.params[0]) ?? NOTICES[0];
  const box = el('textarea', { class: 'input', placeholder: 'Write a reply…', rows: 3 });

  return [
    el('div', { class: 'stack stack--sm' },
      el('div', { class: 'row', style: 'gap:var(--sp-2)' },
        n.kind === 'event'
          ? el('span', { class: 'chip chip--warn' }, icon('bell', { size: 15 }), 'Event')
          : el('span', { class: 'chip chip--quiet' }, icon('doc', { size: 15 }), 'Notice'),
        el('span', { class: 'tiny muted' }, `${dayFull(n.postedAt)} · ${n.by}`)),
      el('h1', { class: 'largetitle' }, n.title)),

    el('section', { class: 'card' },
      ...n.body.split('\n\n').map((p) => el('p', { style: 'white-space:pre-wrap' }, p))),

    n.attachments?.length ? group('Attached', list(
      ...n.attachments.map((a) => row({
        title: a.name, sub: a.size, icon: 'doc', tint: 'var(--info)',
        onClick: () => toast('The file would open here'),
      })))) : null,

    n.commentsOpen ? group(
      n.comments.length ? `${n.comments.length} ${n.comments.length === 1 ? 'reply' : 'replies'}` : 'Replies',
      el('div', { class: 'stack stack--sm' },
        ...n.comments.map((c) => el('div', { class: 'card card--tight' },
          el('div', { class: 'row' },
            el('span', { class: 'avatar' }, c.flat ?? '★'),
            el('div', { class: 'stack stack--xs spacer' },
              el('strong', { class: 'small' }, c.by, c.official ? ' · committee' : ''),
              el('span', { class: 'tiny muted' }, ago(c.at)))),
          el('p', { class: 'small', style: 'white-space:pre-wrap' }, c.text))),
        el('div', { class: 'card card--tight' },
          field('Add a reply', box, { hint: 'Everyone in the building can see this, and your flat number is shown with it.' }),
          el('button', { class: 'btn btn--block', type: 'button', onclick: () => { box.value = ''; toast('Reply posted'); } },
            icon('send', { size: 20 }), 'Post reply'))))
      : group('Replies', el('div', { class: 'card card--tight' },
          el('p', { class: 'small muted' }, 'Replies are turned off for this notice.'))),
  ];
}

/* ═══ 6 · profile ════════════════════════════════════════════════════════ */

export function profile(ctx) {
  const m = me(ctx.persona);
  return [
    el('div', { class: 'stack stack--sm', style: 'align-items:center;padding-top:var(--sp-4)' },
      el('div', { class: 'avatar', style: 'width:72px;height:72px;font-size:var(--t-title2)' },
        m.name.split(' ').map((w) => w[0]).slice(0, 2).join('')),
      el('h1', { style: 'font-size:var(--t-title2)' }, m.name),
      el('p', { class: 'small muted' }, m.tenancy.description)),

    group('Your details', list(
      row({ title: 'Apartment', value: `${m.flat} · Floor ${m.floor}`, icon: 'home', tint: 'var(--info)' }),
      row({ title: 'Name', value: m.name, icon: 'person', tint: 'var(--accent)', onClick: () => editSheet('Name', m.name) }),
      row({ title: 'Email', value: m.email, icon: 'mail', tint: 'var(--warn)', onClick: () => editSheet('Email', m.email) }),
      row({ title: 'Mobile', value: m.mobile, icon: 'phone', tint: 'var(--label-3)' }),
    ), 'Your mobile number is how you log in and how the portal links you to the flat. Ask the treasurer to change it. If the apartment above is wrong, tell the committee — you are the only one who would notice.'),

    group('Security', list(
      row({ title: 'Change password', icon: 'lock', tint: 'var(--bad)', onClick: () => passwordSheet() }),
      row({ title: 'Text size', value: { m: 'Normal', l: 'Large', xl: 'Largest' }[ctx.state.text],
            icon: 'text', tint: 'var(--label-2)', onClick: () => ctx.cycleText() }),
      row({ title: 'Appearance', value: ctx.state.theme === 'dark' ? 'Dark' : 'Light',
            icon: ctx.state.theme === 'dark' ? 'moon' : 'sun', tint: 'var(--label-2)', onClick: () => ctx.toggleTheme() }),
    )),

    group('Help', list(
      row({ title: 'Something is not working', sub: 'Message Sabarish (4A) on WhatsApp',
            icon: 'phone', tint: 'var(--good)', onClick: () => toast('WhatsApp would open') }),
      row({ title: 'Questions about your bill', sub: 'Reach the treasurer',
            icon: 'mail', tint: 'var(--info)', onClick: () => toast('Mail app would open') }),
    )),

    el('button', { class: 'btn btn--outline btn--block', type: 'button', style: 'color:var(--bad)', onclick: () => ctx.go('#/login') },
      icon('logout', { size: 20 }), 'Log out'),
  ];
}

function editSheet(label, value) {
  const input = el('input', { class: 'input', value });
  sheet(`Change ${label.toLowerCase()}`,
    field(label, input),
    el('button', { class: 'btn btn--block', type: 'button', onclick: () => toast('Saved') }, 'Save'));
}

function passwordSheet() {
  sheet('Change password',
    el('div', { class: 'stack' },
      field('Current password', el('input', { class: 'input', type: 'password' })),
      field('New password', el('input', { class: 'input', type: 'password' }),
        { hint: 'At least 10 characters. Not your flat number, your name, or your mobile.' }),
      field('Type it again', el('input', { class: 'input', type: 'password' }),
        { hint: 'A password change signs you out everywhere, so a typo here is found at the login screen. Better to catch it now.' }),
      el('button', { class: 'btn btn--block', type: 'button', onclick: () => toast('Password changed') }, 'Change password')));
}
