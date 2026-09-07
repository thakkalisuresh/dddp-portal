/**
 * Getting in: the public front door, the login, the forgotten password, and
 * the forced first password.
 *
 * These four carry more weight than their size suggests. A resident who cannot
 * get past them never sees anything else, and the people most likely to get
 * stuck here are the ones least likely to ring anyone about it.
 */

import { el, icon, svg, I, row, list, group, banner, field, passwordField, toast } from '../ui.js';

/* ═══ public front door ══════════════════════════════════════════════════ */

export function home(ctx) {
  return [
    el('section', { class: 'card', style: 'gap:var(--sp-5)' },
      el('div', { class: 'stack stack--xs' },
        el('p', { class: 'small muted' }, 'Kuriachira, Thrissur'),
        el('h1', { style: 'font-size:var(--t-large);letter-spacing:-0.03em' }, 'DD Diamond Park'),
        el('p', { class: 'muted' }, 'Residents’ Welfare Association')),
      el('button', { class: 'btn btn--lg btn--block', type: 'button', onclick: () => ctx.go('#/login') },
        'Log in'),
      el('p', { class: 'tiny muted', style: 'text-align:center' },
        'Your gas bill, notices, and payment history')),

    group('About the building', list(
      row({ title: '99 apartments', sub: 'Twenty floors, five to a floor', icon: 'home', tint: 'var(--info)' }),
      row({ title: 'Piped gas', sub: 'Metered per flat, billed monthly', icon: 'flame', tint: 'var(--warn)' }),
      row({ title: 'Clubhouse and pool', sub: 'Open 6 am to 9 pm', icon: 'users', tint: 'var(--accent)' }),
    )),

    group('Contact the committee', list(
      row({ title: 'Treasurer', sub: 'Billing, payments, meter readings', value: 'Call',
            icon: 'phone', tint: 'var(--accent)', onClick: () => toast('Would dial the treasurer') }),
      row({ title: 'Secretary', sub: 'Notices, meetings, the association', value: 'Email',
            icon: 'mail', tint: 'var(--info)', onClick: () => toast('Would open mail') }),
    ), 'Notices are behind the login. They are for residents, not for the internet.'),
  ];
}

/* ═══ login ══════════════════════════════════════════════════════════════
   One decision on the screen, and the smallest number of fields that can
   possibly work. The hint about the country code is shown from the start
   rather than after a failure, because the people it is for — owners in the
   Gulf — are exactly the ones who cannot easily ring somebody to ask.        */

export function login(ctx) {
  const err = el('div');
  const user = el('input', {
    class: 'input', type: 'text', autocomplete: 'username',
    inputmode: 'text', placeholder: '98470 21188',
  });
  const pw = passwordField('Password', { autocomplete: 'current-password' });

  const submit = () => {
    if (!user.value.trim()) {
      err.replaceChildren(banner('bad', el('div', {}, 'Type your mobile number or email address to log in.')));
      user.focus();
      return;
    }
    ctx.go('#/bill');
  };

  return [
    el('div', { class: 'stack stack--xs', style: 'padding-top:var(--sp-6)' },
      el('h1', { class: 'largetitle' }, 'Log in'),
      el('p', { class: 'largetitle__sub' }, 'DD Diamond Park residents')),

    err,

    el('form', { class: 'stack', onsubmit: (e) => { e.preventDefault(); submit(); } },
      field('Mobile number or email', user,
        { hint: 'Living outside India? Put your country code in front — +971 50 442 8810.' }),
      pw,
      el('label', { class: 'checkline' },
        el('input', { type: 'checkbox', checked: true }),
        el('span', {}, 'Keep me logged in',
          el('span', { class: 'checkline__hint' }, 'Turn this off on a shared phone'))),
      el('button', { class: 'btn btn--lg btn--block', type: 'submit' }, 'Log in')),

    el('button', { class: 'btn btn--plain btn--block', type: 'button', onclick: () => ctx.go('#/forgot') },
      'I have forgotten my password'),

    el('div', { class: 'card card--tight' },
      el('p', { class: 'small muted' },
        'No email address on your account? The treasurer can set a new password for you — call ',
        el('strong', {}, '98950 11002'), '.')),

    // The demo shortcut. Not part of the design — it is how a reviewer moves
    // between the five people this prototype knows how to be.
    el('details', { class: 'disclose' },
      el('summary', {}, icon('eye', { size: 20 }), 'Prototype: log in as…'),
      el('div', { class: 'disclose__body' },
        ...Object.entries(ctx.personas).map(([key, p]) => row({
          title: p.label, sub: p.blurb, icon: p.role === 'admin' ? 'shield' : 'person',
          tint: p.role === 'admin' ? 'var(--bad)' : 'var(--accent)',
          onClick: () => { ctx.setPersona(key); ctx.go(p.role === 'admin' ? '#/admin' : '#/bill'); },
        })))),
  ];
}

/* ═══ forgotten password ═════════════════════════════════════════════════
   Three states on one screen rather than three screens, because the whole
   flow is over in under a minute and a page change in the middle of it is
   where people lose their place.                                            */

export function forgot(ctx) {
  const stage = ctx.state.forgotStage ?? 'ask';
  const next = (s) => { ctx.state.forgotStage = s; ctx.render(); };

  if (stage === 'sent') {
    const boxes = el('div', { class: 'row', style: 'gap:var(--sp-2);justify-content:center' },
      ...Array.from({ length: 6 }, (_, i) => el('input', {
        class: 'input input--num', inputmode: 'numeric', maxlength: '1',
        'aria-label': `Digit ${i + 1} of 6`,
        style: 'width:48px;text-align:center;padding:var(--sp-3) 0;font-size:var(--t-title2);font-weight:600',
      })));
    return [
      el('h1', { class: 'largetitle' }, 'Check your email'),
      banner('good', el('div', {},
        'We sent a six-digit code to ', el('strong', {}, 'r•••••n@gmail.com'), '. It works for 15 minutes.')),
      el('div', { class: 'card' },
        el('p', { class: 'field__label' }, 'Type the code'),
        boxes,
        el('p', { class: 'field__hint', style: 'text-align:center' }, 'It may take a minute. Check your spam folder.')),
      el('button', { class: 'btn btn--lg btn--block', type: 'button', onclick: () => next('reset') }, 'Continue'),
      el('button', { class: 'btn btn--plain btn--block', type: 'button', onclick: () => toast('Code sent again') }, 'Send the code again'),
    ];
  }

  if (stage === 'reset') {
    return [
      el('h1', { class: 'largetitle' }, 'Choose a new password'),
      el('div', { class: 'card' },
        el('div', { class: 'stack' },
          passwordField('New password', { autocomplete: 'new-password', hint: 'At least 10 characters.' }),
          passwordField('Type it again', { autocomplete: 'new-password' }))),
      rules(),
      el('button', {
        class: 'btn btn--lg btn--block', type: 'button',
        onclick: () => { ctx.state.forgotStage = 'ask'; toast('Password changed — now log in'); ctx.go('#/login'); },
      }, 'Save and log in'),
    ];
  }

  return [
    el('div', { class: 'stack stack--xs', style: 'padding-top:var(--sp-6)' },
      el('h1', { class: 'largetitle' }, 'Forgotten password'),
      el('p', { class: 'largetitle__sub' }, 'We will email you a code')),
    field('Mobile number or email', el('input', { class: 'input', type: 'text', placeholder: '98470 21188' }),
      { hint: 'Whichever you used to log in. The code goes to the email address on your account.' }),
    el('button', { class: 'btn btn--lg btn--block', type: 'button', onclick: () => next('sent') }, 'Send me a code'),
    el('div', { class: 'card card--tight' },
      el('p', { class: 'small muted' },
        'No email address on your account? Call the treasurer on ', el('strong', {}, '98950 11002'),
        ' and he will set a new password with you on the phone.')),
    el('button', { class: 'btn btn--plain btn--block', type: 'button', onclick: () => ctx.go('#/login') }, 'Back to login'),
  ];
}

/* ═══ first login ════════════════════════════════════════════════════════
   Forced, and the only screen in the app with no way out — but it explains
   why, which the old one did not.                                           */

export function setPassword(ctx) {
  return [
    el('div', { class: 'stack stack--xs', style: 'padding-top:var(--sp-6)' },
      el('h1', { class: 'largetitle' }, 'Set your password'),
      el('p', { class: 'largetitle__sub' }, 'Just this once — then you are in')),
    banner('info', el('div', {},
      'You logged in with the temporary password the committee sent you. Choose your own now so nobody else who saw that message can use it.')),
    el('div', { class: 'card' },
      el('div', { class: 'stack' },
        passwordField('New password', { autocomplete: 'new-password' }),
        passwordField('Type it again', { autocomplete: 'new-password' }))),
    rules(),
    el('button', { class: 'btn btn--lg btn--block', type: 'button', onclick: () => ctx.go('#/bill') }, 'Save and continue'),
  ];
}

/** The rules, stated as a checklist rather than as a paragraph of refusals. */
function rules() {
  const items = [
    ['At least 10 characters', true],
    ['Not your flat number or your name', true],
    ['Not your mobile number', true],
    ['Something you have not used on another site', false],
  ];
  return group('What makes a good one', el('div', { class: 'list' },
    ...items.map(([text, hard]) => row({
      title: text, icon: hard ? 'check' : 'info',
      tint: hard ? 'var(--accent)' : 'var(--label-3)', chev: false,
    }))));
}
