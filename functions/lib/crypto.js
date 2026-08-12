/**
 * PBKDF2-SHA256 via Web Crypto — native in Workers.
 *
 * Chosen over bcrypt/argon2 because those need WASM and fight the free tier's
 * 10 ms CPU ceiling.
 *
 * ON THE ITERATION COUNT — SETTLED 2026-08-12, DO NOT REOPEN WITHOUT READING.
 *
 * 100000 is below OWASP's PBKDF2-SHA256 guidance of 600000, and it cannot be
 * raised. Cloudflare's runtime refuses any value above 100000:
 *
 *   NotSupportedError: Pbkdf2 failed: iteration counts above 100000 are not
 *   supported (requested 200000).
 *
 * That is the whole answer to the old `NOTE (plan §4b)`, which asked for a
 * measurement against the CPU budget. The measurement was taken and says there
 * is room: one derive costs ~27 ms on the edge (~7 ms on an M-series Mac, so
 * the edge is ~3.8x slower), and a 32 ms login returns outcome "ok" — three
 * times the 10 ms figure this comment used to worry about. The budget was
 * never the binding constraint. The platform is, and no amount of CPU headroom
 * buys a way around it.
 *
 * TWO THINGS THAT MADE THIS EXPENSIVE TO LEARN, both worth remembering:
 *
 *   `wrangler dev --local` does not enforce the cap. A probe accepted 600000
 *   without complaint. The failure appears for the first time on a deployed
 *   URL, so a green suite and a clean local run prove nothing about it.
 *
 *   The failure mode is total: every login 500s, including the superadmin's.
 *   What made it a ten-minute rollback instead of a lockout was migration
 *   0025 — hashes carry their own count, so nothing written at 100000 was ever
 *   in danger. That migration keeps earning its place even though the raise it
 *   was built for turned out to be impossible; it is also what would make a
 *   future move to a different KDF survivable.
 *
 * If stronger hashing is genuinely wanted, the lever is scrypt or argon2 via
 * WASM — rejected at the top of this file for reasons that still hold, but
 * rejected on ITS merits, not by conflating it with an iteration count nobody
 * can change. test/deploy-config.test.js fails on any value above 100000.
 */

export const DEFAULT_ITERATIONS = 100_000;
const KEY_BITS = 256;
const SALT_BYTES = 16;

const enc = new TextEncoder();

export function toBase64(bytes) {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s);
}

export function fromBase64(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function randomSalt() {
  return crypto.getRandomValues(new Uint8Array(SALT_BYTES));
}

export async function derive(password, salt, iterations = DEFAULT_ITERATIONS) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    key,
    KEY_BITS
  );
  return new Uint8Array(bits);
}

/**
 * Returns the iteration count along with the hash, because the count is part
 * of the hash's meaning: it is only reproducible at the number that made it.
 * Every caller stores all three, so raising the target later upgrades new
 * hashes without invalidating old ones. See migration 0025.
 */
export async function hashPassword(password, iterations = DEFAULT_ITERATIONS) {
  const salt = randomSalt();
  const hash = await derive(password, salt, iterations);
  return { hash: toBase64(hash), salt: toBase64(salt), iterations };
}

/** Constant-time compare — never short-circuit on the first differing byte. */
export function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function verifyPassword(password, storedHashB64, storedSaltB64, iterations = DEFAULT_ITERATIONS) {
  const candidate = await derive(password, fromBase64(storedSaltB64), iterations);
  return timingSafeEqual(candidate, fromBase64(storedHashB64));
}

export function newSessionToken() {
  return toBase64(crypto.getRandomValues(new Uint8Array(32)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Say-able one-time password: no ambiguous characters (0/O, 1/l/I), readable
 * down a phone line. Format `pine-4417`, or `pine-teak-moss-441742` when
 * `strong`.
 *
 * WHY THIS IS THE CREDENTIAL WORTH COUNTING BITS ON. It is the only one in the
 * system deliberately sent in the clear — read out on a call or pasted into
 * WhatsApp — and it is a working password for the account until the resident
 * replaces it. A password policy governs what someone CHOOSES; this is what
 * their account actually holds until they get round to choosing.
 *
 * WHY THE WORD LIST GREW FROM 16 TO 64. The digits were carrying the whole
 * thing: 16 words × 8^4 is about 16 bits, and 16 bits behind a rate limiter
 * of 5 attempts per 15 minutes is thinner than it looks once the temporary
 * password can sit unused for weeks. Four times the words costs nothing to say
 * and buys two bits; the strong form buys the rest.
 *
 * WHY ADMINS GET THE LONGER FORM. Three words and six digits is ~36 bits
 * against ~18 — noticeably more to read down a phone, which is why it is not
 * the default for 99 households, and trivially worth it for the handful of
 * accounts that can reach the god console. See resetPassword.
 *
 * NOT HANDLED HERE: expiry. On main a temporary password still works forever,
 * and the WhatsApp message carrying it outlives the handset. That is backlog
 * B10, and it is already built on the unmerged `b21-credential-decision`
 * branch (`pw_expires_at`, migration 0023 there). Entropy and expiry are
 * separate defences; this file only supplies the first, deliberately, so the
 * two can land independently.
 */
const WORDS = [
  'pine', 'teak', 'mango', 'palm', 'reef', 'kite', 'dune', 'moss',
  'wave', 'fern', 'clay', 'jade', 'rain', 'sand', 'oak', 'lime',
  'iron', 'gold', 'rust', 'silk', 'wool', 'rope', 'nest', 'barn',
  'gate', 'lamp', 'door', 'roof', 'brick', 'stone', 'river', 'creek',
  'ridge', 'cliff', 'cave', 'marsh', 'field', 'grove', 'birch', 'cedar',
  'maple', 'olive', 'lotus', 'tulip', 'daisy', 'reed', 'coral', 'pearl',
  'amber', 'onyx', 'slate', 'flint', 'copper', 'zinc', 'indigo', 'violet',
  'melon', 'guava', 'papaya', 'ginger', 'pepper', 'clove', 'honey', 'wheat',
];

/** Digits 2–9 only: 0/1 are the ones misheard as O and I over a phone. */
const DIGITS = '23456789';

/**
 * `strong` is for accounts that can administer the building. Everyone else
 * gets the short form, because a code nobody can read out accurately is a
 * code the treasurer reads out wrongly.
 */
export function generateOneTimePassword({ strong = false } = {}) {
  const wordCount = strong ? 3 : 1;
  const digitCount = strong ? 6 : 4;

  const buf = crypto.getRandomValues(new Uint32Array(wordCount + digitCount));
  const parts = [];
  for (let i = 0; i < wordCount; i++) parts.push(WORDS[buf[i] % WORDS.length]);

  let digits = '';
  for (let i = 0; i < digitCount; i++) digits += DIGITS[buf[wordCount + i] % DIGITS.length];

  return `${parts.join('-')}-${digits}`;
}
