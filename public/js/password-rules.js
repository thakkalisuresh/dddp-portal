/**
 * What counts as an acceptable password, in one place.
 *
 * Lives under public/ because the browser and the Worker must agree. The
 * client check exists to give a useful message before a round trip; the
 * server check is the one that decides. Same file, so they cannot drift.
 * (`countries.js` is imported by the Worker the same way.)
 *
 * The shape of the policy, and why it is this shape:
 *
 * - **Length is tiered by role, not by taste.** An admin can impersonate a
 *   resident, edit a bill and reach the god console; an owner can look at
 *   their own gas bill. The blast radius differs, so the bar differs. It also
 *   puts the friction on the three people who log in weekly instead of the 99
 *   who log in twice a year.
 *
 * - **Number OR symbol, never both.** Requiring both is what produces
 *   `Diamond@2024` — the rule shapes the password more than the user does.
 *   Requiring one kills the bare dictionary word without pushing anyone into
 *   the symbol row of a phone keyboard. A space counts, so a passphrase like
 *   `two blue lemons` passes on its own merits.
 *
 * - **Uppercase for admins only.** Same reasoning as the length: a rule that
 *   is a nuisance across 99 households is a triviality across three.
 *
 * - **A blocklist, because it is the part that actually stops guesses.** The
 *   passwords that get broken here are not the ones missing a symbol, they
 *   are the ones that are the resident's own name, their flat, or their
 *   mobile number. Composition rules never catch those; this does.
 *
 * Known limit: matching is plain lowercased substring, so `An00p123` gets
 * past the name check. Catching that needs leet-folding, which brings false
 * positives of its own. The blocklist is a floor, not a filter.
 */

export const POLICY = {
  owner:      { minLength: 8,  requireUpper: false },
  admin:      { minLength: 12, requireUpper: true },
  superadmin: { minLength: 12, requireUpper: true },
};

export function policyFor(role) {
  return POLICY[role] ?? POLICY.owner;
}

/**
 * Passwords too well known to be worth anyone's time, plus the ones this
 * building specifically will reach for. Kept short deliberately: a long list
 * is a false sense of security, and the real defence is the login rate
 * limiter. Everything here is lowercase and at least MIN_TOKEN long.
 */
const COMMON = [
  'password', 'passw0rd', 'p@ssword', '12345678', '123456789', '1234567890',
  'qwerty', 'qwertyuiop', 'letmein', 'welcome', 'iloveyou', 'admin123',
  'abc123', 'football', 'monkey', 'dragon', 'sunshine', 'princess',
  // The ones a resident of this building reaches for first.
  'diamondpark', 'diamond', 'dddp', 'gasbill', 'gasportal', 'portal',
];

/**
 * Below three characters a token bans more than it protects — a flat called
 * "7" would refuse every password containing a seven.
 */
const MIN_TOKEN = 3;

/**
 * Everything about this account that an attacker could read off the roster.
 *
 * Name is split on anything non-alphabetic so "Anoop K. Nair" contributes
 * three separate tokens: a first name is guessable on its own.
 */
export function personalTokens({ name, mobile, email, flat } = {}) {
  const tokens = [];

  for (const part of String(name ?? '').split(/[^a-zA-Z]+/)) tokens.push(part);

  const digits = String(mobile ?? '').replace(/\D/g, '');
  if (digits) {
    tokens.push(digits);
    // The last six are what people actually use; the country code is not the
    // memorable part. Six rather than four — four digits collide with too
    // many innocent passwords to be worth refusing.
    if (digits.length > 6) tokens.push(digits.slice(-6));
  }

  // Only the local part. Banning "gmail" would be absurd.
  const local = String(email ?? '').split('@')[0];
  if (local) tokens.push(local);

  tokens.push(String(flat ?? ''));

  return tokens
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length >= MIN_TOKEN);
}

/**
 * Returns null when the password is acceptable, or `{ code, message }`
 * describing the first thing wrong with it.
 *
 * Order matters: length is reported before content, because telling someone
 * their six-character password needs an uppercase letter sends them off to
 * fix the wrong thing.
 */
export function checkPassword(password, user = {}) {
  const pw = String(password ?? '');
  const policy = policyFor(user.role);

  if (pw.length < policy.minLength) {
    return {
      code: 'DDP-AUTH-008',
      message: policy.minLength > POLICY.owner.minLength
        ? `Admin accounts need at least ${policy.minLength} characters.`
        : `Use at least ${policy.minLength} characters.`,
    };
  }

  // A space is a symbol here on purpose — it is what makes a passphrase a
  // legitimate answer to this rule rather than something to work around.
  if (!/[0-9]/.test(pw) && !/[^A-Za-z0-9]/.test(pw)) {
    return {
      code: 'DDP-AUTH-013',
      message: 'Include a number or a symbol. A space counts, so a short phrase works.',
    };
  }

  if (policy.requireUpper && !/[A-Z]/.test(pw)) {
    return {
      code: 'DDP-AUTH-014',
      message: 'Admin accounts need at least one capital letter.',
    };
  }

  const lower = pw.toLowerCase();
  const banned = [...COMMON, ...personalTokens(user)];
  if (banned.some((token) => lower.includes(token))) {
    return {
      code: 'DDP-AUTH-015',
      // Deliberately does not say WHICH token matched. On the reset screen
      // that would confirm a name or a flat to whoever is holding the phone.
      message: 'That password contains something easy to guess. Avoid your name, '
             + 'flat, mobile number, and words like "password".',
    };
  }

  return null;
}

/** The rule, in the words the field hint uses. */
export function describePolicy(role) {
  const policy = policyFor(role);
  const parts = [`At least ${policy.minLength} characters`, 'with a number or symbol'];
  if (policy.requireUpper) parts.push('and a capital letter');
  return `${parts.join(', ')}. Not your name, flat or mobile number.`;
}
