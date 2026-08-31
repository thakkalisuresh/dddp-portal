/**
 * The rule that decides every password in the building, and had no test.
 *
 * `checkPassword` is the gate on three separate paths — onboarding, the profile
 * change, and reset-with-code — and it runs twice on each, once in the browser
 * for the message and once in the Worker for the decision. Both sides import
 * this same file precisely so they cannot drift, which makes it the one place
 * where a change is felt by all six.
 *
 * What is asserted here is the SHAPE of the policy rather than its wording:
 * that a rule exists, in what order it fires, and which passwords it must
 * refuse. Wording is allowed to change; "eight characters is enough" is not.
 */

import { describe, it, expect } from 'vitest';
import { checkPassword, personalTokens, policyFor, POLICY }
  from '../public/js/password-rules.js';

/** The account a roster import creates, as onboarding sees it. */
const RESIDENT = {
  role: 'owner', name: 'Priya Menon', mobile: '+919846400002',
  email: 'priya.menon@gmail.com', flat: '5C',
};

const ok = (pw, user = RESIDENT) => expect(checkPassword(pw, user)).toBeNull();
const bad = (pw, user = RESIDENT) => {
  const problem = checkPassword(pw, user);
  expect(problem).not.toBeNull();
  return problem;
};

describe('the tiers', () => {
  it('asks more of an admin than of an owner, because the blast radius differs', () => {
    expect(POLICY.admin.minLength).toBeGreaterThan(POLICY.owner.minLength);
    expect(POLICY.admin.requireUpper).toBe(true);
    expect(POLICY.owner.requireUpper).toBe(false);
  });

  it('treats a superadmin as an admin, not as an owner', () => {
    expect(policyFor('superadmin')).toEqual(POLICY.admin);
  });

  it('falls back to the owner tier for a role it does not know', () => {
    // The safe default for a caller with no account in hand. Falling back to
    // the ADMIN tier would refuse ordinary residents instead.
    expect(policyFor(undefined)).toEqual(POLICY.owner);
    expect(policyFor('committee')).toEqual(POLICY.owner);
  });
});

describe('what it accepts', () => {
  it('takes an ordinary resident password', () => {
    ok('harbour-lime-9182');
  });

  it('takes a passphrase, because a space counts as the symbol', () => {
    // The rule is number OR symbol, and a space is a symbol on purpose: it is
    // what makes a phrase a legitimate answer rather than something to work
    // around. Without this, the rule pushes everyone to the phone keyboard's
    // symbol row and produces Diamond@2024.
    ok('two blue lemons');
  });

  it('does not require an uppercase letter from a resident', () => {
    ok('quiet-harbour-77');
  });
});

describe('length is reported before content', () => {
  it('refuses seven characters for an owner', () => {
    expect(bad('ab3!xyz').code).toBe('DDP-AUTH-008');
  });

  it('accepts exactly the minimum', () => {
    ok('ab3!xyzq');
    expect('ab3!xyzq'.length).toBe(POLICY.owner.minLength);
  });

  it('names length first when a password is both too short AND too plain', () => {
    // Order matters: telling somebody their six-character password needs a
    // number sends them to fix the wrong thing, and they come back still short.
    expect(bad('abcdef').code).toBe('DDP-AUTH-008');
  });

  it('holds an admin to the longer minimum', () => {
    const admin = { ...RESIDENT, role: 'admin', name: 'Rajesh Pillai', flat: '1E' };
    expect(bad('Ab3!xyzq', admin).code).toBe('DDP-AUTH-008');
    ok('Ab3!xyzqrstu', admin);
  });

  it('asks an admin for a capital only once the length is satisfied', () => {
    const admin = { ...RESIDENT, role: 'admin', name: 'Rajesh Pillai', flat: '1E' };
    expect(bad('ab3!xyzqrstu', admin).code).toBe('DDP-AUTH-014');
  });
});

describe('number or symbol, never both', () => {
  it('refuses letters alone', () => {
    expect(bad('harbourlime').code).toBe('DDP-AUTH-013');
  });

  it('accepts a number without a symbol', () => {
    ok('harbourlime9');
  });

  it('accepts a symbol without a number', () => {
    ok('harbour-lime!');
  });
});

describe('the blocklist, which is the part that stops real guesses', () => {
  it('refuses the resident\'s own name', () => {
    expect(bad('priya-2026').code).toBe('DDP-AUTH-015');
  });

  it('refuses a surname on its own, since a first name is guessable alone', () => {
    expect(bad('menon-98765').code).toBe('DDP-AUTH-015');
  });

  it('refuses the flat, the mobile, and the last six digits of it', () => {
    const withFlat = { ...RESIDENT, flat: '12F' };
    expect(bad('open12Fnow', withFlat).code).toBe('DDP-AUTH-015');
    expect(bad('919846400002x').code).toBe('DDP-AUTH-015');
    expect(bad('lemon400002').code).toBe('DDP-AUTH-015');
  });

  it('refuses the email local part but not the provider', () => {
    // Banning "gmail" would refuse a large share of innocent passwords.
    expect(bad('priya.menon!1').code).toBe('DDP-AUTH-015');
    ok('gmail-harbour-9');
  });

  it('refuses what this building specifically reaches for first', () => {
    for (const pw of ['diamondpark1', 'gasportal99', 'dddp-2026!', 'password123']) {
      expect(bad(pw).code).toBe('DDP-AUTH-015');
    }
  });

  it('does not name which token matched', () => {
    // On the reset screen that would confirm a name or a flat to whoever is
    // holding the phone.
    const m = bad('priya-2026').message;
    expect(m).not.toMatch(/priya|menon|5C|9846400002/i);
  });

  it('judges the details arriving in THIS request, not the roster\'s guesses', () => {
    // Onboarding sets name, email and password in one call. Reading the stored
    // row would let somebody type their name into both fields and sail through.
    const asTyped = { ...RESIDENT, name: 'Priya Menon' };
    expect(bad('priya menon!', asTyped).code).toBe('DDP-AUTH-015');
  });
});

describe('personalTokens', () => {
  it('splits a name on anything non-alphabetic', () => {
    expect(personalTokens({ name: 'Anoop K. Nair' })).toEqual(
      expect.arrayContaining(['anoop', 'nair']));
  });

  it('drops tokens under three characters, or a flat would ban a digit', () => {
    // A flat called "7" would otherwise refuse every password containing one.
    expect(personalTokens({ flat: '7', name: 'K' })).toEqual([]);
  });

  it('keeps the last six digits of a mobile but not the last four', () => {
    const tokens = personalTokens({ mobile: '+919846400002' });
    expect(tokens).toContain('400002');
    expect(tokens).not.toContain('0002');
  });

  it('survives an account with nothing on it', () => {
    expect(personalTokens()).toEqual([]);
    expect(personalTokens({})).toEqual([]);
  });
});

describe('the inputs it must not choke on', () => {
  it('treats a missing password as too short rather than throwing', () => {
    expect(bad(undefined).code).toBe('DDP-AUTH-008');
    expect(bad(null).code).toBe('DDP-AUTH-008');
    expect(bad('').code).toBe('DDP-AUTH-008');
  });

  it('applies the owner tier with no blocklist when given no account', () => {
    expect(checkPassword('harbour-lime-9182', undefined)).toBeNull();
    expect(checkPassword('short', undefined).code).toBe('DDP-AUTH-008');
  });
});
