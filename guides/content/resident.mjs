/**
 * The resident guide.
 *
 * Written for a phone. It goes to 99 flats as a forwarded PDF, so it is read at
 * A4 zoomed out on a small screen — short lines, one task per page, and a
 * screenshot on every page that has a step in it.
 *
 * Sentence length is held near 15–20 words with one idea each, because a good
 * number of readers are more comfortable in Malayalam than in English. That is
 * a today constraint, not a translation plan; the Malayalam pass is separate
 * work and needs a native speaker.
 *
 * Roles, never names — see the note at the top of admin.mjs.
 */
import { page, figure, box, warn, steps, plain, p, h3, table, split } from '../lib/render.mjs';

const HEAD = 'DD Diamond Park · Your gas bill';

export function pages({ version, date }) {
  const out = [];
  let n = 0;
  const next = () => (n += 1);

  /* ── cover ─────────────────────────────────────────────────────────── */
  out.push(page({
    cover: true,
    body: `
      <p class="mark">DD Diamond Park · Residents' Welfare Association</p>
      <h1>Your gas bill</h1>
      <p class="sub">How to see what you owe, pay it, and send the receipt —
        all from your phone.</p>
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
        <a><span class="n">1</span><span class="t">Logging in</span><span class="d">Your mobile number and password</span></a>
        <a><span class="n">2</span><span class="t">Setting yourself up</span><span class="d">The one screen you see once</span></a>
        <a><span class="n">3</span><span class="t">Your bill</span><span class="d">What you owe, and by when</span></a>
        <a><span class="n">4</span><span class="t">How it was worked out</span><span class="d">Gas used, rate, total</span></a>
        <a><span class="n">5</span><span class="t">Paying</span><span class="d">Any UPI app</span></a>
        <a><span class="n">6</span><span class="t">Sending the screenshot</span><span class="d">So your payment is matched</span></a>
        <a><span class="n">7</span><span class="t">If the upload is refused</span><span class="d">The three usual reasons</span></a>
        <a><span class="n">8</span><span class="t">Your details</span><span class="d">Name, email, password</span></a>
        <a><span class="n">9</span><span class="t">If you forget your password</span><span class="d">Getting back in</span></a>
        <a><span class="n">10</span><span class="t">Notices</span><span class="d">Announcements from the association</span></a>
        <a><span class="n">11</span><span class="t">Who to ask</span><span class="d">When something is wrong</span></a>
      </div>
      ${box('You only need your phone',
        'There is nothing to install. The portal is a website. Open **diamondpark.pages.dev** in your usual browser and add it to your home screen if you like.')}`,
  }));

  /* ── 1 · logging in ────────────────────────────────────────────────── */
  out.push(page({
    head: HEAD, section: '1 · Logging in', foot: 'Logging in', n: next(),
    body: `
      <div>
        <p class="eyebrow">Step 1</p>
        <h1>Logging in</h1>
        <p class="dek">Use the mobile number the association has for you.</p>
      </div>
      ${split(
        figure('login', { mobile: true }),
        `${steps([
          ['**Type your mobile number.** This is the number the association has on record for your flat.'],
          ['**Type your password.** Tap **Show** if you want to check what you typed.'],
          ['**Tap Log in.**'],
        ])}
        ${box('On a shared phone',
          'Untick **Keep me logged in** before you log in. Otherwise the next person to open the browser sees your bill.')}`,
        true,
      )}
      ${box('First time?',
        'You will have been given a temporary password. It expires, so use it soon. The next page is what you will see.')}`,
  }));

  /* ── 2 · setting yourself up ───────────────────────────────────────── */
  out.push(page({
    head: HEAD, section: '2 · Setting yourself up', foot: 'Setting yourself up', n: next(),
    body: `
      <div>
        <p class="eyebrow">Step 2</p>
        <h1>Setting yourself up</h1>
        <p class="dek">This appears once, the first time you log in. You cannot get past it,
          and you will not see it again.</p>
      </div>
      ${split(
        figure('onboarding', { mobile: true }),
        `${steps([
          ['**Check your name.** It was typed in from the association’s list and may be shortened or spelt oddly. Whatever you put here is what the committee sees.'],
          ['**Add your email if you have one.** It is optional. Give one and you can reset your own password whenever you forget it; leave it out and you have to ask someone to do it for you.'],
          ['**Choose a password.** At least eight characters with a number or a symbol in it. A short phrase like *two blue lemons* works, and is easier to remember than a word with a number stuck on the end.'],
        ])}
        ${box('Your mobile number is fixed',
          'It is shown but cannot be edited: it is what you log in with, and it is what ties you to your flat. If the number is wrong, tell the committee — you would not have got this far with the wrong one.')}`,
        true,
      )}
      ${box('You will be asked to log in again',
        'Finishing here signs you out everywhere, on purpose. Log back in with the password you just chose — that is also how you find out it works.')}`,
  }));

  /* ── 3 · your bill ─────────────────────────────────────────────────── */
  out.push(page({
    head: HEAD, section: '3 · Your bill', foot: 'Your bill', n: next(),
    body: `
      <div>
        <p class="eyebrow">Step 3</p>
        <h1>Your bill</h1>
        <p class="dek">The first screen after you log in. The big number is what you owe.</p>
      </div>
      ${split(
        figure('dashboard-top', { mobile: true }),
        `${plain([
          'The **month** the bill is for, at the top.',
          'The **amount** — this is the whole of what you owe.',
          'The **date to pay by**, underneath it.',
          'A **late fee**, on its own line, if one has been added.',
        ])}
        ${box('Overdue',
          'If the bill is past its date you will see **OVERDUE**, and a late fee may have been added. The late fee is part of the amount shown.')}`,
        true,
      )}
      ${box('Nothing is hidden in the amount',
        'What you are asked for is the gas you used at the month’s rate, plus a late fee only if one applies. Nothing else is folded into it.')}`,
  }));

  /* ── 4 · how it was worked out ─────────────────────────────────────── */
  out.push(page({
    head: HEAD, section: '4 · How it was worked out', foot: 'How it was worked out', n: next(),
    body: `
      <div>
        <p class="eyebrow">Step 4</p>
        <h1>How it was worked out</h1>
        <p class="dek">Scroll down and the portal shows you exactly how it reached that number.</p>
      </div>
      ${split(
        figure('dashboard-breakdown', { mobile: true }),
        `${h3('The four lines')}
        ${table(
          ['Line', 'What it is'],
          [
            ['Consumption', 'The gas you used this month, in kilograms'],
            ['Rate', 'The price per kilogram for that month'],
            ['Gas amount', 'Consumption × rate'],
            ['Total', 'Rounded up to the whole rupee'],
          ],
        )}`,
        true,
      )}
      ${box('Your meter, month by month',
        'Below the breakdown is your consumption over recent months, and every bill you have had. Touch a bar to see that month.')}
      ${box('Old bills do not change',
        'Each bill keeps the rate it was issued at. If the rate changes later, your past bills stay exactly as they were.')}`,
  }));

  /* ── 5 · paying ────────────────────────────────────────────────────── */
  out.push(page({
    head: HEAD, section: '5 · Paying', foot: 'Paying', n: next(),
    body: `
      <div>
        <p class="eyebrow">Step 5</p>
        <h1>Paying</h1>
        <p class="dek">Any UPI app. Google Pay, PhonePe, Paytm, or scan the QR code.</p>
      </div>
      ${steps([
        ['**Tap the Pay button.** It opens your UPI app with the amount already filled in.'],
        ['**Or choose your app** from the list underneath, if the button opens the wrong one.'],
        ['**Or tap Show QR code** and scan it with any UPI app.'],
        ['**Check the amount, then pay.**'],
      ])}
      ${warn('Two things matter',
        'Pay the **exact amount** shown. Not a rounded figure, not two months together.',
        'Leave the **payment reference** exactly as it is. That reference is how the portal knows the payment was yours. If you clear it, your payment has to be matched by hand.')}
      ${box('Paying another way',
        'If you cannot use UPI at all, **Pay another way** on the same screen explains what to do instead.')}`,
  }));

  /* ── 6 · sending the screenshot ────────────────────────────────────── */
  out.push(page({
    head: HEAD, section: '6 · Sending the screenshot', foot: 'Sending the screenshot', n: next(),
    body: `
      <div>
        <p class="eyebrow">Step 6</p>
        <h1>Sending the screenshot</h1>
        <p class="dek">After paying, send the receipt from your UPI app. This is what
          gets your bill marked paid.</p>
      </div>
      ${split(
        figure('proof-upload', { mobile: true }),
        `${steps([
          ['**Take a screenshot** in your UPI app, on the screen that says the payment succeeded.'],
          ['**Go back to the portal** and tap **Already paid? Upload screenshot**.'],
          ['**Tap Choose a screenshot** and pick the image you just took.'],
          ['**Wait a moment.** The portal reads the amount and the reference off the image.'],
        ])}`,
        true,
      )}
      ${box('What makes a good screenshot',
        'The whole screen, not a crop. Clear and unedited. The amount and the reference number both need to be readable — those are the two things the portal looks for.')}
      ${box('You do not have to wait',
        'Your payment is not lost if you do not upload anything. It just has to be matched against the bank statement by hand, which takes longer. Uploading is how it clears the same day.')}`,
  }));

  /* ── 7 · refusals ──────────────────────────────────────────────────── */
  out.push(page({
    head: HEAD, section: '7 · If the upload is refused', foot: 'If the upload is refused', n: next(),
    body: `
      <div>
        <p class="eyebrow">Step 7</p>
        <h1>If the upload is refused</h1>
        <p class="dek">There are three common reasons. None of them means your money is gone.</p>
      </div>
      ${table(
        ['What it says', 'What happened', 'What to do'],
        [
          ['The amount does not match your bill',
           'The amount on the screenshot is not the amount of the bill',
           'Check what you actually paid. If you paid the wrong amount, speak to the Treasurer — do not pay again first'],
          ['This screenshot has already been used',
           'That exact image was uploaded before, for this bill or another one',
           'Take a fresh screenshot of the payment and upload that instead'],
          ['This payment reference has already been used',
           'The reference on the screenshot is already recorded against another bill',
           'Check you are uploading this month’s payment and not last month’s'],
        ],
      )}
      ${box('If it still will not go through',
        'Do not keep retrying. Contact the portal administrator — flat 4A — with the screenshot, and it will be sorted out by hand.')}
      ${warn('Never pay twice to fix an upload problem',
        'A refused upload is a problem with the image, not with your payment. Paying again creates a second payment that then has to be refunded.')}`,
  }));

  /* ── 8 · your details ──────────────────────────────────────────────── */
  out.push(page({
    head: HEAD, section: '8 · Your details', foot: 'Your details', n: next(),
    body: `
      <div>
        <p class="eyebrow">Step 8</p>
        <h1>Your details</h1>
        <p class="dek">Under **Me**. Your name, your email, and your password.</p>
      </div>
      ${split(
        figure('profile', { mobile: true }),
        `${plain([
          'Your **name** and **email** you can change yourself.',
          'Your **flat** and **mobile number** you cannot — those identify you. Ask the Treasurer if either is wrong.',
          'Your **password** is changed from this same screen.',
        ])}`,
        true,
      )}
      ${warn('Add your email, before you need it',
        'If you forget your password, a code is sent to the email on your account. **A resident with no email on file cannot reset their own password.** Adding it now takes ten seconds and saves a phone call later.')}
      ${h3('Choosing a password')}
      ${plain([
        'It has to be long enough — the portal tells you if it is not.',
        'It must contain a number or a symbol.',
        'It cannot be something predictable, like your own name or your flat number.',
      ])}`,
  }));

  /* ── 9 · forgot ────────────────────────────────────────────────────── */
  out.push(page({
    head: HEAD, section: '9 · If you forget your password', foot: 'If you forget your password', n: next(),
    body: `
      <div>
        <p class="eyebrow">Step 9</p>
        <h1>If you forget your password</h1>
        <p class="dek">You can get back in yourself, without anybody else ever seeing
          your password.</p>
      </div>
      ${split(
        figure('forgot', { mobile: true }),
        `${steps([
          ['**Tap "Forgotten your password?"** on the login page.'],
          ['**Enter your mobile number** — the one you log in with.'],
          ['**Check your email** for the code. It expires, so use it promptly.'],
          ['**Enter the code** and choose a new password.'],
        ])}`,
        true,
      )}
      ${box('No email on your account?',
        'Then this cannot work, and you will need the Treasurer to help. This is the reason section 7 asks you to add your email now rather than later.')}
      ${box('If the code does not arrive',
        'Check the spam folder first. If you request codes repeatedly you will be asked to wait an hour — that limit exists to stop somebody else spamming your inbox.')}`,
  }));

  /* ── 10 · notices ───────────────────────────────────────────────────── */
  out.push(page({
    head: HEAD, section: '10 · Notices', foot: 'Notices', n: next(),
    body: `
      <div>
        <p class="eyebrow">Step 10</p>
        <h1>Notices</h1>
        <p class="dek">Announcements from the association, under the **Notices** tab.</p>
      </div>
      ${split(
        figure('notices', { mobile: true }),
        `${plain([
          'New notices show a count on the tab until you have read them.',
          'Some notices allow comments. Some do not — that is set for each notice.',
          'Some notices go to owners only, because a tenant cannot act on them.',
        ])}`,
        true,
      )}
      ${box('Commenting',
        'Where comments are open, your real name is shown next to what you write. There is a limit on how fast you can post, so a thread cannot be flooded.')}`,
  }));

  /* ── 11 · who to ask ───────────────────────────────────────────────── */
  out.push(page({
    head: HEAD, section: '11 · Who to ask', foot: 'Who to ask', n: next(),
    body: `
      <div>
        <p class="eyebrow">Step 11</p>
        <h1>Who to ask</h1>
        <p class="dek">Two different people, depending on what is wrong.</p>
      </div>
      ${table(
        ['If the problem is…', 'Ask'],
        [
          ['Your bill amount looks wrong', 'The Treasurer'],
          ['A meter reading looks wrong', 'The Treasurer'],
          ['A late fee you do not think you should have', 'The Treasurer'],
          ['Your name, flat or mobile number is wrong', 'The Treasurer'],
          ['You cannot log in at all', 'The portal administrator, flat 4A'],
          ['A page will not load', 'The portal administrator, flat 4A'],
          ['An upload keeps failing', 'The portal administrator, flat 4A'],
        ],
      )}
      ${box('The short version',
        'Anything about **money or meters** is the Treasurer. Anything about **the website itself** is the administrator in 4A.')}
      ${box('Where to find their numbers',
        'The committee page on the portal lists the current committee and how to reach them. It is kept up to date there, which is why this guide does not print numbers that would go stale.')}`,
  }));

  return out;
}
