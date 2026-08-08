/**
 * Adding a flat.
 *
 * This exists for one reason: flats.legacy_paise_tag is a dead column that is
 * still NOT NULL UNIQUE, because it could not be dropped without a table
 * rebuild D1 will not run (see migrations/0005_retire_paise_tag.sql). Nothing
 * reads it, but every INSERT must still put something in it.
 *
 * Rather than let that surprise whoever builds the roster import, the value is
 * assigned here and never thought about again. Import code should call this and
 * not write its own INSERT.
 */

import { fail } from './errors.js';

/**
 * The dead column is capped at 1..99 by a CHECK the rename carried over, which
 * is also a hard ceiling on how many flats can exist. DD Diamond Park has 52,
 * so this is headroom rather than a live limit — but it must fail loudly if it
 * is ever reached instead of throwing a raw SQLITE_CONSTRAINT at someone
 * halfway through importing a roster.
 */
export const MAX_FLATS = 99;

/** Floor number from a flat label: '4A' -> 4, '13E' -> 13. */
export function floorOf(flat) {
  const m = /^(\d+)/.exec(String(flat).trim());
  if (!m) fail('DDP-ADMIN-007', { flat });
  return Number(m[1]);
}

/**
 * Insert one flat, filling the vestigial column with the next free number.
 * Idempotent: re-importing a roster must not fail on flats already present.
 */
export async function addFlat(env, flat, floor = floorOf(flat)) {
  const { n } = await env.DB.prepare('SELECT COUNT(*) AS n FROM flats').first();
  if (n >= MAX_FLATS) fail('DDP-ADMIN-008', { flats: n, max: MAX_FLATS });

  await env.DB.prepare(
    `INSERT INTO flats (flat, floor, legacy_paise_tag)
     VALUES (?, ?, (SELECT COALESCE(MAX(legacy_paise_tag), 0) + 1 FROM flats))
     ON CONFLICT(flat) DO NOTHING`
  ).bind(flat, floor).run();
}
