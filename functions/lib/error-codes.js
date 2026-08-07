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
  'DDP-BILL-004': { severity: 'fatal', message: 'Bill total paise do not match the flat paise_tag' },
  'DDP-BILL-005': { severity: 'error', message: 'Period has no rate set' },
  'DDP-BILL-006': { severity: 'error', message: 'Duplicate bill for (flat, period)' },
  'DDP-BILL-007': { severity: 'error', message: 'Generation attempted on a locked period' },
  'DDP-BILL-008': { severity: 'fatal', message: 'Late fee carries paise — reconciliation would break' },
  'DDP-BILL-009': { severity: 'error', message: 'Late fee cron re-applied to an already-charged bill', planned: true },
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

  // ── SYS ────────────────────────────────────────────────────────────────
  'DDP-SYS-001': { severity: 'fatal', message: 'Unhandled exception in a Worker route' },
  'DDP-SYS-002': { severity: 'fatal', message: 'D1 query failed', planned: true },
  'DDP-SYS-003': { severity: 'error', message: 'Nightly Drive backup failed', planned: true },
  'DDP-SYS-004': { severity: 'error', message: 'Telegram alert delivery failed', planned: true },
  'DDP-SYS-005': { severity: 'fatal', message: 'Telegram binding missing at startup — alerts are inert' },
  'DDP-SYS-006': { severity: 'warn',  message: 'Alert rate limit reached; further alerts suppressed this window' },
};

/** Domains in registry order, for the generated docs. */
export const DOMAINS = ['AUTH', 'BILL', 'PAY', 'PROOF', 'ADMIN', 'SYS'];

export function domainOf(code) {
  return code.split('-')[1];
}

export function isKnownCode(code) {
  return Object.hasOwn(ERROR_CODES, code);
}
