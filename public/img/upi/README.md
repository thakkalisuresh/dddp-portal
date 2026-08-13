# UPI app marks

`gpay.svg`, `phonepe.svg` and `paytm.svg` are the marks shown beside each app
on the pay screen. `public/js/dashboard.js` looks for exactly those names and
falls back to a lettered tile in the brand's colour if one is missing, so the
page never breaks — the fallback is per-app, so removing one file affects only
its own row.

Self-hosted rather than linked, because the CSP is `default-src 'self'` and a
CDN request would simply be blocked.

## Where these came from

Added 2026-08-13. The files are the **Simple Icons** brand glyphs
(<https://simpleicons.org>), taken from `simple-icons/simple-icons` on GitHub —
`icons/googlepay.svg`, `icons/phonepe.svg`, `icons/paytm.svg`. Those files are
released **CC0**; the marks they depict remain the trademarks of Google,
PhonePe and Paytm respectively.

One edit was made to each: a `fill` of the brand's own colour was set on the
root `<svg>`. Simple Icons ships monochrome paths with no fill, which render
black, and the mark is loaded through an `<img>` — so no stylesheet on the page
can reach inside it and the colour has to be baked into the file.

    gpay.svg     #1A73E8
    phonepe.svg  #5F259F
    paytm.svg    #00BAF2

Those are the same three colours `UPI_APPS` in `dashboard.js` already used for
the fallback tiles, so a row looks the same whichever is showing.

## Replacing one

Official press-kit artwork is better than a single-colour glyph if you have it,
and dropping a file in is the whole installation — no code change. Keep the
filename, keep the viewBox square-ish, and remember these render at 30×30:
anything with fine detail or a long wordmark will not survive the size.

Get replacements from each brand's own press or developer page rather than an
image search, so you know what you are shipping. Do not stretch them, and do
not place them on a busy background.

## Not used

There is no `bhim.svg`, and BHIM is not on the pay screen. It would need adding
to `UPI_APPS` in `dashboard.js` first; the file alone would do nothing.
