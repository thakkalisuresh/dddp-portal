# UPI app marks

Drop the official SVGs here, named `gpay.svg`, `phonepe.svg`, `paytm.svg`,
`bhim.svg`. `public/js/dashboard.js` looks for exactly those names and falls
back to the coloured dot when a file is missing, so the page never breaks
while they are absent.

Self-hosted rather than linked, because the CSP is `default-src 'self'` and a
CDN request would simply be blocked.

Get them from each brand's own press or developer page, not from an image
search — the marks are trademarks and each has published rules on minimum size
and clear space. Do not recolour, stretch, or place them on a busy background.
