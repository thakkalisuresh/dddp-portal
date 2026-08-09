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

/**
 * The association's own photographs, rescued from the old portal before that
 * hosting lapses — nobody here has access to renew it. Resized from 6.5 MB to
 * under 900 KB for the whole set, because this page loads on phone data.
 *
 * Intrinsic dimensions are declared so the grid does not reflow as they arrive;
 * without them the committee list jumps down the page mid-load.
 */
const GALLERY = [
  { src: 'clubhouse.jpg', w: 1200, h: 853 },
  { src: 'pool.jpg',      w: 1200, h: 675 },
  { src: 'garden.jpg',    w: 1200, h: 675 },
  { src: 'play-area.jpg', w: 1200, h: 675 },
  { src: 'sports.jpg',    w: 1200, h: 848 },
  { src: 'jogging.jpg',   w:  994, h: 1200 },
];

/**
 * No captions. The filenames are guesses made while rescuing these from the
 * old site and several were plainly wrong once rendered — the one labelled
 * 'Swimming pool' is an aerial of the towers, 'Jogging park' is the signage.
 * A wrong caption is worse than none, and the amenities list right below
 * already says what the place has.
 */
function tile({ src, w, h }) {
  return el('div', { class: 'gallery__item' },
    el('img', {
      class: 'gallery__img',
      src: `/img/${src}`,
      width: w, height: h,
      // Six photographs below the fold; none of them should block the notices.
      loading: 'lazy', decoding: 'async',
      // Deliberately generic: it is the one thing true of every photograph
      // here, and guessing per image is how the captions went wrong.
      alt: 'DD Diamond Park',
    }));
}

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
      el('div', { class: 'gallery' }, ...GALLERY.map(tile)),
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
        'Thank you. The committee has your message and will get back to you.'));
    } catch (err) {
      submit.disabled = false;
      submit.textContent = 'Send message';
      showError(status, err);
    }
  });

  return form;
}
