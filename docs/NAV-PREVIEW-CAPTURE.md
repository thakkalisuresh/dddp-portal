# Re-shooting the menu-position preview tiles

The "Menu position" setting on the Me page (`public/js/profile.js`) shows four
**real screenshots**, one per option:

| File (`public/img/`)          | Option     | What it shows                                   |
| ----------------------------- | ---------- | ----------------------------------------------- |
| `nav-preview-default.png`     | Automatic  | a phone (bottom bar) beside a desktop (top tabs) |
| `nav-preview-bottom.png`      | Bottom bar | a fixed bar along the bottom                     |
| `nav-preview-top.png`         | Top tabs   | a tab row across the top                         |
| `nav-preview-drawer.png`      | Left menu  | the left panel open over a scrim                 |

These are captured, not drawn, so they go stale **silently**. Both the nav
(`public/js/nav.js`, `public/css/app.css`) and the app bar are in every shot, so:

> **Re-shoot all four whenever the nav or the app bar changes** — a new item, a
> renamed label, a restyled bar, a new appbar control. A stale tile is a lie
> about what the option does.

The portal is light-only (see `tokens.css`), so there is **one** shot per option,
not a light/dark pair.

## What you need

All already on a Mac dev box; nothing is added to `package.json` (deliberately —
the repo carries no browser-automation dependency for four static images):

- Google Chrome (`--headless` captures a clean PNG at an exact size)
- `python3` (a throwaway static server)
- `sips` (built-in image resizer)

## Placeholder identity — never a real owner

Every shot is taken against a **stub** `me`: the navy app bar must read
`Flat 101 · Resident`. Never point the harness at a real `/api/me` — a real
owner's flat and name would be committed into a public repo.

## Steps

Run from the repo root.

### 1. Create the two throwaway harnesses under `public/`

`public/_tile.html` — one option, filling the viewport:

```html
<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="css/tokens.css"><link rel="stylesheet" href="css/app.css">
<style>html,body{overflow:hidden}#main{padding-top:var(--s-4)}#main h1{font-size:var(--text-lg);margin:0 0 var(--s-2)}</style>
</head><body>
<header class="appbar">
  <span class="appbar__who" id="who">Flat 101 <span>· Resident</span></span>
  <button class="appbar__action" id="logout" type="button">Log out</button>
</header>
<main class="page stack" id="main"><h1>Your bill</h1><div class="card"><p>₹ 1,240 due</p></div></main>
<script type="module">
  import { renderNav } from './js/nav.js';
  const p = new URLSearchParams(location.search);
  renderNav({ role:'resident', flat:'101', name:'Resident', navLayout:p.get('nav')||null, unreadNotices:0 }, '/dashboard');
  if (p.get('open') === '1') document.querySelector('.appbar__menu')?.click();  // drawer: show it open
</script>
</body></html>
```

`public/_tile-auto.html` — the Automatic composite (two real renders in iframes,
arranged; not faked):

```html
<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="css/tokens.css">
<style>
  html,body{margin:0;overflow:hidden}
  .stage{width:720px;height:480px;background:var(--paper);display:flex;align-items:center;justify-content:center;gap:56px}
  .device{background:#0F1626;border-radius:22px;box-shadow:0 6px 20px rgb(15 22 38 / .18)}
  .device iframe{border:0;display:block;background:var(--paper)}
  .phone{padding:12px;border-radius:30px}.phone iframe{width:168px;height:348px;border-radius:20px}
  .desk{padding:12px 12px 14px}.desk iframe{width:300px;height:200px;border-radius:10px}
  .neck{width:26px;height:14px;margin:0 auto;background:#0F1626}
  .stand{width:90px;height:12px;margin:8px auto 0;background:#0F1626;border-radius:0 0 6px 6px}
</style>
</head><body>
<div class="stage">
  <div class="device phone"><iframe src="_tile.html?nav=bottom" title="Phone, bottom bar"></iframe></div>
  <div><div class="device desk"><iframe src="_tile.html?nav=top" title="Desktop, top tabs"></iframe></div>
       <div class="neck"></div><div class="stand"></div></div>
</div>
</body></html>
```

### 2. Serve `public/`

```
( cd public && python3 -m http.server 8791 )
```

### 3. Capture at 720×480 CSS (1440×960 device px, retina)

`--force-device-scale-factor=2` doubles the output; `--window-size` is CSS px, so
720×480 gives a 720×480 CSS layout rendered at 1440×960.

```
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
shot() { "$CHROME" --headless=new --disable-gpu --hide-scrollbars \
  --force-device-scale-factor=2 --virtual-time-budget=1500 --window-size=720,480 \
  --screenshot="$1" "$2"; }

shot bottom.png "http://localhost:8791/_tile.html?nav=bottom"
shot top.png    "http://localhost:8791/_tile.html?nav=top"
shot drawer.png "http://localhost:8791/_tile.html?nav=drawer&open=1"
# Composite needs longer for its two iframes to load:
"$CHROME" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=2 \
  --virtual-time-budget=3000 --window-size=720,480 --screenshot=default.png \
  "http://localhost:8791/_tile-auto.html"
```

### 4. Downscale to 600 px wide, into `public/img/`

```
for k in default bottom top drawer; do
  sips --resampleWidth 600 "$k.png" --out public/img/nav-preview-$k.png
done
```

### 5. Clean up (ship nothing)

```
rm public/_tile.html public/_tile-auto.html bottom.png top.png drawer.png default.png
# stop the python server
```

### 6. Eyeball & commit

Open the Me page (or `profile.js` in a harness) and confirm each row's tile
matches its label. Commit the four `nav-preview-*.png` together with whatever nav
change prompted the re-shoot.
