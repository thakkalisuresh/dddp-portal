/**
 * Ownership changes: a flat is sold, or the builder hands one to a new buyer.
 *
 * THE DISTINCTION THAT MATTERS: a meter reading is a fact about the property,
 * so readings stay keyed to the flat alone and carry across a sale. A bill and
 * a payment screenshot are facts about a PERSON — the new owner must not be
 * able to read the previous owner's bills or open their receipts, and the
 * previous owner must not see the new one's.
 */

import { fail } from './errors.js';

export const ROLES = ['owner', 'admin', 'superadmin'];

/**
 * Outstanding balance a departing owner leaves behind. Usually settled at the
 * sale, but the committee needs to see the number to settle it — and needs to
 * decide explicitly rather than have it silently become the buyer's problem.
 */
export function outstandingFor(bills) {
  const open = bills.filter((b) => b.status !== 'paid' && b.status !== 'waived');
  return {
    count: open.length,
    total: Math.round(open.reduce((sum, b) => sum + b.total, 0) * 100) / 100,
    bills: open.map((b) => ({ id: b.id, period: b.period, total: b.total, status: b.status })),
  };
}

/**
 * There is exactly ONE superadmin, and it is the building's owner-operator.
 *
 * Two rules fall out of that, and they pull in opposite directions:
 *   - nobody else can be promoted into the role, and
 *   - the sole holder cannot be demoted, because that would leave the system
 *     with no one able to administer it and no in-app way back.
 *
 * Which means the role can only ever MOVE, never be created or destroyed —
 * see handoverSuperadmin. Admins are a separate, plural role and change freely
 * at an AGM.
 */
export const SUPERADMIN_LIMIT = 1;

export function canChangeRole({ target, newRole, superadminCount }) {
  if (!ROLES.includes(newRole)) {
    return { ok: false, message: `Role must be one of ${ROLES.join(', ')}.` };
  }

  // Promoting a second superadmin.
  if (newRole === 'superadmin' && target.role !== 'superadmin'
      && superadminCount >= SUPERADMIN_LIMIT) {
    return {
      ok: false,
      // Left as the role name deliberately: canChangeRole is reachable only from
      // god mode and the superadmin-only branch of patchResident, so the one
      // person who reads this is the one person the role belongs to.
      message: 'There can only be one superadmin. Use "Hand over superadmin" to move the role.',
    };
  }

  // Demoting the only one.
  if (target.role === 'superadmin' && newRole !== 'superadmin' && superadminCount <= 1) {
    return {
      ok: false,
      message: 'This is the only superadmin. Hand the role over instead — demoting it would leave nobody able to administer the portal.',
    };
  }

  return { ok: true };
}

/**
 * Move the role in one step: the outgoing holder becomes an admin and the
 * incoming one becomes superadmin. Doing it as two role edits is impossible by
 * design — either order trips a guard — and that is deliberate, because a
 * half-finished handover is how a building ends up locked out of its own
 * portal.
 */
export function planHandover({ from, to }) {
  if (!from || !to) return { ok: false, message: 'Both the current and the new superadmin are required.' };
  if (from.id === to.id) return { ok: false, message: 'That is already the superadmin.' };
  if (from.role !== 'superadmin') return { ok: false, message: 'Only the current superadmin can hand the role over.' };
  if (!to.active) return { ok: false, message: 'That resident is no longer active.' };

  return {
    ok: true,
    steps: [
      { id: to.id, role: 'superadmin' },
      { id: from.id, role: 'admin' },   // demoted, not removed — they keep operational access
    ],
  };
}

/**
 * Hand a flat over. The outgoing owner is deactivated rather than deleted:
 * their bills, payments and comments remain attributable, which is what makes
 * the audit trail worth having.
 */
export async function transferFlat(env, { flat, outgoingId, name, mobile, email, actorId,
                                          settleOutstanding = false }) {
  const cleanMobile = String(mobile ?? '').replace(/\D/g, '');
  if (!name?.trim() || cleanMobile.length < 10) {
    fail('DDP-ADMIN-003', { reason: 'new owner needs a name and a 10-digit mobile' });
  }

  const outgoing = await env.DB.prepare(
    'SELECT id, flat, name, role FROM owners WHERE id = ? AND flat = ? AND active = 1'
  ).bind(outgoingId, flat).first();
  if (!outgoing) fail('DDP-ADMIN-001', { flat, outgoingId });

  const bills = await env.DB.prepare(
    'SELECT id, period, total, status FROM bills WHERE owner_id = ?'
  ).bind(outgoingId).all();
  const outstanding = outstandingFor(bills.results ?? []);

  // Refuse silently carrying a debt across a sale. The committee must either
  // settle it or say explicitly that they are writing it off.
  if (outstanding.count > 0 && !settleOutstanding) {
    fail('DDP-ADMIN-005', { flat, outstanding });
  }

  return { outgoing, outstanding };
}

/** ISO in, IST out. The committee reads these, not a server operator. */
export function toIST(iso) {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const ist = new Date(date.getTime() + 5.5 * 3600_000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${ist.getUTCFullYear()}-${pad(ist.getUTCMonth() + 1)}-${pad(ist.getUTCDate())} `
       + `${pad(ist.getUTCHours())}:${pad(ist.getUTCMinutes())}:${pad(ist.getUTCSeconds())} IST`;
}

/**
 * One timeline from three tables. Kept as a shaping function so the ordering
 * and labelling are testable without a database.
 */
export function mergeTimeline({ audits = [], activities = [], errors = [] }) {
  const rows = [
    ...audits.map((a) => ({
      at: a.at, kind: 'action', name: a.action,
      actor: a.actor_name, actorId: a.actor_id,
      subject: a.subject_name, subjectId: a.subject_id,
      detail: a.detail, source: 'audit',
    })),
    ...activities.map((a) => ({
      at: a.at, kind: a.kind, name: a.name,
      actor: a.actor_name, actorId: a.actor_id,
      subject: a.owner_name, subjectId: a.owner_id,
      detail: a.detail, userAgent: a.user_agent, source: 'activity',
    })),
    ...errors.map((e) => ({
      at: e.at, kind: 'error', name: e.code,
      severity: e.severity, detail: e.detail ?? e.message, source: 'error',
    })),
  ];

  rows.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  return rows.map((r) => ({ ...r, atIST: toIST(r.at) }));
}

/**
 * Who the one person with full control IS, by name, for anything a resident or an
 * admin reads. "The superadmin" is a role name out of the database — nobody in
 * this building says it, and a message that uses it tells the reader to go and
 * find out who that means.
 *
 * ONE DEFINITION on this side; the browser's copy is in `public/js/contact.js`,
 * the same deliberate split as TREASURER there and the committee list in
 * `lib/public.js`. Both carry a pointer to the other.
 *
 * THIS GOES STALE IF THE ROLE IS HANDED OVER. God mode can hand superadmin to
 * another resident, and nothing makes this constant follow — the messages would
 * then name the wrong person. Both copies need editing at that moment. See the
 * note in BACKLOG under B22 for the version that reads the name from the database
 * instead, which is the right fix if handover ever actually happens.
 */
export const ADMINISTRATOR = { name: 'Sabarish' };

/**
 * Who may reset whose password. The superadmin, and nobody else.
 *
 *   resident  -> the superadmin only
 *   admin     -> the superadmin only
 *   superadmin-> nobody, through any API
 *
 * ADMINS LOST THIS ON 2026-08-12, and the reason is not that they are not
 * trusted. A reset shows nobody an existing password — that is a hash and is
 * gone — but it MINTS one and hands it to whoever asked, who then knows a working
 * credential for an account that is not theirs. `must_change_pw` does not help:
 * they can log in first and set it themselves. Everything that account then
 * does — a payment claim, a proof, a comment under somebody's name — is
 * attributable to a resident who never typed the password.
 *
 * This ladder used to stop at the roles: an admin could not reset the superadmin
 * or another admin, which closed privilege escalation and left all 99 residents
 * impersonable by any admin. That was the sharp end, not the whole of it.
 *
 * So residents recover their own accounts through `/forgot`, and an admin's job
 * in a recovery is to tell them to use it. What the admin keeps is the part that
 * needs a person in the building: noticing that a number or address is wrong, and
 * raising a request for the superadmin to approve (backlog B22).
 *
 * The superadmin exclusion has no exception, including for the superadmin
 * themselves — a session that is already authenticated does not need it, and
 * an endpoint that can rewrite the top credential is exactly what an attacker
 * with a stolen admin session would reach for. Recovery is the break-glass
 * script, which requires the Cloudflare credentials rather than a login.
 */
export function canResetPassword({ actor, target }) {
  if (!actor || !target) return { ok: false, message: 'Unknown account.' };

  if (target.role === 'superadmin') {
    return {
      ok: false,
      message: `${ADMINISTRATOR.name}'s own password cannot be reset from the portal. `
             + 'Use the break-glass script — it needs database access, not a login.',
    };
  }

  if (actor.role !== 'superadmin') {
    return {
      ok: false,
      message: `Only ${ADMINISTRATOR.name} can reset a password. Ask the resident to use `
             + '"Forgotten your password?" on the login page — the code goes to their '
             + 'own email, so nobody else ever holds their password.',
    };
  }

  return { ok: true };
}

/**
 * Who may edit somebody's row at all — the same ladder as canResetPassword.
 *
 * An admin who can rewrite another admin's or the superadmin's contact details
 * can take that account: see `canEditField` for which field actually does it and
 * how. The directory made this reachable from the main console, so the guard has
 * to be here and not only on the reset path.
 *
 * Unlike a reset, a superadmin editing their OWN row is ordinary and allowed.
 *
 * This answers "may you touch this person's row"; `canEditField` answers "may you
 * write THIS column", which since B22 is a different question for two of them.
 */
export function canEditResident({ actor, target }) {
  if (!actor || !target) return { ok: false, message: 'Unknown account.' };

  if (actor.role !== 'admin' && actor.role !== 'superadmin') {
    return { ok: false, message: 'Admins only.' };
  }

  if (actor.role === 'superadmin') return { ok: true };

  if (target.role === 'superadmin' || target.role === 'admin') {
    return {
      ok: false,
      message: target.id === actor.id
        ? 'Change your own details from your profile, not the directory.'
        : `Only ${ADMINISTRATOR.name} can edit another admin.`,
    };
  }

  return { ok: true };
}

/**
 * The two columns an admin may no longer write directly (B22). They raise a
 * request instead and the superadmin approves it.
 */
export const REQUESTABLE_FIELDS = ['mobile', 'email'];

/**
 * May this actor write THIS column on this person's row?
 *
 * `canEditResident` says whether the row is theirs to touch. This says whether
 * the column is, and since 2026-08-12 the answer differs for two of them.
 *
 * WHICH FIELD ACTUALLY TAKES AN ACCOUNT, since the old comment here had it the
 * wrong way round: `forgotPassword` finds the account BY MOBILE and mails the
 * code TO THE EMAIL. So email is the takeover — set it to an address you hold,
 * ask for a reset against the resident's own number, and the code arrives in your
 * inbox, which is the reset B21 just refused you. Mobile is the lockout: the
 * resident can no longer log in, but the code still follows the address, so
 * nothing is delivered anywhere new.
 *
 * Both are behind approval. Email is the reason it had to happen, and mobile is
 * not merely tidiness — an admin who can silently move a number can stop a
 * resident logging in at all.
 *
 * `name` stays writable by an admin. It is not a credential, correcting a
 * spelling is the kind of upkeep the directory exists for, and routing it through
 * an approval queue would teach everybody to ignore the queue.
 */
export function canEditField({ actor, target, field }) {
  const row = canEditResident({ actor, target });
  if (!row.ok) return row;

  if (REQUESTABLE_FIELDS.includes(field) && actor.role !== 'superadmin') {
    return {
      ok: false,
      // Read by the person who just tried it, so it says what to do instead
      // rather than only what went wrong.
      message: `Only ${ADMINISTRATOR.name} can change a ${field}. `
             + 'Use "Request a change" so it is recorded with your reason, and '
             + 'it will be applied when approved.',
      requestInstead: true,
      field,
    };
  }

  return { ok: true };
}

/**
 * A wa.me link needs bare digits with the country code and no '+'.
 *
 * Mobiles are stored in E.164 since 0009, so the old `wa.me/91${mobile}`
 * started producing 'wa.me/91+919846466511' — a dead link on every password
 * reset and every new resident. Anything not yet in E.164 is assumed Indian,
 * which is what the pre-0009 rows were.
 */
export function waLink(mobile, text) {
  const digits = String(mobile ?? '').replace(/\D/g, '');
  const withCc = String(mobile ?? '').startsWith('+') || digits.length > 10
    ? digits
    : `91${digits}`;
  return `https://wa.me/${withCc}?text=${encodeURIComponent(text)}`;
}

/* ── owners and tenants ───────────────────────────────────────────────────
   ONE stored fact — relationship, 'owner' or 'tenant' — and everything else
   derived from it. "Absent" is not a property of a person: it is what being
   an owner means when somebody else occupies your flat. Storing that
   separately stores the same truth twice, and the copies drift the first time
   a tenant moves out and nobody flips the owner back.                       */

export const RELATIONSHIPS = ['owner', 'tenant'];

export function isRelationship(value) {
  return RELATIONSHIPS.includes(value);
}

/** Only people who still live here. Departure is `active = 0`, never a delete. */
function present(people) {
  return (people ?? []).filter((p) => p.active);
}

/**
 * Who is billed for this flat.
 *
 * The tenant if there is one, otherwise the owner. A vacant flat therefore
 * bills its owner, which is correct — somebody has to answer for the meter,
 * and with nobody living there it is the person who owns it.
 */
export function occupantOf(people) {
  const here = present(people);
  return here.find((p) => p.relationship === 'tenant')
      ?? here.find((p) => p.relationship === 'owner')
      ?? null;
}

/** Who is liable when the bill goes unpaid. Always the owner, occupied or not. */
export function landlordOf(people) {
  return present(people).find((p) => p.relationship === 'owner') ?? null;
}

/** Is this flat let out — an owner living elsewhere with a tenant in place? */
export function isTenanted(people) {
  const here = present(people);
  return here.some((p) => p.relationship === 'tenant');
}

/**
 * What one person may see of a flat's bills.
 *
 * Three levels, and the middle one is the whole point of the feature: an
 * absent owner needs to know whether their tenant is paying, because they are
 * liable for it — but a payment screenshot is a bank record belonging to the
 * person who uploaded it, and none of the owner's business.
 */
export function billAccess({ viewer, people }) {
  if (!viewer?.active) {
    // "Once they leave, no access whatsoever." History stays for admin and god.
    return { amounts: false, proofs: false, canPay: false, reason: 'departed' };
  }

  const occupant = occupantOf(people);
  if (occupant && occupant.id === viewer.id) {
    return { amounts: true, proofs: true, canPay: true, reason: 'occupant' };
  }

  // The landlord OF THIS FLAT, not merely someone who owns a flat somewhere.
  // The first version checked `viewer.relationship === 'owner'` against a
  // tenanted flat, which let the owner of 5A read the bill amounts of every
  // let flat in the building.
  const landlord = landlordOf(people);
  if (landlord && landlord.id === viewer.id && isTenanted(people)) {
    return { amounts: true, proofs: false, canPay: false, reason: 'landlord' };
  }

  return { amounts: false, proofs: false, canPay: false, reason: 'unrelated' };
}

/** How to describe someone on their own profile. */
export function describeRelationship({ viewer, people }) {
  if (!viewer) return '';
  if (viewer.relationship === 'tenant') return `Tenant of ${viewer.flat}`;
  return isTenanted(people)
    ? `Owner of ${viewer.flat} — let to a tenant`
    : `Owner of ${viewer.flat}`;
}

/**
 * A tenant is leaving. What does the committee need to decide before the row
 * is deactivated?
 *
 * Never silently transfers the debt. The owner IS liable, but that liability
 * is a conversation between two people and a committee, not a database write
 * that reassigns somebody's bills while they are not looking.
 */
export function planDeparture({ leaver, people, bills }) {
  const outstanding = outstandingFor(bills);
  const landlord = landlordOf(people);

  const steps = [{ id: leaver.id, active: 0, moved_out_at: new Date().toISOString() }];

  if (outstanding.count === 0) {
    return { ok: true, steps, outstanding, flag: null };
  }

  if (leaver.relationship === 'tenant') {
    return {
      ok: true,
      steps,
      outstanding,
      // Raised for the committee, not applied. Somebody has to talk to the
      // owner before their name goes on someone else's debt.
      flag: landlord
        ? {
            kind: 'tenant-left-owing',
            ownerId: landlord.id,
            ownerName: landlord.name,
            amount: outstanding.total,
            message: `${leaver.name} is leaving ${leaver.flat} owing ₹${outstanding.total}. `
                   + `${landlord.name} is liable as the owner — settle it with them before closing.`,
          }
        : {
            kind: 'tenant-left-owing-no-owner',
            amount: outstanding.total,
            message: `${leaver.name} is leaving ${leaver.flat} owing ₹${outstanding.total}, `
                   + 'and no owner is on record for that flat. Nobody is liable. Add the owner first.',
          },
    };
  }

  return {
    ok: true, steps, outstanding,
    flag: {
      kind: 'owner-left-owing',
      amount: outstanding.total,
      message: `${leaver.name} owes ₹${outstanding.total} on ${leaver.flat}. `
             + 'Settle or write it off before the sale completes.',
    },
  };
}
