/**
 * Who a resident contacts when something is wrong.
 *
 * The building used to name the treasurer and print his mobile number on the
 * login page, the password-reset page and the dashboard footer. Committee
 * members change at every AGM, so every one of those was a number waiting to go
 * stale, and the one it named carried the calls for the whole committee. On
 * screen the portal now says "reach out to the committee" and leaves the names
 * and numbers to the committee list on the home page, which is published from
 * the database (functions/lib/public.js) and is the one place that has to be
 * right.
 */

/**
 * The one person with full control, by name, for anything shown on screen.
 * "The superadmin" is a database role name; nobody in the building says it, and a
 * message using it makes the reader go and work out who is meant.
 *
 * The server's copy is `ADMINISTRATOR` in `functions/lib/tenancy.js`, for the
 * messages it generates. Deliberately two definitions, and both go stale
 * together if god mode ever hands the role to somebody else, which is the one
 * thing to remember about them.
 */
export const ADMINISTRATOR = { name: 'Sabarish' };
