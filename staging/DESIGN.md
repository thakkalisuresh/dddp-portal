# The staging redesign

A ground-up rework of the portal's interface, built as a separate, self-contained
prototype. **Nothing in `public/` was touched.** This folder is static HTML, CSS
and ES modules with mock data — no server, no database, no build step.

Open `staging/index.html` for the reviewer's shell: every screen in a list, a
device frame, and switches for who you are, light or dark, and text size.
`staging/portal.html` is the prototype on its own, if you want it full size on a
phone.

---

## The brief, and what it actually implies

> Simple and easy to use, because non-technical people will be using it.

Everything below follows from taking that literally. The readership is retired
residents of a Thrissur apartment block, on mid-range Android phones, in
daylight, once a month, to answer one question: *what do I owe, and is it
settled?* Design for the person least likely to ring anyone when they get stuck.

The reference throughout is Apple's Human Interface Guidelines (installed as the
`apple-design` skill), read as general interface principles rather than as iOS
specifics. Where a guideline is cited below, it is because it decided something.

---

## What changed, and why

### 1 · System fonts instead of self-hosted webfonts

The old portal ships Lexend and Source Sans 3 as `.woff2` files — about 60 KB
before a single pixel is drawn. This uses the platform stack: SF Pro on iPhone,
Roboto on Android, Segoe on the committee's Windows laptops.

Three things follow. The first paint has no font download at all, which on Kerala
mobile data is the largest single improvement to how fast this *feels*. The text
already honours the reader's own system text-size setting rather than fighting
it. And the interface stops looking like a website and starts looking like the
phone it is on — which for this readership is the whole point, because they have
already learnt how their phone works.

> **HIG Typography** — "Access all system fonts — don't embed system fonts in
> your app."

### 2 · 17px base, and a text-size control on top of it

The HIG mobile default is 17pt with an 11pt floor. The old portal used an 18px
base, which was the right instinct; this keeps the generous base and adds three
sizes the reader can choose — Normal, Large, Largest, the last being 1.35× on top
of whatever their browser is already set to.

The scale is one CSS variable, so every step moves together and the hierarchy
survives the change rather than collapsing into one size.

> **HIG Accessibility** — "Ideally, give people the option to enlarge text by at
> least 200 percent."
> **HIG Typography** — "Maintain the relative hierarchy … when people adjust text
> sizes."

### 3 · Grouped lists on a recessed page

The single largest visual change. The page is grey, cards are white, rows sit in
cards with hairlines between them and never at the ends. Label on the left, value
on the right, a chevron only where tapping goes somewhere.

This is the pattern in the Settings app on every phone in the building. Nobody
has to be taught to read it, a row that navigates is visibly different from a row
that only states a fact, and a group of related rows reads as related without a
single border being drawn around it.

Corners went from 4px to 14px for the same reason — the radius is most of what
makes a group read as one object.

> **HIG Layout** — "Group related items … use negative space, background shapes,
> colors, materials, or separator lines to show when elements are related."

### 4 · Real dark mode

The old portal is light-only by explicit decision, with a `color-scheme: light`
override so a dark-preference viewer at least gets something legible. That was a
defensible call for v1; it is the wrong one for a phone held in a dark bedroom at
11 pm, which is when people check bills.

Dark mode here is not an inversion. The page goes to true black so an OLED screen
stops glowing, cards lift to `#1C1C1F`, and — the part that is usually got wrong
— the accent gets its own value. The light green `#056B4A` on a dark card measures
1.6:1 and is effectively invisible; dark mode uses `#3ED598`, which measures 9.1:1.

Three states: follow the phone, force light, force dark. The reader's choice
outranks the system, and it is remembered per device.

> **HIG Color** — "Make sure all your app's colors work well in light, dark, and
> increased contrast contexts … If you define a custom color, make sure to supply
> light and dark variants."

### 5 · Status is never carried by colour alone

Every status chip is a hue **and** a glyph **and** a word: a tick and "Paid", a
clock and "Checking", a triangle and "Overdue". Red-green colour blindness is
roughly one man in twelve, and paid-versus-overdue is exactly the red/green pair.

The same rule governs the tab bar: the current tab goes green *and* its label goes
bold, so it is still identifiable without colour vision.

> **HIG Accessibility** — "Convey information with more than color alone."

### 6 · Every contrast pair measured, not eyeballed

Checked in the browser against the real computed tokens, both themes:

| Pair | Light | Dark |
|---|---|---|
| Body text on a card | 17.9:1 | 15.6:1 |
| Secondary text on a card | 7.3:1 | 6.8:1 |
| Faintest text on the grey page | 5.1:1 | 6.5:1 |
| Accent on a card | 6.6:1 | 9.1:1 |
| Text on a filled accent button | 6.6:1 | 8.9:1 |
| Every status colour on its own tint | 5.7–6.6:1 | 5.9–8.1:1 |

The faintest grey failed on the first pass — `#79797F` measured 4.33:1 on white
and only **3.88:1 on the grey page**, which is the background that actually
matters for group titles and field hints. It is now `#66666D`. This is exactly
the failure that eyeballing does not catch: it looked fine.

### 7 · 48px targets, 12px of air

Buttons and rows are 48px, above the 44pt HIG minimum. Every button in a row of
buttons has 12px between it and the next, which is the difference between a shaky
hand hitting *Approve* and hitting *Reject*. Verified in the browser — there is no
interactive element under 44px on any screen.

> **HIG Accessibility** — "Include enough padding between elements to reduce the
> chance that someone taps the wrong control … about 12 points of padding around
> elements that include a bezel."

### 8 · Paying got its own screen

It was a section of the dashboard. It is now a full screen, because paying is the
one thing somebody came here to do and giving it the viewport removes every
competing target at the moment it matters.

The four routes are all still there and all still ordered by reliability — the
chooser first, named apps second, QR third, the UPI ID typed by hand fourth. The
warning that appears when a handoff fails is kept nearly word for word from the
production portal, because it was already right: it names what the UPI app did
rather than implying the resident's phone is broken.

### 9 · Plain language, everywhere

- "Pay before **20 September**", never "Due 20 Sept" — the fee lands at midnight
  that morning, so the deadline is stated as the instant it expires.
- "The treasurer is checking your payment. Nothing more to do."
- "August's gas is read in early September — that is why the dates do not match."
  This answers the single most-asked question the old portal never addressed on
  screen.
- On the proof screen: "A screenshot is not required." It never was; nobody said so.
- On a rejected payment: a reason, in the words the resident will read, so they
  know what to do rather than only that they were refused.

> **HIG Onboarding / Offering help** — teach in context, next to the thing being
> explained, rather than in a manual nobody opens.

### 10 · The committee's side is a board, not fourteen tabs

The old console opened on a tab strip that wrapped to two or three rows depending
on window width, so no tab had a stable position. The new home screen answers
"what needs me?" first, with counts you can tap, then where the month stands, then
everything else.

The month itself is four steps that open one at a time — the price of gas, the
meter walk, a check, then publishing. Two months were opened and abandoned on the
live portal because nothing said a reading could not be entered until the month
existed with a rate. Here step 2 is visibly locked until step 1 is done.

> **HIG Accessibility (cognitive)** — "Break up multistep workflows so people can
> focus on a single interaction per screen."

Publishing asks twice and says plainly what cannot be undone.

> **HIG Accessibility (cognitive)** — "Always ask for confirmation twice whenever
> people perform an action that's difficult to recover from."

### 11 · Loading shows the shape, not a spinner

Skeletons in the shape of the content, and inline banners next to the thing they
describe rather than toasts. Toasts are reserved for confirmations nobody needs to
read. Nothing dismisses on a timer that carries information.

> **HIG Loading** — "Show something as soon as possible."
> **HIG Feedback** — "Consider integrating status feedback into your interface …
> near the items it describes."

### 12 · Bottom tab bar on a phone, top row on a laptop

Four items maximum, thumb-reachable, and it converts to a centred pill row once
the window is wide — a bar pinned to the bottom of a 1400px laptop screen is a
long way from the content it navigates.

The bar's real height is measured and published as a CSS variable rather than
hard-coded, so the last row of a screen does not hide behind it when the text size
changes or the phone has a home indicator.

---

## Bugs found and fixed while building this

Worth recording, because most of them are the kind that survive a design review
and only show up when you run the thing:

1. **Dates were a day early.** `new Date('2026-09-20')` parses as UTC midnight,
   which west of Greenwich is the previous evening — a bill due on the 20th
   rendered as "19 September". Fixed by formatting explicitly in `Asia/Kolkata`,
   so every date is the *building's* date: an owner reading their bill from
   Toronto or Dubai sees the same 20 September the treasurer set. That approach
   is lifted from the production portal's `public/js/i18n.js`, which already
   solves this and solves it well — the comment there records the same bug being
   found and fixed for notice timestamps.
2. **The tab bar vanished on wide windows.** Appended after the content it became
   `position: sticky` relative to a place below the fold. It goes before `<main>`
   in the document now; `position: fixed` on a phone ignores document order anyway,
   and it also puts the bar where a screen reader expects it in the tab order.
3. **Chart bars were clamped.** As flex items with percentage heights they were
   shrunk to whatever the axis label left over, so every bar above ~65% came out
   identical and a chart of real variation read as a flat row. The bar is now
   absolutely positioned inside a track.
4. **A password field with no box.** The wrapper was built before `field()` was
   called, and `field()` appended the input straight back out of it.
5. **The word "null" above the login title.** `replaceChildren` stringifies null
   rather than skipping it, unlike the `el()` helper.
6. **Sheets opened scrolled past their own title,** because focus went to the
   first button inside them. The dialog focuses itself now, which is the correct
   modal pattern regardless.
7. **The segmented control truncated to "Not bil…"** at four options on a 375px
   phone. It scrolls instead — a half-visible fourth chip is its own affordance.

---

## Worth carrying back to production regardless of this design

One thing, and it is small:

- **The `--label-3`-equivalent contrast (#6 above).** `public/css/tokens.css` sets
  `--ink-muted: #52525B`, which is 7.4:1 on the warm paper and fine. But the
  measurement to repeat is against `--paper`, the page colour, not `--surface` —
  a grey checked only against white can still fail on the ground it actually sits
  on. That is what caught this prototype out.

I had also expected to find the UTC date bug in production and did not: `i18n.js`
formats everything in `Asia/Kolkata` already, which is the better answer, and this
prototype now copies it.

---

## What this prototype is not

- No real data, no API, no auth. `js/data.js` is shaped to match what `/api/me`
  and the admin endpoints actually return, so a screen can be pointed at the real
  API by swapping that one module — but nothing here talks to anything.
- Not every state of every screen. The five personas cover due, overdue, settled,
  owner-with-tenant, and treasurer; there are more (impersonation, exempt flats,
  a locked month) that are visible in code but not wired to the picker.
- Not accessibility-audited end to end. Contrast and target sizes are measured;
  a real screen-reader pass on a phone has not been done.

## Files

```
staging/
  index.html          the reviewer's shell — screen list, device frame, switches
  portal.html         the prototype on its own
  css/theme.css       tokens: colour, type scale, space, shape, both themes
  css/ui.css          components: lists, cards, chips, buttons, fields, sheets
  js/ui.js            el() helper, icon set, formatters, shared components
  js/data.js          mock data, shaped like the real API
  js/app.js           hash router, navigation bar, tab bar, theme and text state
  js/screens/auth.js       front door, login, forgotten password, first login
  js/screens/resident.js   bill, pay, proof, usage, notices, profile
  js/screens/admin.js      board, the month, bills, proofs, reconcile, building
```
