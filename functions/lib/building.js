/**
 * DD Diamond Park, as a data structure.
 *
 * 99 flats. Not a round number and not a guess — it falls out of the
 * developer's availability chart and the brochure's floor plans, and it
 * happens to be exactly the number the old paise column could hold, which is
 * why that column had to go before any of this could be imported.
 *
 * The shape is irregular in four ways, and every one of them is a flat label
 * somebody will type that must be rejected:
 *
 *   floor 1      A, B and C are PARKING. The flats are D to H.
 *   floors 2-9   the full eight, A to H.
 *   floors 10-15 only five units, and wider: A, B, C, D, E.
 *   floor 16     B, D and A. C and E are recreation.
 *
 * And the subtlety that catches people: on floors 10-15 the Type C units are
 * DUPLEXES. 10C occupies floors 10 and 11, 12C occupies 12 and 13, 14C
 * occupies 14 and 15. One home, one kitchen, one meter, one bill. So 11C, 13C
 * and 15C are not flats — they are the upper halves of flats that already
 * exist, and creating them would bill one household twice.
 *
 * Verified against the developer's own documents on 2026-08-12 — the
 * availability chart and the brochure's Key Plan 2 — rather than left as the
 * reading that produced it. Every line above holds, including the brochure
 * stating outright that 11, 13 and 15 are the UPPER floors of the duplexes
 * below them.
 *
 * One trap those documents introduce, which is about labels rather than the
 * model. On floor 16 the brochure calls the 1461 sq.ft unit "Type C", while
 * the chart puts it in the D position — and the bay actually labelled C on
 * that floor is recreation. So this file calls that home 16D and REJECTS 16C,
 * which is correct, but an owner whose paperwork says "16C" will have their
 * line stopped by the roster import. Expect it and correct the roster; do not
 * "fix" it by admitting 16C, which would create a flat in a recreation bay.
 *
 * Pure and exported so the roster import validates against the real building
 * rather than accepting whatever was pasted.
 */

import { fail } from './errors.js';

export const TOP_FLOOR = 16;

/** Floor 1 is mostly the car park. */
export const PARKING = ['A', 'B', 'C'];

/** Floors 10-15: the lower floor of each two-storey Type C. */
export const DUPLEX_LOWER = [10, 12, 14];

/** Floor 16 has no C or E — those bays are the recreation rooms. */
export const RECREATION = ['C', 'E'];

const LETTERS_1_TO_9 = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
const LETTERS_10_UP = ['A', 'B', 'C', 'D', 'E'];

/** Units on a given floor, in label order. */
export function unitsOn(floor) {
  if (floor === 1) return LETTERS_1_TO_9.filter((u) => !PARKING.includes(u));
  if (floor >= 2 && floor <= 9) return [...LETTERS_1_TO_9];
  if (floor >= 10 && floor <= 15) {
    return LETTERS_10_UP.filter((u) => {
      // C exists only where a duplex STARTS. The floor above is its upstairs.
      if (u === 'C') return DUPLEX_LOWER.includes(floor);
      return true;
    });
  }
  if (floor === TOP_FLOOR) return LETTERS_10_UP.filter((u) => !RECREATION.includes(u));
  return [];
}

/** Every flat in the building, in reading order. */
export function allFlats() {
  const out = [];
  for (let floor = 1; floor <= TOP_FLOOR; floor += 1) {
    for (const unit of unitsOn(floor)) out.push(`${floor}${unit}`);
  }
  return out;
}

/** Split a label into floor and unit, or null if it is not even the right shape. */
export function parseFlat(label) {
  const m = /^\s*(\d{1,2})\s*([A-Za-z])\s*$/.exec(String(label ?? ''));
  if (!m) return null;
  return { floor: Number(m[1]), unit: m[2].toUpperCase(), flat: `${Number(m[1])}${m[2].toUpperCase()}` };
}

export function isFlat(label) {
  const p = parseFlat(label);
  return Boolean(p) && unitsOn(p.floor).includes(p.unit);
}

/**
 * Why a label is not a flat, in words the person pasting can act on.
 *
 * A bare "unknown flat" would be useless here: the four ways to be wrong have
 * four different fixes, and "11C is the upstairs of 10C" is the difference
 * between deleting a row and re-checking the whole roster.
 */
export function whyNot(label) {
  const p = parseFlat(label);
  if (!p) return 'Not a flat number. Expected something like 4A or 13E.';

  const { floor, unit } = p;
  if (floor < 1 || floor > TOP_FLOOR) return `There is no floor ${floor}. The building has 16.`;
  if (isFlat(label)) return null;

  if (floor === 1 && PARKING.includes(unit)) {
    return `${p.flat} is car parking. Floor 1 has D to H.`;
  }
  if (floor === TOP_FLOOR && RECREATION.includes(unit)) {
    return `${p.flat} is a recreation room, not a flat. Floor 16 has A, B and D.`;
  }
  if (floor >= 10 && unit === 'C') {
    const lower = floor - 1;
    return `${p.flat} is the upper floor of ${lower}C, which is a duplex. `
         + 'It is one home with one meter, so it is billed once as ' + `${lower}C.`;
  }
  if (floor >= 10 && ['F', 'G', 'H'].includes(unit)) {
    return `Floors 10 and above have only A to E. ${p.flat} does not exist.`;
  }
  return `${p.flat} is not a flat in this building.`;
}

/** Floor number from a label, for storage. A duplex takes its lower floor. */
export function floorOfFlat(label) {
  const p = parseFlat(label);
  if (!p) fail('DDP-ADMIN-007', { flat: label });
  return p.floor;
}

/**
 * The whole building at a glance, for the import screen. Someone checking a
 * roster against reality needs to see the shape, not a list of 99 strings.
 */
export function floorSummary() {
  const rows = [];
  for (let floor = TOP_FLOOR; floor >= 1; floor -= 1) {
    const units = unitsOn(floor);
    const notes = [];
    if (floor === 1) notes.push('A-C parking');
    if (DUPLEX_LOWER.includes(floor)) notes.push(`${floor}C duplex, upstairs is floor ${floor + 1}`);
    if (floor === TOP_FLOOR) notes.push('C and E are recreation');
    rows.push({ floor, units, count: units.length, note: notes.join('; ') });
  }
  return rows;
}
