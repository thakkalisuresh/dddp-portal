# UPI app marks

Drop the official SVGs here, named `gpay.svg`, `phonepe.svg` and `paytm.svg`.
`public/js/dashboard.js` looks for exactly those names and falls back to a
lettered tile in the brand's colour when a file is missing, so the page never
breaks while they are absent.

**One file at a time is fine.** The fallback is per-app and swaps on the image's
own `error` event, so three brands can arrive on three different days and each
appears the moment its file is added. Nothing else changes — no code, no build,
no deploy step beyond the usual one.

(`bhim.svg` was listed here and is not used: the pay screen offers Google Pay,
PhonePe and Paytm. Add BHIM to `UPI_APPS` in `dashboard.js` first if it is ever
wanted.)

Self-hosted rather than linked, because the CSP is `default-src 'self'` and a
CDN request would simply be blocked.

Get them from each brand's own press or developer page, not from an image
search — the marks are trademarks and each has published rules on minimum size
and clear space. Do not recolour, stretch, or place them on a busy background.
