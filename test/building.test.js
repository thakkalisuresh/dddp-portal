import { describe, it, expect } from 'vitest';
import {
  allFlats, unitsOn, isFlat, whyNot, parseFlat, floorOfFlat, floorSummary,
} from '../functions/lib/building.js';
import { parseRoster, previewRoster, resolveExemptionTargets } from '../functions/lib/roster.js';

/* ── the building ────────────────────────────────────────────────────────── */

describe('DD Diamond Park has 99 flats', () => {
  it('counts exactly 99', () => {
    // 5 + 64 + 27 + 3. The number matters: it is also what the old paise
    // column could hold, which is why that column had to go first.
    expect(allFlats()).toHaveLength(99);
  });

  it('leaves the car park off floor 1', () => {
    expect(unitsOn(1)).toEqual(['D', 'E', 'F', 'G', 'H']);
    expect(isFlat('1A')).toBe(false);
    expect(isFlat('1D')).toBe(true);
  });

  it('gives floors 2 to 9 all eight units', () => {
    for (let f = 2; f <= 9; f += 1) expect(unitsOn(f)).toHaveLength(8);
  });

  it('drops F, G and H above floor 9', () => {
    expect(isFlat('9H')).toBe(true);
    expect(isFlat('10H')).toBe(false);
    expect(isFlat('12F')).toBe(false);
  });

  it('puts C only where a duplex STARTS', () => {
    // 10C occupies 10 and 11; 11C is its upstairs, not a second home.
    expect(isFlat('10C')).toBe(true);
    expect(isFlat('11C')).toBe(false);
    expect(isFlat('12C')).toBe(true);
    expect(isFlat('13C')).toBe(false);
    expect(isFlat('14C')).toBe(true);
    expect(isFlat('15C')).toBe(false);
  });

  it('keeps the recreation rooms off floor 16', () => {
    expect(unitsOn(16)).toEqual(['A', 'B', 'D']);
    expect(isFlat('16C')).toBe(false);
    expect(isFlat('16E')).toBe(false);
  });

  it('stops at floor 16', () => {
    expect(isFlat('17A')).toBe(false);
    expect(unitsOn(17)).toEqual([]);
  });

  it('contains every flat already in the live database', () => {
    for (const f of ['4A', '4B', '4C', '5A', '5B', '10A', '13A', '13E']) {
      expect(isFlat(f), f).toBe(true);
    }
  });

  it('reads a label whatever case or spacing it arrives in', () => {
    expect(parseFlat(' 4a ').flat).toBe('4A');
    expect(parseFlat('13 e').flat).toBe('13E');
    expect(parseFlat('flat 4A')).toBe(null);
  });

  it('gives a duplex the floor it starts on', () => {
    expect(floorOfFlat('10C')).toBe(10);
    expect(floorOfFlat('4A')).toBe(4);
  });

  it('summarises the shape for someone checking a roster', () => {
    const s = floorSummary();
    expect(s[0].floor).toBe(16);
    expect(s.reduce((n, r) => n + r.count, 0)).toBe(99);
  });
});

describe('rejections say what to do about it', () => {
  // A bare "unknown flat" would be useless: the four ways to be wrong have
  // four different fixes.
  it('explains parking', () => {
    expect(whyNot('1B')).toMatch(/car parking/i);
  });

  it('explains a duplex upstairs, and names the flat it belongs to', () => {
    expect(whyNot('11C')).toMatch(/upper floor of 10C/);
    expect(whyNot('15C')).toMatch(/upper floor of 14C/);
  });

  it('explains recreation', () => {
    expect(whyNot('16E')).toMatch(/recreation/i);
  });

  it('explains a unit letter that stops at floor 9', () => {
    expect(whyNot('11G')).toMatch(/only A to E/i);
  });

  it('says nothing about a flat that is fine', () => {
    expect(whyNot('4A')).toBe(null);
  });
});

/* ── the paste ───────────────────────────────────────────────────────────── */

describe('reading a pasted roster', () => {
  it('takes tab-separated, which is what a spreadsheet gives', () => {
    const { rows } = parseRoster('4A\tSabarish\t9567791515\towner');
    expect(rows[0]).toMatchObject({ flat: '4A', name: 'Sabarish', mobile: '9567791515' });
  });

  it('takes commas too', () => {
    const { rows } = parseRoster('4A, Sabarish, 9567791515, owner');
    expect(rows[0].name).toBe('Sabarish');
  });

  it('uses a header row when there is one, in any order', () => {
    const { rows, detectedHeader } = parseRoster(
      'Name\tFlat No\tMobile\n Priya \t 4B \t 9847011224 ');
    expect(detectedHeader).toBe(true);
    expect(rows[0]).toMatchObject({ flat: '4B', name: 'Priya' });
  });

  it('assumes an order when there is no header, and says so', () => {
    // Guessing silently is the danger: a misread roster looks plausible right
    // up until the wrong people get the wrong bills.
    const { detectedHeader } = parseRoster('4A\tSabarish\t9567791515');
    expect(detectedHeader).toBe(false);
  });

  it('ignores blank lines', () => {
    expect(parseRoster('4A\tA\t9567791515\n\n\n5A\tB\t9847011225\n').rows).toHaveLength(2);
  });
});

/* ── the preview ─────────────────────────────────────────────────────────── */

const preview = (text, opts) => previewRoster(parseRoster(text).rows, opts);

describe('what the preview refuses to write', () => {
  it('blocks a flat that does not exist, and says why', () => {
    const p = preview('11C\tSomeone\t9847011224');
    expect(p.canImport).toBe(false);
    expect(p.blocked[0].reason).toMatch(/upper floor of 10C/);
  });

  it('blocks one mobile on two rows', () => {
    // One number, one login. Two people sharing it means one cannot get in.
    const p = preview('4A\tA\t9567791515\n5A\tB\t9567791515');
    expect(p.blocked[0].reason).toMatch(/same mobile/i);
  });

  it('blocks a mobile that already belongs to somebody', () => {
    const p = preview('5A\tNew Person\t9567791515', {
      existingPeople: [{ flat: '4A', name: 'Sabarish', mobile: '+919567791515', active: 1 }],
    });
    expect(p.blocked[0].reason).toMatch(/already belongs to Sabarish/);
  });

  it('blocks a name with no mobile, because the mobile IS the login', () => {
    expect(preview('4A\tSabarish\t').blocked[0].reason).toMatch(/no mobile/i);
  });

  it('blocks an unusable number rather than storing it', () => {
    expect(preview('4A\tA\tnot-a-number').blocked[0].reason).toMatch(/not a usable mobile/i);
  });

  it('blocks two tenants on one meter', () => {
    const p = preview('4B\tA\t9847011224\ttenant\n4B\tB\t9847011225\ttenant');
    expect(p.blocked[0].reason).toMatch(/already has a tenant/i);
  });

  it('blocks a relationship it does not recognise', () => {
    expect(preview('4A\tA\t9567791515\tlandlord').blocked[0].reason).toMatch(/not owner or tenant/);
  });
});

describe('what the preview allows, with a word of warning', () => {
  it('accepts a flat with nobody in it', () => {
    // Vacant is legitimate, and the meter still gets read.
    const p = preview('5A');
    expect(p.create[0]).toMatchObject({ flat: '5A', vacant: true });
    expect(p.canImport).toBe(true);
  });

  it('warns when a let flat has no owner, without blocking it', () => {
    // A judgement call, not an error. A preview nobody can get past is one
    // people learn to bypass.
    const p = preview('4B\tPriya\t9847011224\ttenant');
    expect(p.canImport).toBe(true);
    expect(p.warnings.some((w) => /no owner/i.test(w.message))).toBe(true);
  });

  it('warns that a missing relationship column became "owner"', () => {
    const p = preview('4A\tA\t9567791515\n5A\tB\t9847011225');
    expect(p.warnings.some((w) => /recorded as owners/.test(w.message))).toBe(true);
  });

  it('normalises mobiles on the way in, including foreign ones', () => {
    const p = preview('4A\tA\t9567791515\n5A\tB\t+971 50 123 4567');
    expect(p.create.map((c) => c.mobile)).toEqual(['+919567791515', '+971501234567']);
  });

  it('accepts an owner and a tenant in the same flat', () => {
    const p = preview('4B\tNair\t9800000001\towner\n4B\tPriya\t9847011224\ttenant');
    expect(p.canImport).toBe(true);
    expect(p.warnings).toHaveLength(0);
    expect(p.counts).toMatchObject({ people: 2, tenants: 1 });
  });
});

describe('the preview shows what is NOT there', () => {
  it('lists every flat the paste never mentioned', () => {
    // A half-typed roster should look incomplete, not finished.
    const p = preview('4A\tA\t9567791515');
    expect(p.counts.missing).toBe(98);
    expect(p.missing).toContain('16D');
    expect(p.missing).not.toContain('4A');
  });

  it('counts flats already in the database as present', () => {
    const p = preview('4A\tA\t9567791515', { existingFlats: allFlats().filter((f) => f !== '4A') });
    expect(p.counts.missing).toBe(0);
  });

  it('reports nothing missing once the whole building is listed', () => {
    const text = allFlats().map((f, i) =>
      `${f}\tResident ${i}\t${String(9800000000 + i)}`).join('\n');
    const p = preview(text);
    expect(p.blocked).toEqual([]);
    expect(p.counts.people).toBe(99);
    expect(p.counts.missing).toBe(0);
    expect(p.canImport).toBe(true);
  });
});

/* ── bulk exemption ──────────────────────────────────────────────────────── */

describe('resolving a list of flats to exempt', () => {
  const people = [
    { id: 1, flat: '4A', name: 'Sabarish', relationship: 'owner', active: 1 },
    { id: 2, flat: '4B', name: 'Ravi', relationship: 'owner', active: 1 },
    { id: 3, flat: '4B', name: 'Priya', relationship: 'tenant', active: 1 },
    { id: 4, flat: '5A', name: 'Gone', relationship: 'owner', active: 0 },
  ];
  const go = (input, today) => resolveExemptionTargets(input, people, { today });

  it('lands on the TENANT of a let flat, not the owner', () => {
    // The exemption has to hit whoever is billed. Exempting an absent owner
    // who is never charged would look like it worked and change nothing.
    const r = go('4B');
    expect(r.targets).toHaveLength(1);
    expect(r.targets[0]).toMatchObject({ name: 'Priya', relationship: 'tenant' });
  });

  it('lands on the owner when they live there', () => {
    expect(go('4A').targets[0].name).toBe('Sabarish');
  });

  it('accepts spaces, commas and mixed case', () => {
    expect(go('4a, 4B').targets.map((t) => t.flat)).toEqual(['4A', '4B']);
  });

  it('expands "all" to everyone currently billed', () => {
    const r = go('all');
    expect(r.everyone).toBe(true);
    expect(r.targets.map((t) => t.flat).sort()).toEqual(['4A', '4B']);
  });

  it('refuses a flat that does not exist, with the reason', () => {
    const r = go('4A 11C');
    expect(r.ok).toBe(false);
    expect(r.unknown[0].reason).toMatch(/upper floor of 10C/);
  });

  it('skips a flat with nobody in it rather than failing', () => {
    const r = go('4A 5A');
    expect(r.empty).toEqual(['5A']);
    expect(r.targets.map((t) => t.flat)).toEqual(['4A']);
    expect(r.ok).toBe(true);
  });

  it('flags someone already exempt instead of silently replacing them', () => {
    // An existing exemption was a decision. Overwriting its reason erases why.
    const withExempt = [...people, {
      id: 5, flat: '6A', name: 'Meera', relationship: 'owner', active: 1,
      late_fee_exempt_until: '2026-11-30', late_fee_exempt_reason: 'Meter dispute',
    }];
    const r = resolveExemptionTargets('6A', withExempt, { today: '2026-08-09' });
    expect(r.already[0]).toMatchObject({ flat: '6A', reason: 'Meter dispute' });
    expect(r.targets).toHaveLength(1);
  });

  it('does not flag an exemption that has already expired', () => {
    const stale = [{ id: 5, flat: '6A', name: 'M', relationship: 'owner', active: 1,
                     late_fee_exempt_until: '2026-01-01' }];
    expect(resolveExemptionTargets('6A', stale, { today: '2026-08-09' }).already).toEqual([]);
  });

  it('de-duplicates a flat listed twice', () => {
    expect(go('4A 4A 4a').targets).toHaveLength(1);
  });

  it('has nothing to do with an empty input', () => {
    expect(go('').ok).toBe(false);
  });
});
