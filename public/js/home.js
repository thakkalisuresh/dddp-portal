/**
 * The public home page — screen 01.
 *
 * Nothing here requires a session, and nothing here may expose resident data.
 *
 * Notices used to lead this page and are gone (B16) — they are the association
 * talking to the people who live here, and residents read them at /notices
 * behind a login. What is left is genuinely public: the photographs, what the
 * building has, who to ask, where it is, and when the office is open.
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

/**
 * Kuriachira, Thrissur — the NEIGHBOURHOOD, not the building.
 *
 * DD Diamond Park is not in OpenStreetMap, so there is no honest way to drop a
 * pin on it from here. These coordinates are the centre of Kuriachira as
 * OpenStreetMap knows it, confirmed against postcode 680006 in the footer, and
 * the map deliberately carries NO marker: a marker is a claim about where the
 * building is, and a confident pin on the wrong gate sends a visitor to the
 * wrong road. Replace with the building's own coordinates once somebody who
 * lives there confirms them, and add `&marker=LAT,LON` at the same time.
 */
const LOCATION = { lat: 10.5036, lon: 76.2245 };
const SPAN = { lat: 0.004, lon: 0.006 };

// toFixed, because 10.5036 - 0.004 is 10.499600000000001 in binary floating
// point and that lands verbatim in the URL. Harmless to the map, but it is the
// kind of thing that gets copied into a bug report and wastes an hour.
const MAP_EMBED = 'https://www.openstreetmap.org/export/embed.html?layer=mapnik&bbox='
  + [LOCATION.lon - SPAN.lon, LOCATION.lat - SPAN.lat,
     LOCATION.lon + SPAN.lon, LOCATION.lat + SPAN.lat]
    .map((n) => n.toFixed(4)).join('%2C');

/**
 * Google rather than OpenStreetMap for the link, even though the embed is OSM.
 * A plain search URL needs no API key, and directions are what somebody
 * actually taps this for — which on nearly every phone here means Google Maps.
 */
const MAP_LINK = 'https://www.google.com/maps/search/?api=1&query=Kuriachira%2C+Thrissur';

const main = $('#main');

init();

async function init() {
  try {
    const res = await fetch('/api/public/notices');
    const data = await res.json();
    render(data);
  } catch {
    showError(main, { message: 'Could not load the page. Please try again shortly.' });
  }
}

function render({ committee, amenities, officeHours, subjects }) {
  setChildren(main,
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

    section('location', 'Where we are', [
      el('div', { class: 'map' },
        // NOT loading="lazy", deliberately, and this was measured rather than
        // assumed: with it set, scrolling the map into view and waiting five
        // seconds never fired the load event, leaving exactly the empty box
        // this whole item is about. The six gallery photographs keep lazy —
        // images honour it — but this is one request and a blank map is a
        // worse trade than one eager frame.
        el('iframe', {
          class: 'map__frame', src: MAP_EMBED,
          title: 'Map of Kuriachira, Thrissur',
        })),
      // Always present, never conditional. The iframe is the one thing on this
      // page that depends on a third party being up and on the CSP being right,
      // and a blank grey box with no way out is the failure this avoids.
      el('p', { class: 'small' },
        el('a', { href: MAP_LINK, rel: 'noopener', target: '_blank' },
          'Open in Google Maps')),
      el('p', { class: 'small muted' }, 'Kuriachira, Thrissur 680006'),
    ]),

    section('hours', 'Office hours', [
      el('table', { class: 'committee' },
        el('tbody', {}, ...(officeHours ?? []).map((h) =>
          el('tr', {},
            el('td', {}, h.days),
            el('td', { class: 'small muted', style: 'text-align:right' }, h.hours))))),
    ]),

    section('contact', bilingual('contact'), [contactForm(subjects)])
  );
}

function section(id, heading, children) {
  return el('section', { id, class: 'stack' },
    el('hr', { class: 'rule' }),
    el('h2', { html: heading }),
    ...(Array.isArray(children) ? children : [children]));
}

function contactForm(subjects) {
  const status = el('div');
  const field = (label, attrs) => {
    const input = el(attrs.tag ?? 'input', { class: 'input', id: attrs.id, ...attrs });
    return { input, node: el('div', { class: 'field' }, el('label', { for: attrs.id }, label), input) };
  };

  // Options come from the server, so what the visitor can pick and what the
  // server will accept are the same list. The blank first option is selected by
  // default on purpose: a pre-selected subject is one nobody reads, and every
  // message would arrive filed under whatever sits at the top.
  const subject = el('select', { class: 'input', id: 'c-subject' },
    el('option', { value: '' }, 'What is this about?'),
    ...(subjects ?? []).map((s) => el('option', { value: s }, s)));
  const subjectNode = el('div', { class: 'field' },
    el('label', { for: 'c-subject' }, 'Subject'), subject);

  const name = field('Your name', { id: 'c-name', autocomplete: 'name' });
  const email = field('Email (optional)', { id: 'c-email', type: 'email', autocomplete: 'email' });
  const phone = field('Phone (optional)', { id: 'c-phone', type: 'tel', autocomplete: 'tel' });
  const body = field('How can we help?', { id: 'c-body', tag: 'textarea', style: 'min-height:110px' });

  const submit = el('button', { class: 'btn', type: 'submit' }, 'Send message');

  const form = el('form', { class: 'stack' },
    name.node, email.node, phone.node, subjectNode, body.node, status, submit);

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
          phone: phone.input.value, subject: subject.value, body: body.input.value,
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
