/**
 * The public home page — screen 01.
 *
 * Nothing here requires a session, and nothing here may expose resident data:
 * notices are public, but comments (which carry names and flats) are not, and
 * the committee list is a deliberate hard-coded set rather than a query over
 * the resident register.
 */

import { el, esc, $, showError, setChildren } from './ui.js';
import { dayLabel, bilingual } from './i18n.js';

const main = $('#main');

init();

async function init() {
  try {
    const res = await fetch('/api/public/notices');
    const data = await res.json();
    render(data);
  } catch {
    showError(main, { message: 'Could not load notices. Please try again shortly.' });
  }
}

function render({ notices, committee, amenities }) {
  const events = notices.filter((n) => n.kind === 'event');
  const plain = notices.filter((n) => n.kind !== 'event');

  setChildren(main,
    section('notices', bilingual('notices'),
      plain.length
        ? plain.map((n) => el('div', { class: 'notice' },
            el('h3', {}, n.title),
            el('p', { class: 'muted' }, n.body),
            el('p', { class: 'small muted', style: 'margin-top:var(--s-2)' }, dayLabel(n.postedAt))))
        : [el('p', { class: 'muted' }, 'Nothing posted yet.')]),

    events.length
      ? section('events', bilingual('events'), events.map((n) =>
          el('div', { class: 'notice notice--event' },
            el('h3', {}, n.title),
            el('p', { class: 'muted' }, n.body),
            n.eventDate ? el('p', { class: 'small muted' }, dayLabel(n.eventDate)) : null)))
      : null,

    section('gallery', bilingual('gallery'), [
      el('div', { class: 'tiles' },
        ...['Club house', 'Swimming pool', 'Jogging park', 'Children\'s play area',
            'Sports ground', 'Green parks'].map((label) => el('div', { class: 'tile' }, label))),
      el('p', { class: 'small muted' }, 'Photographs of the building go here.'),
    ]),

    section('amenities', bilingual('amenities'), [
      el('div', { class: 'amenities' },
        ...amenities.map((a) => el('span', { class: 'amenity' }, a))),
    ]),

    section('committee', 'Committee', [
      el('table', { class: 'committee' },
        el('tbody', {}, ...committee.map((c) =>
          el('tr', {},
            el('td', {}, el('div', { class: 'role' }, c.role),
              el('div', {}, `${c.name} · ${c.flat}`)),
            el('td', { class: 'r small muted', style: 'text-align:right' }, c.phone ?? ''))))),
    ]),

    section('contact', bilingual('contact'), [contactForm()])
  );
}

function section(id, heading, children) {
  return el('section', { id, class: 'stack' },
    el('hr', { class: 'rule' }),
    el('h2', { html: heading }),
    ...(Array.isArray(children) ? children : [children]));
}

function contactForm() {
  const status = el('div');
  const field = (label, attrs) => {
    const input = el(attrs.tag ?? 'input', { class: 'input', id: attrs.id, ...attrs });
    return { input, node: el('div', { class: 'field' }, el('label', { for: attrs.id }, label), input) };
  };

  const name = field('Your name', { id: 'c-name', autocomplete: 'name' });
  const email = field('Email (optional)', { id: 'c-email', type: 'email', autocomplete: 'email' });
  const phone = field('Phone (optional)', { id: 'c-phone', type: 'tel', autocomplete: 'tel' });
  const body = field('How can we help?', { id: 'c-body', tag: 'textarea', style: 'min-height:110px' });

  const submit = el('button', { class: 'btn', type: 'submit' }, 'Send message');

  const form = el('form', { class: 'stack' },
    name.node, email.node, phone.node, body.node, status, submit);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    submit.disabled = true;
    submit.textContent = 'Sending…';
    try {
      const res = await fetch('/api/public/contact', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: name.input.value, email: email.input.value,
          phone: phone.input.value, body: body.input.value,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error?.message ?? 'Could not send that.');
      form.replaceChildren(el('div', { class: 'note note--good' },
        'Thank you — the committee has your message and will get back to you.'));
    } catch (err) {
      submit.disabled = false;
      submit.textContent = 'Send message';
      showError(status, err);
    }
  });

  return form;
}
