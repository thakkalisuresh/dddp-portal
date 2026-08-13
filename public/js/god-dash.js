/**
 * The god-mode dashboard — is anyone actually using this portal?
 *
 * The activity log below it answers "what happened to 4A on Tuesday". It
 * cannot answer the question the committee asks, which is whether the next
 * month can be billed here instead of on WhatsApp. 99 flats and a 400-row
 * timeline is not a dataset a person can read.
 *
 * Every figure comes from /api/god/stats, which counts rows the portal already
 * writes. This screen turns on no new recording of any kind (docs/PRIVACY.md),
 * and it deliberately shows no money: traffic and adoption only.
 *
 * Charts are plain divs and hairlines, not a library. The whole app is 40kB of
 * hand-written modules on Kerala mobile data; a charting dependency would cost
 * more than every other screen combined.
 */

import { api } from './api.js';
import { el, setChildren, showError } from './ui.js';

const WINDOWS = [7, 14, 30, 90];

/** Bars are labelled every Nth day so a 90-day window does not become a smear. */
const labelEvery = (n) => (n <= 14 ? 1 : n <= 30 ? 3 : 10);

/** "1 login", not "1 logins" — the readout is a sentence somebody reads. */
const count = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const METRICS = [
  { key: 'people',    label: 'People', unit: 'people' },
  { key: 'pageViews', label: 'Page views', unit: 'views' },
  { key: 'logins',    label: 'Logins', unit: 'logins' },
  { key: 'events',    label: 'All events', unit: 'events' },
  { key: 'errors',    label: 'Errors', unit: 'errors' },
  { key: 'stack',     label: 'Breakdown', unit: 'events' },
];

let days = 14;
let metric = 'people';
// The last payload, kept so switching the chart between people and page views
// redraws from numbers already in hand. Only the window length changes what the
// server would answer, so only the window length is worth another query.
let latest = null;

/**
 * Returns the container immediately and fills it when the numbers arrive.
 *
 * The timeline underneath is the page's real job and must not wait on an
 * aggregate query that touches four tables.
 */
export function renderDashboard() {
  const box = el('section', { class: 'stack', id: 'dash' },
    el('p', { class: 'muted small' }, 'Counting…'));
  load(box);
  return box;
}

async function load(box) {
  try {
    latest = await api.god.stats(days);
    paint(box);
  } catch (err) {
    showError(box, err);
  }
}

function paint(box) {
  if (latest) setChildren(box, ...view(latest, box));
}

function view(s, box) {
  return [
    header(s, box),
    tiles(s),
    trendPanel(s, box),
    adoptionPanel(s),
    heatPanel(s),
    funnelPanel(s),
    el('div', { class: 'dash-cols' },
      pagesPanel(s), actionsPanel(s), devicesPanel(s), errorsPanel(s)),
    reachPanel(s),
  ];
}

/* ── header ──────────────────────────────────────────────────────────────── */

function header(s, box) {
  const picker = el('select', { class: 'input', style: 'max-width:150px',
    onchange: (e) => { days = Number(e.target.value); load(box); } },
    ...WINDOWS.map((d) =>
      el('option', { value: String(d), selected: d === days || null }, `Last ${d} days`)));

  return el('div', { class: 'row row--between', style: 'flex-wrap:wrap;gap:var(--s-3)' },
    el('div', {},
      el('p', { class: 'label' }, 'Portal usage'),
      el('p', { class: 'small muted' },
        `${s.from} to ${s.to} · all times IST · generated ${s.generatedAt}`)),
    picker);
}

/* ── the headline numbers ────────────────────────────────────────────────── */

function tile(label, value, note, tone) {
  return el('div', { class: `tile${tone ? ` tile--${tone}` : ''}` },
    el('span', { class: 'label' }, label),
    el('strong', { class: 'tile__num' }, String(value)),
    note ? el('span', { class: 'tile__note' }, note) : null);
}

/**
 * A number with nothing beside it cannot be acted on. Every tile carries either
 * a comparison or the denominator that gives it a size.
 */
function tiles(s) {
  const t = s.today ?? {};
  const reach = s.reach ?? {};
  const pct = reach.residents ? Math.round((reach.everLoggedIn / reach.residents) * 100) : 0;

  return el('div', { class: 'tiles' },
    tile('On right now', s.online, 'active in the last 15 min',
      s.online > 0 ? 'live' : null),
    tile('People today', t.people ?? 0, `peak ${s.totals.peakDailyPeople} in ${s.days} days`),
    tile('Logins today', t.logins ?? 0, delta(s.totals.logins, s.totals.previous.logins, 'logins')),
    tile('Page views today', t.pageViews ?? 0,
      delta(s.totals.pageViews, s.totals.previous.pageViews, 'views')),
    tile('Errors today', t.errors ?? 0,
      delta(s.totals.errors, s.totals.previous.errors, 'errors'),
      (t.errors ?? 0) > 0 ? 'bad' : null),
    tile('Have ever logged in', `${reach.everLoggedIn ?? 0}/${reach.residents ?? 0}`,
      `${pct}% of residents`, pct >= 50 ? 'good' : null));
}

/** "412 views · up 24% on the window before" — what a bare total cannot say. */
function delta(now, before, unit) {
  if (!now && !before) return `no ${unit} yet`;
  if (!before) return `${now} ${unit} · first window with any`;
  const change = Math.round(((now - before) / before) * 100);
  if (!change) return `${now} ${unit} · level with the window before`;
  return `${now} ${unit} · ${change > 0 ? 'up' : 'down'} ${Math.abs(change)}% `
       + 'on the window before';
}

/* ── the daily trend ─────────────────────────────────────────────────────── */

/**
 * One panel, three renderers, chosen by what is being asked of it.
 *
 *   ≤ 14 days, one metric  → bars. A day is a thing you can point at.
 *   > 14 days, one metric  → a line. Ninety three-pixel bars is a smear, and
 *                            the question over a quarter is the shape.
 *   the breakdown          → stacked bars at any length, because the whole
 *                            point is the proportions inside one column.
 */
function trendPanel(s, box) {
  const chosen = METRICS.find((m) => m.key === metric) ?? METRICS[0];
  const rows = s.daily ?? [];

  const readout = el('p', { class: 'chart-readout', 'aria-live': 'polite' },
    rows.length > 14 && chosen.key !== 'stack'
      ? 'Touch the line for that day.'
      : 'Touch a bar for that day.');

  const say = (r) => () => {
    readout.textContent = `${r.day} · ${count(r.people, 'person', 'people')} · `
      + `${count(r.pageViews, 'view')} · ${count(r.actions ?? 0, 'action')} · `
      + `${count(r.logins, 'login')} · ${count(r.errors, 'error')}`;
  };

  const chart = chosen.key === 'stack' ? stackChart(rows, say)
    : rows.length > 14 ? lineChart(rows, chosen, say)
      : barChart(rows, chosen, say);

  const switcher = el('div', { class: 'row', style: 'flex-wrap:wrap;gap:var(--s-2)' },
    ...METRICS.map((m) => el('button', {
      type: 'button',
      class: `btn btn--sm ${m.key === metric ? '' : 'btn--quiet'}`,
      'aria-pressed': String(m.key === metric),
      onclick: () => { metric = m.key; paint(box); },
    }, m.label)));

  return el('div', { class: 'panel dash-panel' },
    el('div', { class: 'row row--between', style: 'flex-wrap:wrap;gap:var(--s-3)' },
      el('p', { class: 'label' }, chosen.key === 'stack'
        ? 'What happened each day' : `${chosen.label} each day`), switcher),
    chart,
    chosen.key === 'stack' ? stackKey() : null,
    readout);
}

/** The x axis, labelled sparsely enough that 90 days does not overlap itself. */
function axis(rows) {
  const every = labelEvery(rows.length);
  // Day of the month is enough inside a fortnight; across a quarter it is
  // ambiguous, so those windows carry the month too.
  const label = (day) => (rows.length > 31 ? day.slice(5) : day.slice(8));

  return el('div', { class: 'daxis' },
    ...rows.map((r, i) => el('span', {},
      i % every === 0 || i === rows.length - 1 ? label(r.day) : '')));
}

/** Attach the shared readout to a hit target, by pointer and by keyboard. */
function wire(node, show) {
  node.addEventListener('pointerenter', show);
  node.addEventListener('pointerdown', show);
  node.addEventListener('focus', show);
  return node;
}

function barChart(rows, chosen, say) {
  const peak = Math.max(...rows.map((r) => r[chosen.key] ?? 0), 1);
  return el('div', {},
    el('div', { class: 'dchart' },
      ...rows.map((r, i) => {
        const value = r[chosen.key] ?? 0;
        return wire(el('div', {
          class: `dbar${i === rows.length - 1 ? ' dbar--now' : ''}${value ? '' : ' dbar--empty'}`,
          style: `height:${value ? Math.max(3, (value / peak) * 100) : 1}%`,
          tabindex: '0', title: `${r.day}: ${value} ${chosen.unit}`,
        }), say(r));
      })),
    axis(rows));
}

/**
 * An area line, drawn as SVG markup rather than through el().
 *
 * el() calls createElement, which puts an <svg> in the HTML namespace where it
 * renders as nothing at all. Handing the parser a string of markup is what
 * builds real SVG nodes — the numbers in it are all computed here, so there is
 * nothing to escape.
 */
function lineChart(rows, chosen, say) {
  const peak = Math.max(...rows.map((r) => r[chosen.key] ?? 0), 1);
  const W = 1000;
  const H = 100;
  const x = (i) => (rows.length === 1 ? W / 2 : (i / (rows.length - 1)) * W);
  const y = (v) => H - 2 - (v / peak) * (H - 6);

  const points = rows.map((r, i) => `${x(i).toFixed(1)},${y(r[chosen.key] ?? 0).toFixed(1)}`);

  const svg = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">`
    + `<path d="M${points.join(' L')} L${W},${H} L0,${H} Z" class="dline__fill"/>`
    + `<polyline points="${points.join(' ')}" class="dline__stroke"/>`
    + '</svg>';

  // Invisible per-day columns over the drawing, so a line has the same touch
  // and keyboard behaviour a row of bars has.
  const hits = el('div', { class: 'dhits' },
    ...rows.map((r) => wire(el('div', {
      tabindex: '0', title: `${r.day}: ${r[chosen.key] ?? 0} ${chosen.unit}`,
    }), say(r))));

  return el('div', {},
    el('div', { class: 'dline' }, el('div', { class: 'dline__svg', html: svg }), hits),
    axis(rows));
}

/** Views, actions and errors in one column, so a spike says what it was. */
const STACK = [
  { key: 'pageViews', cls: 'dseg--views', label: 'Page views' },
  { key: 'actions', cls: 'dseg--actions', label: 'Actions' },
  { key: 'errors', cls: 'dseg--errors', label: 'Errors' },
];

function stackChart(rows, say) {
  const total = (r) => STACK.reduce((t, p) => t + (r[p.key] ?? 0), 0);
  const peak = Math.max(...rows.map(total), 1);

  return el('div', {},
    el('div', { class: 'dchart' },
      ...rows.map((r) => {
        const height = total(r) ? Math.max(3, (total(r) / peak) * 100) : 1;
        return wire(el('div', {
          class: `dcol${total(r) ? '' : ' dbar--empty'}`,
          style: `height:${height}%`, tabindex: '0',
          title: `${r.day}: ${total(r)} events`,
        }, ...STACK.map((p) => {
          const share = total(r) ? ((r[p.key] ?? 0) / total(r)) * 100 : 0;
          return share ? el('div', { class: `dseg ${p.cls}`, style: `height:${share}%` }) : null;
        }).filter(Boolean)), say(r));
      })),
    axis(rows));
}

function stackKey() {
  return el('div', { class: 'row keyrow' },
    ...STACK.map((p) => el('span', { class: 'keyrow__item' },
      el('i', { class: `keyrow__swatch ${p.cls}` }), p.label)));
}

/* ── when the building is awake ──────────────────────────────────────────── */

const hourLabel = (h) => `${String(h).padStart(2, '0')}:00 IST`;

/**
 * The same events as the histogram above, split by weekday too.
 *
 * "Evenings are busy" and "Sunday evening is busy" are different findings, and
 * only one of them tells you when to run a deploy. Shade carries the volume,
 * but every cell also carries its number in the title and the readout, because
 * a colour ramp alone is not readable by everyone.
 */
function heatPanel(s) {
  const week = s.week ?? { grid: [], peak: 0, busiest: null };
  const readout = el('p', { class: 'chart-readout', 'aria-live': 'polite' },
    week.busiest
      ? `Busiest ${week.busiest.label} at ${hourLabel(week.busiest.hour)} — `
        + count(week.busiest.events, 'event')
      : 'Nothing recorded in this window.');

  const shade = (events) => {
    if (!events) return 'heat--0';
    const share = events / (week.peak || 1);
    return share > 0.66 ? 'heat--3' : share > 0.33 ? 'heat--2' : 'heat--1';
  };

  return el('div', { class: 'panel dash-panel dash-panel--wide' },
    el('p', { class: 'label' }, 'Weekday and hour'),
    el('div', { class: 'scroll-x' },
      el('div', { class: 'heat' },
        el('span', {}),
        // Hour ruler across the top, every third hour so it fits a phone.
        ...Array.from({ length: 24 }, (_, h) =>
          el('span', { class: 'heat__hour' }, h % 3 === 0 ? String(h) : '')),
        ...week.grid.flatMap((day) => [
          el('span', { class: 'heat__day' }, day.label),
          ...day.hours.map((cell) => wire(el('div', {
            class: `heat__cell ${shade(cell.events)}`, tabindex: '0',
            title: `${day.label} ${hourLabel(cell.hour)} — ${count(cell.events, 'event')}`,
          }), () => {
            readout.textContent =
              `${day.label} ${hourLabel(cell.hour)} · ${count(cell.events, 'event')}`;
          })),
        ]))),
    readout);
}

/**
 * The rollout curve — the one chart that is about the project rather than the
 * traffic. It only ever rises, and the dashed line it is climbing towards is
 * every flat in the building.
 */
function adoptionPanel(s) {
  const a = s.adoption ?? { points: [], residents: 0, gained: 0, share: 0 };
  const points = a.points ?? [];
  if (!points.length) return null;

  const W = 1000;
  const H = 100;
  const top = Math.max(a.residents || 1, ...points.map((p) => p.everLoggedIn));
  const x = (i) => (points.length === 1 ? W / 2 : (i / (points.length - 1)) * W);
  const y = (v) => H - 2 - (v / top) * (H - 8);

  const path = points.map((p, i) => `${x(i).toFixed(1)},${y(p.everLoggedIn).toFixed(1)}`);
  const target = y(a.residents || top).toFixed(1);

  const svg = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">`
    + `<line x1="0" y1="${target}" x2="${W}" y2="${target}" class="dline__target"/>`
    + `<path d="M${path.join(' L')} L${W},${H} L0,${H} Z" class="dline__fill"/>`
    + `<polyline points="${path.join(' ')}" class="dline__stroke"/>`
    + '</svg>';

  const readout = el('p', { class: 'chart-readout', 'aria-live': 'polite' },
    a.gained
      ? `${count(a.gained, 'flat')} joined in this window.`
      : 'No new flat logged in for the first time in this window.');

  const hits = el('div', { class: 'dhits' },
    ...points.map((p) => wire(el('div', {
      tabindex: '0', title: `${p.day}: ${p.everLoggedIn} of ${a.residents}`,
    }), () => {
      readout.textContent = `${p.day} · ${p.everLoggedIn} of ${a.residents} flats had logged in`
        + (p.newThisDay ? ` · ${count(p.newThisDay, 'flat')} joined that day` : '');
    })));

  return el('div', { class: 'panel dash-panel dash-panel--wide' },
    el('div', { class: 'row row--between', style: 'flex-wrap:wrap;gap:var(--s-3)' },
      el('p', { class: 'label' }, 'Flats that have ever logged in'),
      el('p', { class: 'small muted' },
        `${Math.round((a.share ?? 0) * 100)}% of ${count(a.residents, 'flat')} · `
        + 'dashed line is the whole building')),
    el('div', { class: 'dline' }, el('div', { class: 'dline__svg', html: svg }), hits),
    readout);
}

/**
 * How far people get inside the portal.
 *
 * Not a payment rate, and the page says so in as many words: someone who copies
 * the UPI ID and pays from their own app has paid, and appears here as a
 * drop-off. The bills table is the only thing that knows who paid.
 */
function funnelPanel(s) {
  const steps = s.funnel ?? [];
  if (!steps.length) return null;

  return el('div', { class: 'panel dash-panel dash-panel--wide' },
    el('p', { class: 'label' }, 'How far people got'),
    el('div', { class: 'stack', style: 'gap:var(--s-2)' },
      ...steps.map((step) => el('div', { class: 'fstep' },
        el('span', { class: 'fstep__label' }, step.label),
        el('span', { class: 'fstep__track' },
          // Clamped: a proof approved this window for a bill opened in the last
          // one makes a later step larger than the first, which is not a bug
          // but would draw a bar past the end of its track.
          el('i', {
            class: 'fstep__bar',
            style: `width:${Math.min(100, Math.round(step.share * 100))}%`,
          })),
        el('span', { class: 'fstep__num' }, String(step.people)),
        el('span', { class: 'fstep__drop' },
          step.lostFromPrevious ? `−${step.lostFromPrevious}` : '')))),
    el('p', { class: 'small muted' },
      'People, not taps, over the window. This is not a payment rate: a resident '
      + 'who copies the UPI ID and pays from their own app shows here as a drop-off, '
      + 'and a payment reconciled from the bank statement never appears at all.'));
}

/** A row's own shape over the window, drawn small enough to sit in a cell. */
function sparkline(values = []) {
  if (values.length < 2) return null;
  const peak = Math.max(...values, 1);
  const W = 70;
  const H = 16;
  const points = values.map((v, i) =>
    `${((i / (values.length - 1)) * W).toFixed(1)},${(H - 1 - (v / peak) * (H - 3)).toFixed(1)}`);

  return el('span', {
    class: 'spark',
    html: `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" aria-hidden="true">`
        + `<polyline points="${points.join(' ')}" class="spark__line"/></svg>`,
  });
}

/** A bar behind the number, so the ranking is read rather than compared. */
function rankCell(value, peak) {
  return el('td', { class: 'r rank' },
    el('i', { class: 'rank__bar', style: `width:${Math.round((value / (peak || 1)) * 100)}%` }),
    el('span', { class: 'rank__num' }, String(value)));
}

/* ── the four lists ──────────────────────────────────────────────────────── */

function listPanel(title, empty, head, rows, extra = '') {
  const table = el('table', { class: 'table' },
    el('thead', {}, el('tr', {}, ...head.map((h, i) =>
      el('th', { class: i ? 'r' : null }, h)))),
    el('tbody', {}, ...rows));

  return el('div', { class: `panel dash-panel ${extra}`.trim() },
    el('p', { class: 'label' }, title),
    rows.length
      // Scrolled sideways rather than wrapped: on a phone a three-column table
      // of sentences turns every row into a five-line paragraph, and this is
      // the pattern the admin tables already use.
      ? el('div', { class: 'scroll-x' }, table)
      : el('p', { class: 'small muted' }, empty));
}

function pagesPanel(s) {
  const rows = s.pages ?? [];
  const peak = Math.max(...rows.map((p) => p.views), 1);
  const trends = s.pageTrends ?? {};

  return listPanel('Most opened pages', 'No page views in this window.',
    ['Page', 'Shape', 'Views', 'People'],
    rows.map((p) => el('tr', {},
      el('td', {}, p.name),
      // The shape matters as much as the total: /notices at 106 views is a
      // different fact depending on whether that was one Tuesday or all month.
      el('td', {}, sparkline(trends[p.name]) ?? ''),
      rankCell(p.views, peak),
      el('td', { class: 'r' }, String(p.people)))),
    'dash-panel--two');
}

function actionsPanel(s) {
  const rows = s.actions ?? [];
  const peak = Math.max(...rows.map((a) => a.count), 1);

  return listPanel('What people did', 'No actions in this window.',
    ['Action', 'Times', 'People'],
    rows.map((a) => el('tr', {},
      el('td', {}, a.name),
      rankCell(a.count, peak),
      el('td', { class: 'r' }, String(a.people)))));
}

/**
 * Four buckets, not a browser-and-version table: the useful question is "should
 * I be testing this on a phone", and a finer split would fingerprint individual
 * residents in a building where most people own exactly one device.
 *
 * One bar rather than a table of percentages, and never a donut — a share is a
 * length, and three lengths side by side are compared instantly.
 */
function devicesPanel(s) {
  const rows = s.devices ?? [];
  const total = rows.reduce((t, r) => t + r.events, 0);
  const cls = { phone: 'dseg--actions', desktop: 'dseg--views', tablet: 'dseg--tablet' };

  return el('div', { class: 'panel dash-panel' },
    el('p', { class: 'label' }, 'Devices'),
    total
      ? el('div', { class: 'stack', style: 'gap:var(--s-3)' },
          el('div', { class: 'split' },
            ...rows.map((d) => el('i', {
              class: `split__part ${cls[d.device] ?? 'dseg--tablet'}`,
              style: `width:${(d.events / total) * 100}%`,
              title: `${d.device} — ${count(d.events, 'visit')}`,
            }))),
          el('div', { class: 'row keyrow' },
            ...rows.map((d) => el('span', { class: 'keyrow__item' },
              el('i', { class: `keyrow__swatch ${cls[d.device] ?? 'dseg--tablet'}` }),
              `${d.device} ${Math.round((d.events / total) * 100)}%`))))
      : el('p', { class: 'small muted' }, 'No visits in this window.'));
}

function errorsPanel(s) {
  return listPanel('Errors by code', 'Nothing broke in this window.',
    ['Code', 'Times', 'Last seen'],
    (s.errorCodes ?? []).map((e) => el('tr', {},
      el('td', {}, el('span', {}, e.code),
        e.message ? el('div', { class: 'small muted' }, e.message) : null),
      el('td', { class: 'r' }, String(e.count)),
      el('td', { class: 'r small muted' }, e.atIST ?? ''))),
    // Full width: an error code, its sentence and a timestamp do not fit in a
    // third of the row, and this is the panel someone reads carefully.
    'dash-panel--wide');
}

/* ── rollout reach ───────────────────────────────────────────────────────── */

/**
 * The door-knocking list.
 *
 * A flat that has never logged in will not see its bill here, and will still be
 * chased on WhatsApp — so this is the one part of the dashboard that is a task
 * rather than a statistic. Names are shown because "23 flats" cannot be acted
 * on and the same names are one click away in the roster anyway.
 */
function reachPanel(s) {
  const r = s.reach ?? {};
  const never = r.neverLoggedIn ?? [];
  const dormant = r.dormant ?? [];

  return el('div', { class: 'panel dash-panel' },
    el('p', { class: 'label' }, 'Rollout reach'),
    el('div', { class: 'tiles' },
      tile('Residents', r.residents ?? 0, 'active accounts'),
      tile('Ever logged in', r.everLoggedIn ?? 0, 'since the portal opened'),
      tile('Used it this window', r.activeInWindow ?? 0, `in the last ${s.days} days`),
      tile('Never logged in', never.length, 'need chasing', never.length ? 'bad' : 'good')),
    never.length
      ? el('details', { class: 'panel-sub' },
          el('summary', {}, `The ${never.length} flats that have never logged in`),
          el('p', { class: 'flatlist' },
            never.map((o) => `${o.flat} · ${o.name}`).join('  ·  ')))
      : null,
    dormant.length
      ? el('details', { class: 'panel-sub' },
          el('summary', {},
            `${r.dormantCount} logged in once but not in ${r.dormantDays} days`),
          el('div', { class: 'scroll-x' },
            el('table', { class: 'table' },
              el('thead', {}, el('tr', {},
                el('th', {}, 'Flat'), el('th', {}, 'Name'), el('th', { class: 'r' }, 'Last login'))),
              el('tbody', {}, ...dormant.map((d) => el('tr', {},
                el('td', {}, d.flat),
                el('td', {}, d.name),
                el('td', { class: 'r small muted' }, String(d.lastAt).slice(0, 10))))))))
      : null);
}
