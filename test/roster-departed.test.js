/**
 * The departed resident who cannot be imported twice.
 *
 * `owners.mobile` is NOT NULL UNIQUE across every row, active or not, and
 * planDeparture deactivates people rather than deleting them — deliberately,
 * so the history survives. That makes a departed resident's number still
 * taken. previewRoster used to skip inactive people when building its
 * duplicate-mobile map, so the two most ordinary re-imports in a building —
 * a tenant coming back, and a tenant moving to another flat in the same
 * block — passed the preview as importable and were refused by the constraint
 * at INSERT, half way through creating the building.
 *
 * Blocked rather than warned, and the reason is not taste. Warnings do not
 * stop an import: `canImport` is `blocked.length === 0`, and public/js/
 * admin-roster.js renders warnings as notes above an enabled button. A warning
 * here would have changed the wording of the screen and nothing else — the
 * paste would still have reached the INSERT that cannot take it.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { previewRoster, parseRoster } from '../functions/lib/roster.js';

const departed = {
  flat: '4B', name: 'Ravi Nair', mobile: '+919000000002', relationship: 'tenant', active: 0,
};
const living = {
  flat: '4A', name: 'Meera Das', mobile: '+919000000001', relationship: 'owner', active: 1,
};

const preview = (text, people, flats = ['4A', '4B', '5C']) =>
  previewRoster(parseRoster(text).rows, { existingFlats: flats, existingPeople: people });

describe('a departed resident still owns their mobile number', () => {
  it('blocks the tenant who moved to another flat in the same building', () => {
    // THE LOAD-BEARING CASE. This was `canImport: true, blocked: []`.
    const p = preview('5C\tRavi Nair\t9000000002\ttenant', [departed]);

    expect(p.canImport).toBe(false);
    expect(p.blocked).toHaveLength(1);
    expect(p.create).toHaveLength(0);
    expect(p.blocked[0].reason).toMatch(/Ravi Nair/);
    expect(p.blocked[0].reason).toMatch(/4B/);
  });

  it('blocks the tenant coming back to the flat they left', () => {
    const p = preview('4B\tRavi Nair\t9000000002\ttenant', [departed]);
    expect(p.canImport).toBe(false);
    expect(p.blocked).toHaveLength(1);
  });

  it('catches the number however it was typed', () => {
    // The stored row is E.164; a committee spreadsheet is whatever the phone
    // showed. Both have to reach the same ten digits or the check is decorative.
    for (const typed of ['9000000002', '+919000000002', '+91 90000 00002', '09000000002']) {
      const p = preview(`5C\tRavi Nair\t${typed}\ttenant`, [departed]);
      expect(p.blocked, typed).toHaveLength(1);
    }
  });

  it('says the person has left, and marks the row so the screen can say where', () => {
    // A departed clash is not fixed by editing the paste — the row exists and
    // wants reactivating — so it is worded and flagged differently from a
    // clash with somebody who is still living here.
    const p = preview('5C\tRavi Nair\t9000000002\ttenant', [departed]);
    expect(p.blocked[0].departed).toBe(true);
    expect(p.blocked[0].from).toBe('4B');
    expect(p.blocked[0].reason).toMatch(/left/);
  });

  it('still words an active clash as an active clash', () => {
    const p = preview('5C\tSomebody Else\t9000000001\towner', [living]);
    expect(p.blocked[0].reason).toBe('That mobile already belongs to Meera Das in 4A.');
    expect(p.blocked[0].departed).toBeUndefined();
  });

  it('leaves a paste that clashes with nobody importable', () => {
    const p = preview('5C\tNew Person\t9000000009\ttenant\n5C\tOwner Person\t9000000008\towner',
                      [departed, living]);
    expect(p.blocked).toEqual([]);
    expect(p.canImport).toBe(true);
  });
});

describe('the household checks stay about who lives here now', () => {
  it('does not count a departed tenant as the flat\'s tenant', () => {
    // The mobile map and the household map answer different questions. Folding
    // inactive people into both would block a new tenant from moving into a
    // flat whose last tenant left, which is the normal course of events.
    const p = preview('4B\tNew Tenant\t9000000007\ttenant', [departed]);
    expect(p.blocked).toEqual([]);
    expect(p.canImport).toBe(true);
  });

  it('does not let a departed owner satisfy the tenant-with-no-owner warning', () => {
    const goneOwner = { ...departed, relationship: 'owner' };
    const p = preview('4B\tNew Tenant\t9000000007\ttenant', [goneOwner]);
    expect(p.warnings.some((w) => /no owner/.test(w.message))).toBe(true);
  });
});

describe('the import writes as one transaction', () => {
  // Asserted against source, in the idiom of roster-superadmin.test.js: this
  // suite has no D1. What matters is that the write is a batch and not a loop
  // of awaits — a mid-loop refusal used to leave the building half created,
  // with no record of where it stopped.
  const router = readFileSync('functions/index.js', 'utf8');
  const body = router.match(/async function rosterImport\([\s\S]*?\n}/)?.[0];

  it('has a rosterImport to read', () => {
    expect(body).toBeTruthy();
  });

  it('sends the writes as a single DB.batch', () => {
    expect(body).toMatch(/env\.DB\.batch\(statements\)/);
  });

  it('runs nothing statement by statement inside the loop', () => {
    expect(body).not.toMatch(/await env\.DB\.prepare/);
    expect(body).not.toMatch(/await addFlat\(/);
  });
});
