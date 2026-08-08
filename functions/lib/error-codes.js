/**
 * Single registry of every error code. docs/ERROR_CODES.md is GENERATED from
 * this file (`npm run errdoc`) and drift-tested, so the docs cannot rot.
 *
 * severity routing (see lib/errors.js):
 *   fatal | error -> Telegram immediately
 *   warn          -> daily digest
 *   all           -> error_log table, visible under god mode
 */

export const SEVERITIES = ['fatal', 'error', 'warn'];

/** A retired code no longer fires, but still resolves for historical log rows. */
export function isRetired(code) {
  return ERROR_CODES[code]?.retired === true;
}

export const ERROR_CODES = {
  // ── AUTH ───────────────────────────────────────────────────────────────
  'DDP-AUTH-001': { severity: 'warn',  message: 'Login failed — unknown mobile number' },
  'DDP-AUTH-002': { severity: 'warn',  message: 'Login failed — wrong password' },
  'DDP-AUTH-003': { severity: 'warn',  message: 'Login rate limit tripped' },
  'DDP-AUTH-004': { severity: 'error', message: 'Session token present but no matching session row' },
  'DDP-AUTH-005': { severity: 'error', message: 'Password hash verify threw', planned: true },
  'DDP-AUTH-006': { severity: 'warn',  message: 'Password reset requested for unknown mobile' },
  'DDP-AUTH-007': { severity: 'error', message: 'Impersonated session attempted a credential change' },

  // ── BILL ───────────────────────────────────────────────────────────────
  'DDP-BILL-001': { severity: 'error', message: 'Bill generation found no reading for an active flat' },
  'DDP-BILL-002': { severity: 'error', message: 'Reading lower than previous reached generation' },
  'DDP-BILL-003': { severity: 'fatal', message: 'Bill total does not match its own components' },
  // Retired with the paise tag. Kept so an old error_log row still resolves to
  // a meaning instead of rendering as a bare code nobody can look up.
  'DDP-BILL-004': { severity: 'fatal', retired: true,
                    message: 'Bill total paise do not match the flat paise_tag (retired — paise tags removed)' },
  'DDP-BILL-005': { severity: 'error', message: 'Period has no rate set' },
  'DDP-BILL-006': { severity: 'error', message: 'Duplicate bill for (flat, period)' },
  'DDP-BILL-007': { severity: 'error', message: 'Generation attempted on a locked period' },
  'DDP-BILL-008': { severity: 'error', message: 'Late fee is negative or not a number' },
  'DDP-BILL-009': { severity: 'error', message: 'Late fee cron re-applied to an already-charged bill' },
  'DDP-BILL-010': { severity: 'fatal', message: 'Rate was inherited from a previous period instead of set for this one' },
  'DDP-BILL-011': { severity: 'warn',  message: 'Rate differs sharply from the previous period' },

  // ── PAY ────────────────────────────────────────────────────────────────
  'DDP-PAY-001': { severity: 'error', message: 'UPI URI requested for a bill that does not exist' },
  'DDP-PAY-002': { severity: 'error', message: 'UPI URI built with a null or non-finite amount' },
  'DDP-PAY-003': { severity: 'error', message: 'Payment intent logged against a paid bill' },
  'DDP-PAY-004': { severity: 'warn',  message: 'UPI payee VPA missing from environment' },
  'DDP-PAY-005': { severity: 'error', message: 'QR requested with no URI to encode' },

  // ── PROOF ──────────────────────────────────────────────────────────────
  'DDP-PROOF-001': { severity: 'warn',  message: 'Duplicate screenshot rejected — image hash already seen' },
  'DDP-PROOF-002': { severity: 'warn',  message: 'Duplicate UTR rejected — already used on another bill' },
  'DDP-PROOF-003': { severity: 'error', message: 'Vision parse returned nothing usable' },
  'DDP-PROOF-004': { severity: 'fatal', message: 'R2 upload succeeded but D1 insert failed — orphaned object' },
  'DDP-PROOF-005': { severity: 'error', message: 'Proof image missing from R2 but row says stored' },
  'DDP-PROOF-006': { severity: 'warn',  message: 'Uploaded amount does not match the bill' },
  'DDP-PROOF-007': { severity: 'warn',  message: 'Vision provider returned an error status' },

  // ── ADMIN ──────────────────────────────────────────────────────────────
  'DDP-ADMIN-001': { severity: 'error', message: 'Bulk import parsed a flat that does not exist' },
  'DDP-ADMIN-002': { severity: 'error', message: 'Bulk import attempted a direct write, bypassing draft review', planned: true },
  'DDP-ADMIN-003': { severity: 'warn',  message: 'Roster CSV row skipped — malformed' },
  'DDP-ADMIN-004': { severity: 'error', message: 'Non-admin reached an admin route' },
  'DDP-ADMIN-005': { severity: 'warn',  message: 'Flat transfer blocked — the outgoing owner has unpaid bills' },
  'DDP-ADMIN-006': { severity: 'fatal', message: 'Role change refused — it would leave no superadmin' },
  'DDP-ADMIN-007': { severity: 'error', message: 'Flat label has no leading floor number' },
  'DDP-ADMIN-008': { severity: 'fatal', message: 'Flat limit reached — the retired paise column caps the table at 99' },

  // ── SYS ────────────────────────────────────────────────────────────────
  'DDP-SYS-001': { severity: 'fatal', message: 'Unhandled exception in a Worker route' },
  'DDP-SYS-002': { severity: 'fatal', message: 'D1 query failed', planned: true },
  'DDP-SYS-003': { severity: 'error', message: 'Nightly Drive backup failed' },
  'DDP-SYS-004': { severity: 'error', message: 'Telegram alert delivery failed', planned: true },
  'DDP-SYS-005': { severity: 'fatal', message: 'Telegram binding missing at startup — alerts are inert' },
  'DDP-SYS-008': { severity: 'fatal', message: 'Google refresh token rejected — the nightly backup is dead' },
  'DDP-SYS-007': { severity: 'warn',  message: 'Nightly run summary — late fees applied or payments left unconfirmed' },
  'DDP-SYS-006': { severity: 'warn',  message: 'Alert rate limit reached; further alerts suppressed this window' },

  // ── NOTICE ─────────────────────────────────────────────────────────────
  'DDP-NOTICE-001': { severity: 'warn',  message: 'Comment or notice not found' },
  'DDP-NOTICE-002': { severity: 'warn',  message: 'Comment posted to a notice that has comments switched off' },
  'DDP-NOTICE-003': { severity: 'warn',  message: 'Comment rejected — empty or too long' },
  'DDP-NOTICE-004': { severity: 'warn',  message: 'Comment rate limit reached' },
};

/** Domains in registry order, for the generated docs. */
export const DOMAINS = ['AUTH', 'BILL', 'PAY', 'PROOF', 'NOTICE', 'ADMIN', 'SYS'];

export function domainOf(code) {
  return code.split('-')[1];
}

export function isKnownCode(code) {
  return Object.hasOwn(ERROR_CODES, code);
}
