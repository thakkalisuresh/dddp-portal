/**
 * A mobile number as two controls: the country, and the rest.
 *
 * One box asked to be both "your 10 digits" and "a full international number"
 * cannot tell which the typist meant, and guessing is what turned a mistyped
 * 9-digit Kerala number into +987654321 — a number in no country, stored
 * without complaint, discovered when the resident could not log in. With the
 * country stated, the length of the rest is a fact that can be checked.
 *
 * The picker is a <details> like every other disclosure in this app, with a
 * search box because a list of two hundred countries is not something anyone
 * should scroll. Native <select> would be less code and has no search.
 */

import { el } from './ui.js';
import { DIAL_CODES, COMMON_ISO, NATIONAL_LENGTHS, splitMobile, countryName } from './countries.js';

const ENTRIES = DIAL_CODES
  .map(([iso, dial]) => ({ iso, dial: String(dial), name: countryName(iso) }))
  .sort((a, b) => a.name.localeCompare(b.name));

// The building is in Kerala and its absent owners are mostly in the Gulf, so
// those sit at the top. Everything else is alphabetical.
const ORDERED = [
  ...COMMON_ISO.map((iso) => ENTRIES.find((e) => e.iso === iso)).filter(Boolean),
  ...ENTRIES.filter((e) => !COMMON_ISO.includes(e.iso)),
];

/**
 * Returns { node, value, focus }. `value()` gives E.164, or '' when the number
 * part is empty — an empty field is "unchanged", never "+91".
 */
export function mobileField(initial = '', { label = 'Mobile' } = {}) {
  const parts = splitMobile(initial);
  let dial = parts?.dial ?? '91';

  const summary = el('summary', { class: 'dial__current', title: 'Change country' }, `+${dial}`);
  const search = el('input', {
    class: 'input', type: 'search', placeholder: 'Search country',
    'aria-label': 'Search country codes',
  });
  const options = el('div', { class: 'dial__list' });
  const picker = el('details', { class: 'dial' }, summary,
    el('div', { class: 'dial__pop' }, search, options));

  const number = el('input', {
    class: 'input num', type: 'tel', inputmode: 'numeric', value: parts?.national ?? '',
    placeholder: hintFor(dial), 'aria-label': label,
  });

  function paint(query = '') {
    const q = query.trim().toLowerCase();
    // Digits only count when there are some. '' .startsWith('') is true of
    // every dial code, so a name search matched all two hundred countries.
    const asDigits = q.replace(/\D/g, '');
    const shown = (q
      ? ORDERED.filter((e) => e.name.toLowerCase().includes(q)
                           || (asDigits && e.dial.startsWith(asDigits))
                           || e.iso.toLowerCase() === q)
      : ORDERED).slice(0, 40);

    options.replaceChildren(...(shown.length ? shown.map((e) => el('button', {
      class: `dial__opt ${e.dial === dial ? 'dial__opt--on' : ''}`, type: 'button',
      onclick: () => {
        dial = e.dial;
        summary.textContent = `+${dial}`;
        number.placeholder = hintFor(dial);
        picker.open = false;
        number.focus();
      },
    }, el('span', {}, e.name), el('span', { class: 'dial__code' }, `+${e.dial}`)))
      : [el('p', { class: 'small', style: 'padding:var(--s-2)' }, 'No country matches that.')]));
  }

  search.addEventListener('input', () => paint(search.value));
  picker.addEventListener('toggle', () => {
    if (!picker.open) return;
    search.value = '';
    paint();
    search.focus();
  });
  paint();

  return {
    node: el('div', { class: 'mobilefield' }, picker, number),
    value: () => {
      const digits = number.value.replace(/\D/g, '');
      return digits ? `+${dial}${digits}` : '';
    },
    focus: () => number.focus(),
    // The country is deliberately kept: an admin adding a family of tenants
    // from the same country should not re-pick it for every one of them.
    clear: () => { number.value = ''; },
  };
}

/** '9XXXXXXXXX' for a country whose length we know, and nothing invented for one we don't. */
function hintFor(dial) {
  const allowed = NATIONAL_LENGTHS[Number(dial)];
  return allowed ? 'X'.repeat(allowed[0]) : 'Number';
}
