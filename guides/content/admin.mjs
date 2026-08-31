/**
 * The admin handbook.
 *
 * Ordered as the month actually happens — rates, then readings, then bills,
 * then money arriving, then people — which is the same order the console's own
 * tab strip uses, so the handbook and the screen agree.
 *
 * Two standing rules, both settled with the association:
 *   · Roles, never names. "the Treasurer", not a person. A printed handbook
 *     outlives a committee; the screenshots show who currently holds the role.
 *   · The version stamp lives on the cover alone.
 *
 * Superadmin-only screens (Roster, Errors, god mode) are deliberately absent.
 */
import { page, figure, box, warn, steps, pre, plain, p, h3, table, split } from '../lib/render.mjs';

const HEAD = 'DD Diamond Park · Admin handbook';

/** Section numbers in one place, so the contents page cannot drift. */
export const SECTIONS = [
  ['1', 'Finding your way', 'The console, and the shape of a month'],
  ['2', 'Home', 'Where the month stands, what is waiting, and chasing a late bill'],
  ['3', 'Billing', 'The price of gas, the meter walk, and publishing the bills'],
  ['4', 'Bills', 'What a bill is made of, and how one is corrected'],
  ['5', 'Proofs', 'The payment screenshots residents send'],
  ['6', 'Reconcile', 'Matching the bank statement'],
  ['7', 'Residents', 'Who lives where, and what you may change'],
  ['8', 'Notices', 'Telling the building something'],
];

export function pages({ version, date }) {
  const out = [];
  let n = 0;
  const next = () => (n += 1);

  /* ── cover ─────────────────────────────────────────────────────────── */
  out.push(page({
    cover: true,
    body: `
      <p class="mark">DD Diamond Park · Residents' Welfare Association</p>
      <h1>Running the gas billing</h1>
      <p class="sub">A handbook for the committee members who set the rate, enter the
        readings, issue the bills and check the payments.</p>
      <div class="stamp">
        <span>Kuriachira, Thrissur 680006, Kerala</span>
        <span>diamondpark.pages.dev</span>
        <span>Version ${version} · ${date}</span>
      </div>`,
  }));

  /* ── contents ──────────────────────────────────────────────────────── */
  out.push(page({
    head: HEAD, section: 'Contents', foot: 'Contents', n: next(),
    body: `
      <h2>What is in here</h2>
      <div class="toc">
        ${SECTIONS.map(([num, title, dek]) => `
          <a><span class="n">${num}</span><span class="t">${title}</span><span class="d">${dek}</span></a>`).join('')}
      </div>
      ${box('Read this first',
        'Work through a month in the order these sections are in. The console is arranged the same way, and each step depends on the one before it: a month needs its price of gas before a reading can go in, and every flat needs a reading before anything can be published.')}
      ${box('What is not in here',
        'The roster import and the error log are the administrator’s alone and do not appear on your console. Neither does god mode. If you cannot see a tab described anywhere in this handbook, that is why.')}`,
  }));

  /* ── 1 · finding your way ──────────────────────────────────────────── */
  out.push(page({
    head: HEAD, section: '1 · Finding your way', foot: 'Finding your way', n: next(),
    body: `
      <div>
        <p class="eyebrow">Section 1</p>
        <h1>Finding your way</h1>
        <p class="dek">Everything below lives under <b>Admin</b> in the top navigation.
          The tabs are in the order you use them.</p>
      </div>
      ${figure('admin-nav', { caption: 'The console. Tabs run left to right in the order a month happens.' })}
      ${h3('The shape of a month')}
      ${table(
        ['When', 'What you do', 'Where'],
        [
          ['Early in the month', 'Set the price of gas for the month that just ended', 'Billing · step 1'],
          ['After the meter walk', 'Enter every flat’s reading', 'Billing · step 2'],
          ['Once every meter is in', 'Check the total, then publish the bills', 'Billing · step 3'],
          ['As payments arrive', 'Check the screenshots residents upload', 'Proofs'],
          ['A few days after the due date', 'Chase what is still unpaid', 'Home'],
          ['When the statement comes', 'Match it against what was claimed', 'Reconcile'],
          ['Any time', 'Correct a detail, add a resident, post a notice', 'Residents · Notices'],
        ],
      )}
      ${box('Rates and Readings are one tab now',
        'They were two screens, and the split was the commonest way a month stalled — a month opened, then abandoned, because nothing on the rate screen said a reading needed one first. **Billing** is both, plus publishing, as three numbered steps.')}
      ${warn('The order is not optional',
        'A reading cannot be entered against a month that has no price of gas on it, and nothing can be published until every meter is in. Each step opens the next one, and the tab greys out the ones you are not ready for.')}
      ${box('Notices are not on this strip',
        'A notice is written and managed on the notice board itself, under **Notices** in the main navigation — not from the admin console. Section 8 covers it.')}`,
  }));

  /* ── 2 · home ──────────────────────────────────────────────────────── */
  out.push(page({
    head: HEAD, section: '2 · Home', foot: 'Home', n: next(),
    body: `
      <div>
        <p class="eyebrow">Section 2</p>
        <h1>Home</h1>
        <p class="dek">The first screen under Admin. It answers two questions: how far
          through the month the building is, and what is sitting waiting for you.</p>
      </div>
      ${figure('admin-home', { caption: 'Where the month stands, then Waiting on you.' })}
      ${h3('Reading it')}
      ${steps([
        ['**Where the month stands** names the month and its state — how many meters are read, the rate, and the due date.',
         'It carries the button that takes you into the month: **Continue readings** while one is in progress.'],
        ['**Waiting on you** is the work queue. A number means there is something to do; **none** means there is not.'],
        ['Each row opens the screen that clears it. Payment proofs go to section 5, bill corrections to section 4.'],
      ])}
      ${box('Awaiting proof is not the same as paid',
        'A resident who has tapped Pay is counted as awaiting proof until somebody approves their screenshot. The money may well have arrived — the portal simply has not been told so yet. That is what section 5 is for.')}`,
  }));

  out.push(page({
    head: HEAD, section: '2 · Home', foot: 'Home · Chasing a late bill', n: next(),
    body: `
      <h2>Chasing an unpaid bill</h2>
      ${p('**Bills unpaid past the due date** is folded away under Waiting on you. Open it and every overdue flat is listed with what it owes, which month, and how far past the date it is.')}
      ${figure('admin-home-reminders', { caption: 'Each row is one overdue bill. Remind emails that resident, and only that resident.' })}
      ${warn('Three reminders per bill. There is no fourth.',
        'The first goes when you ask, the second a day later, the third two days after that. Then the button reads **Sent ×3** and stops.',
        'That ceiling is the committee’s rule, not a technical limit — a fourth reminder is a neighbour deciding they are being harassed over ₹1,200.')}
      ${h3('Remind all')}
      ${plain([
        '**Remind all** sends to every overdue flat that is currently due one — not to every flat on the list.',
        'It can be run **twice for a month**, a day apart.',
        'It spends the same three-per-bill allowance an individual click does. There is one budget, not two.',
      ])}
      ${box('Why a button is greyed out',
        'The console says which of the reasons it is rather than hiding the button: the bill has had its three, not enough time has passed since the last one, or no email address is on file for that resident. A resident with no address cannot be reminded by the portal at all — that one is a phone call.')}`,
  }));

  /* ── 3 · billing ───────────────────────────────────────────────────── */
  out.push(page({
    head: HEAD, section: '3 · Billing', foot: 'Billing', n: next(),
    body: `
      <div>
        <p class="eyebrow">Section 3</p>
        <h1>Billing</h1>
        <p class="dek">One tab, three steps, in the order the month happens: the price of
          gas, the meter walk, then review and publish.</p>
      </div>
      ${figure('admin-billing-overview', { caption: 'The month in hand. A step opens when the one above it is done; step 3 stays shut until every meter is in.' })}
      ${h3('The three steps')}
      ${table(
        ['Step', 'What it holds', 'Done when'],
        [
          ['1 · The price of gas', 'Rate per kg, payment due date, late fee', 'Saved — the step shows a tick'],
          ['2 · This month’s readings', 'One row per flat, plus paste and file import', 'Every meter has a reading'],
          ['3 · Review and publish', 'What each flat used and owes, and the building total', 'Published — and only then do residents see anything'],
        ],
      )}
      ${box('This tab is only ever about the month in hand',
        'Past months and their bills live under **Bills**. That keeps this tab the same size in year three as in month one.')}
      ${warn('Nothing is sent until you publish',
        'Steps 1 and 2 are a draft. It is saved as you type and any admin can pick it up, but no resident sees a rupee of it until step 3 is published.')}`,
  }));

  out.push(page({
    head: HEAD, section: '3 · Billing', foot: 'Billing · The price of gas', n: next(),
    body: `
      <h2>Step 1 — the price of gas</h2>
      ${box('The one rule',
        'Set the price for **every** month, even when it has not changed.',
        'Nothing is carried forward. An inherited rate produces a building’s worth of bills that look normal and are all wrong — and nobody notices until a resident queries theirs.')}
      ${figure('admin-billing-rate', { w: 146, caption: 'Three fields, and all three belong to the month you are billing.' })}
      ${steps([
        ['**Rate per kg** — what the committee agreed for the month being billed.'],
        ['**Payment due** — the date a late fee would start from.'],
        ['**Late fee** — whole rupees. Paise are refused.'],
      ])}
      ${p('Save, and the step folds up with a tick. Underneath it the screen says what last month’s rate was and how far this one has moved — a rate typed with a digit missing shows there as an implausible percentage, before it reaches anybody’s bill.')}
      ${box('Which month is this?',
        'The month at the top of the tab is the **usage** month — when the gas was burned. Meters are read the month after, which is why it reads "meters read in October, closes September’s gas".')}
      ${box('A published month refuses a change',
        'Once bills are out, that month’s price is settled and the screen names who can decide otherwise — so a month residents have been told about cannot move underneath them.')}`,
  }));

  out.push(page({
    head: HEAD, section: '3 · Billing', foot: 'Billing · The readings', n: next(),
    body: `
      <h2>Step 2 — this month’s readings</h2>
      ${p('One row per flat: the previous reading, a box for the new one, and what that works out to in kilograms. The counter at the top of the step is your progress.')}
      ${figure('admin-billing-readings', { caption: 'Saved as you type. The count at the top is how many meters are in.' })}
      ${box('It saves as you type, and holds what it cannot send',
        'There is no Save button on the grid and that is deliberate — the meter walk happens in a corridor on a phone. If the signal drops, entries are held and retried rather than lost, and the step says so on screen.')}
      ${h3('Three ways in')}
      ${plain([
        '**Type into the grid** — best for a handful of corrections.',
        '**Paste** a list of flats and readings straight from a message or a spreadsheet.',
        '**Upload a file** — the template comes out with every flat and its previous reading already filled in.',
      ])}
      ${warn('A reading lower than last month is refused',
        'Meters do not run backwards, so a smaller number is either a typo or a meter that has been replaced. A replaced meter is recorded separately, so the jump never lands on a resident as consumption.')}`,
  }));

  out.push(page({
    head: HEAD, section: '3 · Billing', foot: 'Billing · Paste and import', n: next(),
    body: `
      <h2>Paste, or import a file</h2>
      ${p('Ninety-odd meters are quicker brought in together than typed one at a time. The panel is folded away until you open it.')}
      ${figure('admin-billing-import', { caption: 'Import from a spreadsheet, or paste.' })}
      ${steps([
        ['**Download the template** if you want one — it arrives with every flat and its previous reading already filled in.'],
        ['**Or just paste.** A flat and a reading on each line is enough; a message typed up on a phone during the walk pastes in as it is.'],
        ['**Read what it reports back** before you accept it.'],
      ])}
      ${box('Anything it cannot match is reported, not dropped',
        'A flat it does not recognise, a reading that is not a number, the same flat twice — each is listed back to you rather than silently skipped. A blank reading is simply a flat not yet read, and is not an error.')}
      ${warn('Do not skip a month',
        'A month’s consumption is worked out from the month before it. If a month has no readings, the next month cannot be calculated either — and the failure appears a month after the mistake was made.')}`,
  }));

  out.push(page({
    head: HEAD, section: '3 · Billing', foot: 'Billing · Review and publish', n: next(),
    body: `
      <h2>Step 3 — review and publish</h2>
      ${p('The step opens once every meter is in. It shows what the building used, what it comes to, and every flat’s figure — with the readings still editable and the amounts never.')}
      ${figure('admin-billing-publish', { caption: 'Four numbers to check, then the flat-by-flat table. Fix a reading here and the amount beside it recalculates.' })}
      ${steps([
        ['**Check the total against the supplier invoice.** This is the one number that catches a wrong rate, a mistyped meter and a missed flat all at once.'],
        ['**Scan the flat-by-flat table** for anything that does not look like that flat.'],
        ['**Fix a reading if you need to.** The amount beside it recalculates as you go.'],
        ['**Publish.** The bills are issued, the month closes, and every resident with an address is emailed.'],
      ])}
      ${warn('The amount is never editable — only the inputs are',
        'A bill is what the meter read times the price of gas. There is no box to type a total into, on purpose: every rupee has to trace back to a reading and a rate, or it cannot be explained to the resident who queries it.')}
      ${box('It tells you who will not be emailed',
        'The step names how many residents have an address on file and lists the flats that do not. A gap in the roster does not block publishing — but you will know its size, and those residents need telling another way.')}`,
  }));

  /* ── 4 · bills ─────────────────────────────────────────────────────── */
  out.push(page({
    head: HEAD, section: '4 · Bills', foot: 'Bills', n: next(),
    body: `
      <div>
        <p class="eyebrow">Section 4</p>
        <h1>Bills</h1>
        <p class="dek">Every bill the building has issued, and the only route to changing
          one after the month has been generated.</p>
      </div>
      ${figure('admin-bills', { caption: 'Amounts are shown here, never edited. Search by flat number; it is faster than by name.' })}
      ${h3('What a bill is made of')}
      ${table(
        ['Part', 'Where it comes from'],
        [
          ['Consumption', 'This month’s meter reading less last month’s, converted to kilograms'],
          ['Rate', 'The rate set on that month, stamped onto the bill when it was issued'],
          ['Gas amount', 'Consumption × rate'],
          ['Late fee', 'Added by the nightly job, only after the due date has passed'],
          ['Total', 'Rounded **up** to the whole rupee'],
        ],
      )}
      ${box('Past bills do not move',
        'Each bill keeps the rate it was issued at. Changing this month’s rate does not reach back and alter last month’s bills.')}`,
  }));

  out.push(page({
    head: HEAD, section: '4 · Bills', foot: 'Bills · Corrections', n: next(),
    body: `
      <h2>Correcting a bill</h2>
      ${p('A published month is settled, so a wrong bill is fixed by correcting the thing that produced it — the meter reading, or the month’s price of gas — on the **Billing** tab. Either way the change goes to two other admins and applies when they agree.')}
      ${warn('A correction is not yours alone to make',
        'It goes to **two other admins** and applies only once they agree. If the bill belongs to an admin, **every** other admin must agree.',
        'This is deliberate. A single person being able to quietly change what a neighbour owes is exactly the thing the rule exists to prevent.')}
      ${steps([
        ['**Open the Billing tab** and find the flat, then correct the reading or the month’s rate — whichever was wrong.'],
        ['**Give a short reason.** It is recorded with the change and shown to whoever approves it.'],
        ['**Wait.** The request appears on the other admins’ Home screen under "Bill corrections needing a second admin".'],
        ['**It applies when they agree** — not before, and not when you submit it.'],
      ])}
      ${box('The late fee freezes while a correction is waiting',
        'A resident whose bill is under review is not penalised for the time the committee takes to agree. Nothing is added while the request is open.')}
      ${box('If nothing seems to have happened',
        'That is usually the rule working rather than a fault. Check Home for a pending correction before raising it a second time — a duplicate request needs the same approvals all over again.')}`,
  }));

  /* ── 5 · proofs ────────────────────────────────────────────────────── */
  out.push(page({
    head: HEAD, section: '5 · Proofs', foot: 'Proofs', n: next(),
    body: `
      <div>
        <p class="eyebrow">Section 5</p>
        <h1>Proofs</h1>
        <p class="dek">When a resident pays, they upload the screenshot from their UPI app.
          This is where those are checked. It is where most of the Treasurer’s time goes.</p>
      </div>
      ${figure('admin-proofs', { caption: 'The review queue. The portal has already read each screenshot and compared it to the bill.' })}
      ${h3('What the portal has already done')}
      ${plain([
        'Read the **amount** off the screenshot and compared it to the bill — that is the "matches" on each row.',
        'Read the **payment reference** where the app showed one, and checked it has not been used on another bill.',
        'Refused the upload outright if the image had been sent before.',
      ])}
      ${box('Approve the matching ones together',
        'The button at the top approves every row that matches its bill exactly. That is the ordinary case and it is meant to be one action, not ninety.')}`,
  }));

  out.push(page({
    head: HEAD, section: '5 · Proofs', foot: 'Proofs · Working the queue', n: next(),
    body: `
      <h2>Working the queue</h2>
      ${steps([
        ['**Approve the exact matches in one go** using the button at the top of the queue.'],
        ['**Look at anything that did not match.** Open **View** to see the screenshot the resident actually sent.'],
        ['**Approve or Reject** the remainder one at a time.'],
        ['**Check "Tapped Pay, no screenshot"** below the queue — these residents started a payment and never uploaded anything. Match the amount and payer name against the bank statement, which is section 6.'],
      ])}
      ${h3('Rows that need a look')}
      ${table(
        ['What you see', 'What it means', 'What to do'],
        [
          ['matches', 'Amount on the screenshot equals the bill', 'Approve'],
          ['No reference shown', 'The app did not print a UTR. Not suspicious — some do not', 'Check the amount and approve'],
          ['Amount differs', 'They paid something other than the bill', 'Open it, and talk to the resident before deciding'],
        ],
      )}
      ${box('Decisions can be checked afterwards',
        '**Already decided** keeps the last 50 approvals and rejections, so a decision can be looked at again later. Nothing here disappears the moment you press the button.')}`,
  }));

  /* ── 6 · reconcile ─────────────────────────────────────────────────── */
  out.push(page({
    head: HEAD, section: '6 · Reconcile', foot: 'Reconcile', n: next(),
    body: `
      <div>
        <p class="eyebrow">Section 6</p>
        <h1>Reconcile</h1>
        <p class="dek">The proofs queue tells you what residents say they paid. The bank
          statement tells you what actually arrived. This screen puts the two together.</p>
      </div>
      ${figure('admin-reconcile', { caption: 'Admin → Reconcile.' })}
      ${steps([
        ['**Get the statement** for the account the UPI payments land in.'],
        ['**Bring it in here** and let the portal match each credit against a bill.'],
        ['**Work through what it could not match** — usually a payment with no reference, or an amount that does not equal any single bill.'],
        ['**Delete the statement when you are done.** It is bank data about your neighbours and there is no reason to keep it once the matching is finished.'],
      ])}
      ${box('What the matching rests on',
        'The payment reference the portal puts in the UPI link carries the flat and the month. That, the payer’s name on the credit, and the record of who tapped Pay are what make a credit identifiable. Residents are asked not to edit the reference for exactly this reason.')}
      ${warn('Delete the statement afterwards',
        'This is the one screen that holds other people’s bank data. Removing it when the month is settled is part of the job, not an optional tidy-up.')}`,
  }));

  /* ── 7 · residents ─────────────────────────────────────────────────── */
  out.push(page({
    head: HEAD, section: '7 · Residents', foot: 'Residents', n: next(),
    body: `
      <div>
        <p class="eyebrow">Section 7</p>
        <h1>Residents</h1>
        <p class="dek">Who lives in which flat, who is billed, and who remains liable.</p>
      </div>
      ${figure('admin-residents', { caption: 'Search by flat number or by name. Flat number is usually faster.' })}
      ${h3('Owners and tenants')}
      ${p('There are more people than flats, because some flats have both an owner and a tenant. The distinction matters and the portal keeps it: **the tenant is billed, the owner remains liable.** Gas is metered consumption, so the bill follows whoever burned it — but if it goes unpaid, the debt is still against the property.')}
      ${box('Which flats are billed',
        'A flat can be taken out of billing — an empty flat should not be generating bills nobody owes. Taking one out asks for a short reason, and the reason is recorded.')}`,
  }));

  out.push(page({
    head: HEAD, section: '7 · Residents', foot: 'Residents · What you may change', n: next(),
    body: `
      <h2>What you may change, and what you must ask about</h2>
      ${p('Not every field on this screen is yours to edit. Two of them are credentials in disguise, and they go through the administrator instead.')}
      ${table(
        ['Field', 'Who can change it', 'Why'],
        [
          ['Name', 'You, directly', 'Not a credential. Routing a spelling fix through an approval queue teaches people to ignore the queue'],
          ['Mobile', 'Request → administrator approves', 'The mobile is how somebody logs in. Changing it locks the resident out'],
          ['Email', 'Request → administrator approves', 'Password reset codes go to the email on file. Whoever can rewrite it can receive somebody else’s reset'],
        ],
      )}
      ${steps([
        ['**Open the resident** and edit the field.'],
        ['For a mobile or an email, **give a short reason** — it goes to the administrator with the request.'],
        ['**Send the request.** It applies when it is approved, not when you send it.'],
        ['**Check back on Home** if you are unsure whether a request is still waiting.'],
      ])}
      ${box('Mobile numbers carry a country code',
        'Numbers are stored in international format, because a number of owners live abroad. If a number is rejected, that is usually why.')}
      ${box('Forgotten passwords are not yours to reset',
        'Ask the resident to use **Forgotten your password?** on the login page. A code goes to their own email, so nobody else ever holds their password. If the email on file is wrong, that is a request to the administrator first.')}`,
  }));

  /* ── 8 · notices ───────────────────────────────────────────────────── */
  out.push(page({
    head: HEAD, section: '8 · Notices', foot: 'Notices', n: next(),
    body: `
      <div>
        <p class="eyebrow">Section 8</p>
        <h1>Notices</h1>
        <p class="dek">How the association tells the building something. Residents see
          notices under the Notices tab.</p>
      </div>
      ${box('Not in the admin console',
        'A notice is written and managed on the **notice board itself**, under Notices in the main navigation. If you have been looking for a Notices tab under Admin, there is not one.')}
      ${figure('admin-notices', { caption: 'The notice board, with the committee controls showing.' })}
      ${box('Who sees what',
        'A notice can go to the whole building, or to owners alone. A tenant cannot act on an AGM agenda, so some things genuinely are owners-only.')}`,
  }));

  out.push(page({
    head: HEAD, section: '8 · Notices', foot: 'Notices · Posting one', n: next(),
    body: `
      <h2>Posting a notice</h2>
      ${steps([
        ['**Open Notices** in the main navigation and turn on the management controls.'],
        ['**Write it.** Give it a title and the text — keep the title short, because the title is what residents see in the list.'],
        ['**Choose who sees it** — the whole building, or owners alone.'],
        ['**Decide about comments.** They are off unless you switch them on, one notice at a time.'],
      ])}
      ${box('Comments are opt-in for a reason',
        'A notice about a water shutdown does not need a comment thread. One asking for volunteers might. Residents are rate limited, so one person cannot flood a thread, and a comment can be hidden if it needs to be.')}
      ${box('Taking one down',
        'A notice has to be withdrawn from the board before it can be deleted for good, so a live notice cannot vanish by accident. Withdrawn notices are kept rather than destroyed.')}`,
  }));

  return out;
}
