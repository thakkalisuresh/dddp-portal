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
  'DDP-AUTH-008': { severity: 'warn',  message: 'New password rejected — too short' },
  'DDP-AUTH-009': { severity: 'warn',  message: 'Reset code rejected — wrong, expired or already used' },
  'DDP-AUTH-010': { severity: 'warn',  message: 'Reset codes requested too often for one account' },
  'DDP-AUTH-011': { severity: 'error', message: 'Reset requested for an account with no email on file' },
  'DDP-AUTH-012': { severity: 'warn',  message: 'Login refused — temporary password had expired' },
  'DDP-AUTH-013': { severity: 'warn',  message: 'New password rejected — no number or symbol' },
  'DDP-AUTH-014': { severity: 'warn',  message: 'New password rejected — admin policy needs a capital letter' },
  'DDP-AUTH-015': { severity: 'warn',  message: 'New password rejected — contains personal or predictable text' },
  // Not fatal to the resident — they are logged in. It means their stored hash
  // is still at the old iteration count and will be retried next login. Worth
  // seeing, because every login failing to upgrade is a silently stalled
  // migration.
  'DDP-AUTH-016': { severity: 'warn',  message: 'Password re-hash at the new iteration count failed' },
  // Worth seeing rather than merely refusing. A burst of these on the forced
  // first-login change means residents are being told to pick a new password
  // and reaching for the one in the message — which is a signal about the
  // screen's wording, not about any one resident.
  'DDP-AUTH-017': { severity: 'warn',  message: 'New password rejected — same as the password already on the account' },
  // Distinct from 017 on purpose. 017 means they typed what they are holding
  // right now — usually the temporary password, and usually a misread of the
  // screen. 018 means they reached back for one they had abandoned, which is
  // a different habit and worth being able to count separately.
  'DDP-AUTH-018': { severity: 'warn',  message: 'New password rejected — used before, still within the history depth' },

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
  // WARN, not error. This fires when somebody saves a reading or presses
  // Generate on a month that is already closed — a person doing an ordinary
  // thing against a locked month, not a fault in the system. At `error` it went
  // to Telegram on every occurrence, and on 2026-08-14 a client retrying a save
  // into a locked July put 56 alerts on the treasurer's phone in one minute.
  // Same reasoning that retired DDP-BILL-011: normal business is not an error.
  'DDP-BILL-007': { severity: 'warn', message: 'Reading or generation attempted on a locked period' },
  'DDP-BILL-008': { severity: 'error', message: 'Late fee is negative, fractional or not a number' },
  'DDP-BILL-009': { severity: 'error', message: 'Late fee cron re-applied to an already-charged bill' },
  'DDP-BILL-010': { severity: 'fatal', message: 'Rate was inherited from a previous period instead of set for this one' },
  // Retired: a rate change is normal business, not an error. The unusual-jump
  // hint still appears in the generation preview, where the treasurer can act
  // on it — it just no longer files itself as a failure.
  'DDP-BILL-011': { severity: 'warn', retired: true,
                    message: 'Rate differs sharply from the previous period (retired — a rate change is not an error)' },

  'DDP-BILL-012': { severity: 'warn',  message: 'Rate change refused — the month is locked' },
  'DDP-BILL-013': { severity: 'warn',  message: 'Rate changed on a month that already has bills — totals recalculated' },
  'DDP-BILL-014': { severity: 'error', message: 'Meter change is not consistent with the readings either side of it' },
  // A bill with no owner_id is readable by whoever occupies the flat next —
  // dashboard.js matches (owner_id IS NULL OR owner_id = ?). Generation refuses
  // rather than writing one, so the month stops instead of the privacy leaking.
  'DDP-BILL-015': { severity: 'error', message: 'Flat has a reading but nobody to bill — the bill would have no owner' },
  // Not a fault: somebody reached for the retired path. `warn` because the
  // interesting number is how often, and by whom — a rising count means a
  // screen somewhere is still offering an amount box.
  'DDP-BILL-016': { severity: 'warn',  message: 'Bill amount edit refused — correct the reading or the month’s price instead' },
  // The month-wide price correction, once bills exist for it. Recorded because
  // every bill in the month moves and already-paid bills can return to unpaid;
  // it is the largest single act on the Billing tab.
  'DDP-BILL-017': { severity: 'warn',  message: 'Published month’s price of gas corrected — every bill recalculated' },
  // The outbox could not tell somebody their bill exists. One row, not the
  // month: the drain carries on and the cron sweeps it again.
  'DDP-BILL-018': { severity: 'warn',  message: 'Bill announcement could not be emailed to the resident' },

  // ── MAIL ───────────────────────────────────────────────────────────────
  'DDP-MAIL-001': { severity: 'error', message: 'Reset email could not be sent' },

  // ── PAY ────────────────────────────────────────────────────────────────
  'DDP-PAY-001': { severity: 'error', message: 'UPI URI requested for a bill that does not exist' },
  'DDP-PAY-002': { severity: 'error', message: 'UPI URI built with a null or non-finite amount' },
  'DDP-PAY-003': { severity: 'error', message: 'Payment intent logged against a paid bill' },
  'DDP-PAY-004': { severity: 'warn',  message: 'UPI payee VPA missing from environment' },
  'DDP-PAY-005': { severity: 'error', message: 'QR requested with no URI to encode' },

  // ── PROOF ──────────────────────────────────────────────────────────────
  'DDP-PROOF-001': { severity: 'warn',  message: 'Duplicate screenshot rejected — image hash already seen' },
  'DDP-PROOF-002': { severity: 'warn',  message: 'Duplicate UTR rejected — already used on another bill' },
  // `warn`, not `error`. This fires whenever a resident photographs a receipt
  // badly, which is a normal Tuesday and not something to wake anyone for. It
  // was `error`, so blurry photographs paged the committee while the outage
  // below said nothing at all — backwards in both directions.
  'DDP-PROOF-003': { severity: 'warn',  message: 'Vision parse returned nothing usable' },
  'DDP-PROOF-004': { severity: 'fatal', message: 'R2 upload succeeded but D1 insert failed — orphaned object' },
  'DDP-PROOF-005': { severity: 'error', message: 'Proof image missing from R2 but row says stored' },
  'DDP-PROOF-006': { severity: 'warn',  message: 'Uploaded amount does not match the bill' },
  // `error`, not `warn`: reportError only pushes to Telegram on error or fatal,
  // so the one event actually worth hearing about was the one kept silent.
  'DDP-PROOF-007': { severity: 'error', message: 'Vision provider returned an error status' },
  'DDP-PROOF-008': { severity: 'error', message: 'Vision is not configured — no provider key bound' },

  // ── RECON ──────────────────────────────────────────────────────────────
  'DDP-RECON-001': { severity: 'error', message: 'Bank statement could not be parsed — no usable table' },
  'DDP-RECON-002': { severity: 'error', message: 'Bank statement parsed but held no credit rows' },
  'DDP-RECON-003': { severity: 'warn',  message: 'Proof claims a payment with no matching credit on the statement' },
  'DDP-RECON-004': { severity: 'warn',  message: 'Credit on the statement with no proof uploaded' },
  'DDP-RECON-005': { severity: 'warn',  message: 'Proof amount and bank credit disagree' },
  'DDP-RECON-006': { severity: 'warn',  message: 'Abandoned statement session swept — rows deleted unreviewed' },
  'DDP-RECON-007': { severity: 'warn',  message: 'PDF statement has no text layer — CSV needed' },
  'DDP-RECON-008': { severity: 'fatal', message: 'Statement rows survived the finish step — deletion did not take' },

  // ── ADMIN ──────────────────────────────────────────────────────────────
  'DDP-ADMIN-001': { severity: 'error', message: 'Bulk import parsed a flat that does not exist' },
  'DDP-ADMIN-002': { severity: 'error', message: 'Bulk import attempted a direct write, bypassing draft review', planned: true },
  'DDP-ADMIN-003': { severity: 'warn',  message: 'Roster CSV row skipped — malformed' },
  'DDP-ADMIN-004': { severity: 'error', message: 'Non-admin reached an admin route' },
  'DDP-ADMIN-005': { severity: 'warn',  message: 'Flat transfer blocked — the outgoing owner has unpaid bills' },
  'DDP-ADMIN-006': { severity: 'fatal', message: 'Role change refused — it would leave no superadmin' },
  'DDP-ADMIN-007': { severity: 'error', message: 'Flat label has no leading floor number' },
  // Retired with the column that caused it. The 99-flat ceiling is gone, which
  // matters because the building has exactly 99 and would have hit it.
  'DDP-ADMIN-008': { severity: 'fatal', retired: true,
                     message: 'Flat limit reached — the retired paise column capped the table at 99 (retired)' },
  'DDP-ADMIN-009': { severity: 'warn',  message: 'Mobile number is not a valid E.164 number' },
  'DDP-ADMIN-010': { severity: 'warn',  message: 'God edit rejected — field or value not allowed' },
  'DDP-ADMIN-011': { severity: 'warn',  message: 'Change needing a reason rejected — no reason given' },
  'DDP-ADMIN-012': { severity: 'error', message: 'God edit would lock the superadmin out of their own account' },
  'DDP-ADMIN-013': { severity: 'warn',  message: 'God edit rejected — mobile or email already belongs to someone else' },
  'DDP-ADMIN-014': { severity: 'error', message: 'Password reset attempted against an equal or higher role' },
  'DDP-ADMIN-015': { severity: 'warn',  message: 'Bill edit approval refused — approver is the requester or the bill is theirs' },
  'DDP-ADMIN-016': { severity: 'error', message: 'Bill edit cannot reach quorum — too few eligible admins' },
  'DDP-ADMIN-017': { severity: 'warn',  message: 'Bill edit request is no longer open' },
  'DDP-ADMIN-018': { severity: 'warn',  message: 'Bill edit awaiting approval could not be emailed to any admin' },
  'DDP-ADMIN-019': { severity: 'warn',  message: 'Payment reminder refused — already sent, still cooling, or spent' },
  'DDP-ADMIN-020': { severity: 'error', message: 'Payment reminder could not be emailed to the resident' },

  // ── SYS ────────────────────────────────────────────────────────────────
  'DDP-SYS-001': { severity: 'fatal', message: 'Unhandled exception in a Worker route' },
  'DDP-SYS-002': { severity: 'fatal', message: 'D1 query failed', planned: true },
  'DDP-SYS-003': { severity: 'error', message: 'Nightly Drive backup failed' },
  'DDP-SYS-004': { severity: 'error', message: 'Telegram alert delivery failed' },
  'DDP-SYS-005': { severity: 'fatal', message: 'Telegram binding missing at startup — alerts are inert' },
  'DDP-SYS-008': { severity: 'fatal', message: 'Google refresh token rejected — the nightly backup is dead' },
  'DDP-SYS-007': { severity: 'warn',  message: 'Nightly run summary — late fees applied or payments left unconfirmed' },
  'DDP-SYS-006': { severity: 'warn',  message: 'Repeat of a code already alerted; held inside its cooldown' },

  // ── NOTICE ─────────────────────────────────────────────────────────────
  'DDP-NOTICE-001': { severity: 'warn',  message: 'Comment or notice not found' },
  'DDP-NOTICE-002': { severity: 'warn',  message: 'Comment posted to a notice that has comments switched off' },
  'DDP-NOTICE-003': { severity: 'warn',  message: 'Comment rejected — empty or too long' },
  'DDP-NOTICE-004': { severity: 'warn',  message: 'Comment rate limit reached' },
  'DDP-NOTICE-005': { severity: 'warn',  message: 'Permanent deletion attempted on a notice still live' },

  // ── ATTACH ─────────────────────────────────────────────────────────────
  'DDP-ATTACH-001': { severity: 'warn',  message: 'Attachment rejected — wrong type or over the size limit' },
  'DDP-ATTACH-002': { severity: 'warn',  message: 'Attachment rejected — parent already has its maximum' },
  'DDP-ATTACH-003': { severity: 'error', message: 'Attachment missing from R2 but row says stored' },
  'DDP-ATTACH-004': { severity: 'fatal', message: 'Attachment row written but R2 upload failed' },
};

/** Domains in registry order, for the generated docs. */
export const DOMAINS = ['AUTH', 'MAIL', 'BILL', 'PAY', 'PROOF', 'RECON', 'NOTICE', 'ATTACH', 'ADMIN', 'SYS'];

export function domainOf(code) {
  return code.split('-')[1];
}

export function isKnownCode(code) {
  return Object.hasOwn(ERROR_CODES, code);
}
