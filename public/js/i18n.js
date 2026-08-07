/**
 * Bilingual labels — English with Malayalam alongside for the ~30 strings a
 * resident actually reads. Not a full i18n system: the Malayalam sits *next to*
 * the English rather than replacing it, because mixed households read both and
 * a language toggle is one more thing to get wrong.
 *
 * ⚠ NEEDS A NATIVE SPEAKER before launch. These are common terms and the
 *   author is reasonably confident, but "reasonably confident" is not good
 *   enough for labels 52 families read every month. Review, then delete this
 *   notice.
 */

export const L = {
  // identity & auth
  memberLogin:   { en: 'Member login',    ml: 'അംഗ ലോഗിൻ' },
  mobileNumber:  { en: 'Mobile number',   ml: 'മൊബൈൽ നമ്പർ' },
  password:      { en: 'Password',        ml: 'പാസ്‌വേഡ്' },
  newPassword:   { en: 'New password',    ml: 'പുതിയ പാസ്‌വേഡ്' },
  changePassword:{ en: 'Change password', ml: 'പാസ്‌വേഡ് മാറ്റുക' },
  logIn:         { en: 'Log in',          ml: 'ലോഗിൻ' },
  logOut:        { en: 'Log out',         ml: 'ലോഗ് ഔട്ട്' },
  myDetails:     { en: 'My details',      ml: 'എന്റെ വിവരങ്ങൾ' },

  // billing
  flat:          { en: 'Flat',            ml: 'ഫ്ലാറ്റ്' },
  consumption:   { en: 'Consumption',     ml: 'ഉപയോഗം' },
  rate:          { en: 'Rate',            ml: 'നിരക്ക്' },
  gasAmount:     { en: 'Gas amount',      ml: 'ഗ്യാസ് തുക' },
  otherCharges:  { en: 'Other charges',   ml: 'മറ്റ് ചാർജുകൾ' },
  lateFee:       { en: 'Late fee',        ml: 'വൈകി ഫീസ്' },
  total:         { en: 'Total',           ml: 'ആകെ' },
  dueDate:       { en: 'Due',             ml: 'അവസാന തീയതി' },
  billHistory:   { en: 'Bill history',    ml: 'ബിൽ ചരിത്രം' },
  pay:           { en: 'Pay',             ml: 'അടയ്ക്കുക' },

  // status
  paid:          { en: 'Paid',            ml: 'അടച്ചു' },
  unpaid:        { en: 'Unpaid',          ml: 'അടച്ചിട്ടില്ല' },
  overdue:       { en: 'Overdue',         ml: 'കാലാവധി കഴിഞ്ഞു' },
  checking:      { en: 'Checking',        ml: 'പരിശോധിക്കുന്നു' },

  // site
  notices:       { en: 'Notices',         ml: 'അറിയിപ്പുകൾ' },
  events:        { en: 'Events',          ml: 'പരിപാടികൾ' },
  gallery:       { en: 'Gallery',         ml: 'ഗാലറി' },
  contact:       { en: 'Contact',         ml: 'ബന്ധപ്പെടുക' },
  amenities:     { en: 'Amenities',       ml: 'സൗകര്യങ്ങൾ' },
  uploadProof:   { en: 'Upload screenshot', ml: 'സ്ക്രീൻഷോട്ട് അപ്‌ലോഡ് ചെയ്യുക' },
};

/** `<span>English <span class="ml">മലയാളം</span></span>` */
export function bilingual(key) {
  const entry = L[key];
  if (!entry) return key;
  return `${entry.en} <span class="ml" aria-hidden="true">${entry.ml}</span>`;
}

export function en(key) {
  return L[key]?.en ?? key;
}

/** Indian rupee, always 2dp — the paise identify the flat and must show. */
export function money(amount) {
  return `₹${Number(amount).toFixed(2)}`;
}

export function kg(value) {
  return `${Number(value).toFixed(2)} kg`;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

/** '2026-07' -> 'July 2026' */
export function periodLabel(period) {
  const [y, m] = String(period).split('-');
  return `${MONTHS[Number(m) - 1]} ${y}`;
}

/** '2026-08-10' -> '10 August' */
export function dayLabel(iso) {
  const d = new Date(iso);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}
