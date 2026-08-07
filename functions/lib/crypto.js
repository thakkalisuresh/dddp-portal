/**
 * PBKDF2-SHA256 via Web Crypto — native in Workers.
 *
 * Chosen over bcrypt/argon2 because those need WASM and fight the free tier's
 * 10 ms CPU ceiling. NOTE (plan §4b): measure DEFAULT_ITERATIONS against the
 * real CPU budget before launch; if it doesn't fit, lower it. For ~50 residents
 * behind a login rate limiter that is an acceptable trade.
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

export async function hashPassword(password, iterations = DEFAULT_ITERATIONS) {
  const salt = randomSalt();
  const hash = await derive(password, salt, iterations);
  return { hash: toBase64(hash), salt: toBase64(salt) };
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
 * down a phone line. Format `pine-4417`.
 */
const WORDS = [
  'pine', 'teak', 'mango', 'palm', 'reef', 'kite', 'dune', 'moss',
  'wave', 'fern', 'clay', 'jade', 'rain', 'sand', 'oak', 'lime',
];

/** Digits 2–9 only: 0/1 are the ones misheard as O and I over a phone. */
const DIGITS = '23456789';

export function generateOneTimePassword() {
  const buf = crypto.getRandomValues(new Uint32Array(5));
  const word = WORDS[buf[0] % WORDS.length];
  let digits = '';
  for (let i = 1; i <= 4; i++) digits += DIGITS[buf[i] % DIGITS.length];
  return `${word}-${digits}`;
}
