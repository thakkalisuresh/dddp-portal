/**
 * The roster import: turning a pasted spreadsheet into 99 flats and their
 * residents.
 *
 * This runs ONCE for the building and then occasionally for a new arrival, so
 * the design bias is entirely toward catching mistakes rather than toward
 * speed. A wrong mobile number means a resident who can never log in and will
 * not discover it until they try; a duplicated flat means somebody is billed
 * twice. Both are far cheaper to catch in a preview than in a month's bills.
 *
 * Nothing here writes. parseRoster reads text, previewRoster decides what
 * would happen, and the caller commits only what the preview approved.
 */

import { isFlat, whyNot, parseFlat, allFlats, floorOfFlat } from './building.js';
import { occupantOf } from './tenancy.js';
import { normaliseMobile } from './godedit.js';

/** Column headers people actually paste, mapped to what we need. */
const HEADERS = {
  flat: ['flat', 'flatno', 'flat no', 'flat number', 'apartment', 'unit', 'house'],
  name: ['name', 'resident', 'owner', 'resident name', 'owner name'],
  mobile: ['mobile', 'phone', 'contact', 'mobile no', 'number', 'mobile number'],
  relationship: ['relationship', 'type', 'owner/tenant', 'owner or tenant', 'status'],
  email: ['email', 'e-mail', 'mail'],
};

function headerFor(cell) {
  const v = String(cell ?? '').trim().toLowerCase().replace(/[_-]+/g, ' ');
  for (const [key, names] of Object.entries(HEADERS)) if (names.includes(v)) return key;
  return null;
}

/** Tabs if present, otherwise commas. Tabs win because pasting from a sheet gives tabs. */
function splitLine(line) {
  return (line.includes('\t') ? line.split('\t') : line.split(',')).map((c) => c.trim());
}

/**
 * Read the paste.
 *
 * Column ORDER is taken from a header row when there is one, and assumed to be
 * flat, name, mobile, relationship otherwise. Guessing silently would be worse
 * than either: `detectedHeader` is returned so the screen can say which
 * happened, because a roster whose columns were misread looks perfectly
 * plausible right up until the wrong people get the wrong bills.
 */
export function parseRoster(text) {
  const lines = String(text ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return { rows: [], detectedHeader: false, columns: [] };

  let columns = ['flat', 'name', 'mobile', 'relationship'];
  let detectedHeader = false;

  const first = splitLine(lines[0]);
  const mapped = first.map(headerFor);
  if (mapped.filter(Boolean).length >= 2) {
    columns = mapped;
    detectedHeader = true;
    lines.shift();
  }

  const rows = lines.map((line, i) => {
    const cells = splitLine(line);
    const row = { line: i + 1 + (detectedHeader ? 1 : 0), raw: line };
    columns.forEach((col, idx) => { if (col) row[col] = cells[idx] ?? ''; });
    return row;
  });

  return { rows, detectedHeader, columns };
}

const RELATIONSHIPS = { owner: 'owner', o: 'owner', tenant: 'tenant', t: 'tenant', rent: 'tenant' };

function readRelationship(value) {
  const v = String(value ?? '').trim().toLowerCase();
  if (!v) return { ok: true, value: 'owner', defaulted: true };
  const hit = RELATIONSHIPS[v];
  return hit ? { ok: true, value: hit } : { ok: false };
}

/**
 * What the paste would do, decided before anything is written.
 *
 * Splits into three: `create` is safe, `blocked` cannot be written at all, and
 * `warnings` are rows that would import but probably should not. The split
 * matters because blocking the whole import over one questionable row means
 * somebody strips the warnings out to get it through, and blocking nothing
 * means the questionable rows land silently.
 *
 * @param existingFlats  flats already in the database
 * @param existingPeople EVERY owners row, active and not — see below
 */
export function previewRoster(rows, { existingFlats = [], existingPeople = [] } = {}) {
  const create = [];
  const blocked = [];
  const warnings = [];

  const known = new Set(existingFlats);
  const seenMobile = new Map();
  const seenPerFlat = new Map();

  for (const p of existingPeople) {
    // TWO MAPS, TWO DIFFERENT QUESTIONS, AND ONLY ONE OF THEM IS ABOUT WHO
    // LIVES HERE NOW.
    //
    // The household map is about the current building: who shares a flat, who
    // is the tenant, who would be liable. A departed resident is not part of
    // that, so it stays filtered to active people.
    //
    // The mobile map is about a UNIQUE constraint. owners.mobile is NOT NULL
    // UNIQUE across every row regardless of `active`, and planDeparture
    // deactivates people rather than deleting them, deliberately, to keep the
    // history. So a departed resident's number is still taken. Filtering this
    // map to active people let a returning tenant — or one moving to another
    // flat in the same building — pass the preview and fail at the INSERT,
    // which is the one place the committee cannot see it coming.
    const digits = String(p.mobile ?? '').replace(/\D/g, '').slice(-10);
    if (digits) {
      // Last ten digits collide more readily than the full stored strings do,
      // so where two rows share them the living one is the more useful thing
      // to name back.
      const prior = seenMobile.get(digits);
      if (!prior || (!prior.active && p.active)) {
        seenMobile.set(digits, { flat: p.flat, name: p.name, existing: true, active: !!p.active });
      }
    }
    if (!p.active) continue;
    seenPerFlat.set(p.flat, [...(seenPerFlat.get(p.flat) ?? []), { ...p, existing: true }]);
  }

  for (const row of rows) {
    const flatIn = String(row.flat ?? '').trim();
    const parsed = parseFlat(flatIn);
    const flat = parsed?.flat ?? flatIn.toUpperCase();
    const name = String(row.name ?? '').trim();
    const mobileIn = String(row.mobile ?? '').trim();
    const email = String(row.email ?? '').trim().toLowerCase() || null;

    const stop = (reason, extra) =>
      blocked.push({ line: row.line, flat: flat || '(blank)', name, reason, ...extra });

    if (!flatIn) { stop('No flat number on this line.'); continue; }
    if (!isFlat(flat)) { stop(whyNot(flat)); continue; }

    // A flat with no name is a vacant flat: legitimate, and worth recording so
    // the meter still gets read even when nobody is living there.
    if (!name && !mobileIn) {
      create.push({ line: row.line, flat, floor: floorOfFlat(flat), vacant: true });
      continue;
    }
    if (!name) { stop('A mobile number with no name against it.'); continue; }
    if (!mobileIn) { stop(`${name} has no mobile number, and that is the login.`); continue; }

    let mobile;
    try {
      mobile = normaliseMobile(mobileIn);
    } catch {
      stop(`"${mobileIn}" is not a usable mobile number. Include the country code if it is not Indian.`);
      continue;
    }

    const rel = readRelationship(row.relationship);
    if (!rel.ok) {
      stop(`"${row.relationship}" is not owner or tenant.`);
      continue;
    }

    // One number, one login. Two people sharing it means one cannot get in.
    const digits = mobile.replace(/\D/g, '').slice(-10);
    const clash = seenMobile.get(digits);
    if (clash) {
      if (!clash.existing) {
        stop(`Same mobile as ${clash.flat} ${clash.name} on this paste.`);
      } else if (clash.active) {
        stop(`That mobile already belongs to ${clash.name} in ${clash.flat}.`);
      } else {
        // Blocked rather than warned, and the reason is mechanical: warnings do
        // not stop an import, so warning here would mean the paste sails on and
        // the UNIQUE constraint refuses it mid-write. The committee's intent is
        // almost always to bring the old row back, which is an edit, not an
        // import — `departed` marks the row so the screen can say where.
        stop(`${clash.name} already has this mobile, from ${clash.flat}, and has left. `
           + 'The number stays theirs while the record does. Bring them back on Residents '
           + 'instead of adding them a second time.', { departed: true, from: clash.flat });
      }
      continue;
    }
    seenMobile.set(digits, { flat, name });

    const household = [...(seenPerFlat.get(flat) ?? [])];
    if (rel.value === 'tenant' && household.some((h) => h.relationship === 'tenant')) {
      stop(`${flat} already has a tenant on this list. One meter, one bill.`);
      continue;
    }
    seenPerFlat.set(flat, [...household, { name, relationship: rel.value }]);

    create.push({
      line: row.line, flat, floor: floorOfFlat(flat), name, mobile, email,
      relationship: rel.value, relationshipDefaulted: rel.defaulted,
      newFlat: !known.has(flat),
    });
  }

  // ── warnings: importable, but somebody should look ─────────────────────
  const byFlat = new Map();
  for (const c of create) {
    if (c.vacant) continue;
    byFlat.set(c.flat, [...(byFlat.get(c.flat) ?? []), c]);
  }
  for (const [flat, people] of byFlat) {
    const existing = (seenPerFlat.get(flat) ?? []).filter((p) => p.existing);
    const all = [...existing, ...people];
    if (all.some((p) => p.relationship === 'tenant') && !all.some((p) => p.relationship === 'owner')) {
      warnings.push({
        flat,
        message: `${flat} has a tenant but no owner. Nobody would be liable if they left owing.`,
      });
    }
    if (all.filter((p) => p.relationship === 'owner').length > 1) {
      warnings.push({ flat, message: `${flat} has more than one owner listed. Only one is treated as liable.` });
    }
  }

  const defaulted = create.filter((c) => c.relationshipDefaulted && !c.vacant).length;
  if (defaulted) {
    warnings.push({
      message: `${defaulted} ${defaulted === 1 ? 'row has' : 'rows have'} no owner/tenant column, `
             + 'so they will be recorded as owners.',
    });
  }

  // Flats in the building that this paste does not mention, so a half-typed
  // roster is visible as a gap rather than passing as complete.
  const listed = new Set([...create.map((c) => c.flat), ...known]);
  const missing = allFlats().filter((f) => !listed.has(f));

  return {
    create,
    blocked,
    warnings,
    missing,
    counts: {
      flats: new Set(create.filter((c) => c.newFlat || c.vacant).map((c) => c.flat)).size,
      people: create.filter((c) => !c.vacant).length,
      vacant: create.filter((c) => c.vacant).length,
      tenants: create.filter((c) => c.relationship === 'tenant').length,
      missing: missing.length,
    },
    // Blocked rows stop the import. Warnings do not: they are judgement calls,
    // and a preview nobody can get past is a preview people learn to bypass.
    canImport: blocked.length === 0 && create.length > 0,
  };
}

/* ── bulk late-fee exemption ─────────────────────────────────────────────── */

/**
 * Resolve a typed list of flats to the people a late fee would actually hit.
 *
 * The unit is the FLAT, not the person, because the reason is always about the
 * property: a meter fault, a supply outage, a month billed late. But the
 * exemption has to land on whoever is billed — the tenant where there is one,
 * the owner otherwise — so this resolves through the occupant rather than
 * exempting everybody attached to the flat. Exempting an absent owner who is
 * never charged would look like it worked and change nothing.
 *
 * Accepts "4A 4B 5A", commas, newlines, or the word "all".
 *
 * @param people  every owner row, active and not
 */
export function resolveExemptionTargets(input, people, { today } = {}) {
  const text = String(input ?? '').trim();
  const byFlat = new Map();
  for (const p of people) {
    if (!p.active) continue;
    byFlat.set(p.flat, [...(byFlat.get(p.flat) ?? []), p]);
  }

  const everyone = /^all$/i.test(text);
  const asked = everyone
    ? [...byFlat.keys()]
    : [...new Set(text.split(/[\s,;]+/).filter(Boolean).map((f) => {
        const m = /^\s*(\d{1,2})\s*([A-Za-z])\s*$/.exec(f);
        return m ? `${Number(m[1])}${m[2].toUpperCase()}` : f.toUpperCase();
      }))];

  const targets = [];
  const unknown = [];
  const empty = [];
  const already = [];

  for (const flat of asked) {
    if (!isFlat(flat)) { unknown.push({ flat, reason: whyNot(flat) }); continue; }

    const household = byFlat.get(flat) ?? [];
    const occupant = occupantOf(household);
    if (!occupant) { empty.push(flat); continue; }

    // Listed rather than silently overwritten: an existing exemption was a
    // decision somebody made, and replacing its reason erases why.
    if (today && occupant.late_fee_exempt_until && occupant.late_fee_exempt_until >= today) {
      already.push({
        flat, name: occupant.name,
        until: occupant.late_fee_exempt_until,
        reason: occupant.late_fee_exempt_reason,
      });
    }
    targets.push({ id: occupant.id, flat, name: occupant.name, relationship: occupant.relationship });
  }

  return {
    targets, unknown, empty, already, everyone,
    counts: { targets: targets.length, unknown: unknown.length, empty: empty.length,
              already: already.length },
    ok: targets.length > 0 && unknown.length === 0,
  };
}
