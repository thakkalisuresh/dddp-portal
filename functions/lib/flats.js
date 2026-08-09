/**
 * Adding a flat.
 *
 * This used to exist to work around a dead column: `flats.legacy_paise_tag`
 * was NOT NULL UNIQUE with CHECK (BETWEEN 1 AND 99), so every INSERT had to
 * supply a value and the table could hold at most 99 rows. DD Diamond Park has
 * exactly 99, which is not headroom — it is the limit.
 *
 * scripts/rebuild-flats.mjs removed the column. What remains here is the one
 * thing worth keeping: floor is derived from the label rather than typed
 * twice, so a roster paste cannot disagree with itself about which floor a
 * flat is on.
 */

import { fail } from './errors.js';

/**
 * Floor number from a flat label: '4A' -> 4, '13E' -> 13, '10C' -> 10.
 *
 * A duplex takes the floor it starts on. 10C occupies floors 10 and 11 but is
 * one home with one meter and one bill, so 11C is not a flat and must never be
 * created.
 */
export function floorOf(flat) {
  const m = /^(\d+)/.exec(String(flat).trim());
  if (!m) fail('DDP-ADMIN-007', { flat });
  return Number(m[1]);
}

/** Insert one flat. Idempotent, so re-importing a roster is safe. */
export async function addFlat(env, flat, floor = floorOf(flat)) {
  await env.DB.prepare(
    'INSERT INTO flats (flat, floor) VALUES (?, ?) ON CONFLICT(flat) DO NOTHING'
  ).bind(flat, floor).run();
}
