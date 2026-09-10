/**
 * "Overseas? Include your country code" — shown to the people who need it and
 * to nobody else. B27.
 *
 * A bare ten digits is read as an Indian number, which is right for everyone
 * standing in the building and silently wrong for the owners in the Gulf. The
 * fix is one line of copy; the problem is where to put it. Permanently under
 * the first field of the first screen it is noise for the ~95 households who
 * will never need it, and that is the most expensive line of copy in the app.
 *
 * So: show it when the device suggests it is wanted, show it when the login
 * has just failed wherever they are, and stop showing it for good once they
 * have proved they know their own format.
 *
 * WHY THE TIMEZONE AND NOT THE IP. Cloudflare hands us `request.cf.country`
 * free at the edge, but /login and /forgot are static files out of pages/dist
 * and make no request before submit — reading it means adding a round trip to
 * the one screen that does not have one. The timezone costs nothing, works
 * offline, and asks only what the device is set to rather than where the
 * person is.
 */

/** Set once a login or a reset has actually worked from this browser. */
const KEY = 'dddp.mobileFormatKnown';

/**
 * Both spellings. ICU renamed this zone and older engines — Safari in
 * particular — still answer with the old one, so checking only 'Asia/Kolkata'
 * would show the hint to half the building.
 */
const HOME_ZONES = ['Asia/Kolkata', 'Asia/Calcutta'];

/**
 * Storage throws rather than returning null in a locked-down browser, and a
 * hint is not worth a broken login screen. Unknown reads as "not yet proved",
 * which shows the hint one more time — the harmless direction to be wrong in.
 */
function alreadyKnows() {
  try { return localStorage.getItem(KEY) === '1'; } catch { return false; }
}

/**
 * Record that this browser has typed a working number, after a login or a
 * reset succeeds. Nothing shows the hint here again.
 */
export function rememberFormatKnown() {
  try { localStorage.setItem(KEY, '1'); } catch { /* nothing to do about it */ }
}

/**
 * A guess, and only ever used to show one extra line — never to block, warn or
 * change what the server will accept. An engine with no `timeZone` reads as
 * home, so the failure mode is the quiet one.
 */
function probablyAbroad() {
  try {
    const zone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
    return Boolean(zone) && !HOME_ZONES.includes(zone);
  } catch {
    return false;
  }
}

/**
 * Reveal the hint regardless of where the device claims to be, and regardless
 * of whether this browser has logged in before. For a failed attempt, which is
 * a better signal than any guess about geography.
 */
export function showCountryHint() {
  const node = document.getElementById('mobileHint');
  if (node) node.hidden = false;
}

/**
 * Show the hint on load if the device looks like it is outside India and this
 * browser has not already proved it knows the format. The hint ships `hidden`
 * in the markup rather than being hidden from here, so the ordinary Indian case
 * never sees it flash before this runs.
 */
export function applyCountryHint() {
  if (alreadyKnows()) return;
  if (probablyAbroad()) showCountryHint();
}
