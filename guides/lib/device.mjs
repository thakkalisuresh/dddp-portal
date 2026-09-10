/**
 * Draw a phone around a capture.
 *
 * Two things this fixes, both reported from the first draft:
 *
 *   1. Numbered badges were drawn ON the screenshot, landing on top of the very
 *      buttons the reader is being told to tap. Here they live in a rail beside
 *      the phone and reach their control with a leader line. Nothing is ever
 *      drawn over a control.
 *   2. The "phone" was a rounded rectangle with a shadow. Here it has a bezel,
 *      a real corner radius and the device's own status bar, because the
 *      capture comes off a booted simulator rather than a headless viewport.
 *
 * Mark boxes are percentages of the image and are measured by lib/measure.mjs,
 * so a capture can be scaled to any column and the badges follow it.
 */

const esc = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * @param {object} shot   { file, w, h, marks: [{n, top, height}] }
 * @param {object} opts   screenMm: width of the SCREEN, not the device
 */
export function device(shot, {
  screenMm = 46, only = null, rail = true, railMm = 13, url = null,
  scrim = false, sheet = '', caption = null, align = 'center', urlAt = 'bottom',
  trimTop = 0, trimBottom = 0, draw = null, ratio = null,
} = {}) {
  const fullH = screenMm * (ratio ?? (shot.h / shot.w));
  const screenH = fullH * (1 - (trimTop + trimBottom) / 100);
  const bezel = Math.max(1.1, screenMm * 0.022);
  const imgStyle = trimTop
    ? ` style="height:${fullH.toFixed(2)}mm;margin-top:-${(fullH * trimTop / 100).toFixed(2)}mm"`
    : '';

  const visible = 100 - trimTop - trimBottom;
  const rescale = (pct) => ((pct - trimTop) / visible) * 100;
  const urlTop = rescale(urlAt === 'top' ? 7.3 : (shot.pill?.top ?? 90.3));
  // Cover the whole pill, not just its middle. A fixed padding left a sliver of
  // the dev host showing above the patch on the taller toolbar.
  const urlH = urlAt === 'top' ? 0 : (shot.pill?.height ?? 0) * (100 / (100 - trimTop - trimBottom));

  const marks = (shot.marks ?? []).filter((m) => !only || only.includes(m.n));

  /**
   * `rail: 'below'` positions badges by their measured X instead of their Y.
   *
   * The vertical rail assumes the controls being pointed at are stacked, which
   * is true of a form and false of a tab strip: six tabs in two rows gave four
   * badges an identical Y, and a vertical rail would have stacked all four at
   * one height — four numbers on top of each other, pointing at nothing you
   * could tell apart. The badges still never sit on a control; they sit in a
   * strip under the device with a leader line running up to it.
   */
  // 'above' and 'below' both place badges by X. Which one is right depends on
  // where the controls sit: a leader line has to reach its target, and a rail
  // under the phone pointing at a tab strip at the top of the screen leaves a
  // 5mm stub aimed at nothing.
  const horizontal = rail === 'below' || rail === 'above';
  const above = rail === 'above';
  const pins = marks.map((m) => {
    if (horizontal) {
      const x = (m.left ?? 0) + (m.width ?? 0) / 2;
      return `<span class="pin" style="left:${x.toFixed(2)}%"><i></i><b>${m.n}</b></span>`;
    }
    const y = rescale(m.top + m.height / 2);
    return `<span class="pin" style="top:${y.toFixed(2)}%"><i></i><b>${m.n}</b></span>`;
  }).join('');

  return `<figure class="dev-fig dev-fig--${align}">
  <div class="dev${horizontal ? ' dev--hrail' : ''}${above ? ' dev--hrail-above' : ''}" style="--sw:${screenMm}mm;--sh:${screenH.toFixed(2)}mm;--bz:${bezel.toFixed(2)}mm;--rail:${rail && pins && !horizontal ? railMm : 0}mm">
    ${rail && pins && above ? `<div class="dev-hrail dev-hrail--above">${pins}</div>` : ''}
    <div class="dev-body">
      <div class="dev-screen">
        ${draw ? draw : `<img src="${esc(shot.file)}" alt=""${imgStyle}>`}
        ${scrim ? '<span class="dev-scrim"></span>' : ''}
        ${sheet}
        ${url ? `<span class="dev-url dev-url--${urlAt}" style="top:${urlTop.toFixed(2)}%${urlH ? `;height:${urlH.toFixed(2)}%` : ''}">${esc(url)}</span>` : ''}
      </div>
    </div>
    ${rail && pins && !horizontal ? `<div class="dev-rail">${pins}</div>` : ''}
    ${rail && pins && horizontal && !above ? `<div class="dev-hrail">${pins}</div>` : ''}
  </div>
  ${caption ? `<figcaption>${esc(caption)}</figcaption>` : ''}
</figure>`;
}

/**
 * The Android "Open with" sheet.
 *
 * DRAWN, NOT CAPTURED — but drawn against a real one. The test emulator has no
 * UPI app installed (`pm query-activities` for `upi://pay` returns nothing), so
 * the chooser cannot be photographed with the apps a resident would see, and
 * sideloading stubs named "Google Pay" would be faking a screenshot.
 *
 * The first version of this drawing was wrong: a horizontal row of round tiles,
 * which is an older Android chooser. Opening a PDF on the emulator produced a
 * genuine chooser (Drive and Chrome both handle it), and the real sheet is a
 * VERTICAL LIST — square icon, app name, optional subtitle, with Just once and
 * Always at the bottom right. This now matches that.
 */
export function androidChooser(apps = [
  { initials: 'GP', label: 'Google Pay', colour: '#1A73E8' },
  { initials: 'Pe', label: 'PhonePe', colour: '#5F259F' },
  { initials: 'Pm', label: 'Paytm', colour: '#00BAF2' },
]) {
  return `<div class="sheet-and">
    <div class="sheet-and__title">Open with</div>
    <div class="sheet-and__apps">
      ${apps.map((a) => `<div class="sheet-and__app">
        <span class="ic" style="background:${a.colour}">${esc(a.initials)}</span>
        <span class="lb">${esc(a.label)}</span>
      </div>`).join('')}
    </div>
    <div class="sheet-and__acts"><span>Just once</span><span>Always</span></div>
  </div>`;
}


/**
 * The Google Pay payment screen, DRAWN.
 *
 * Not a capture, and it cannot be one: the test emulator has no UPI app, and a
 * real Google Pay screen would carry a real account and a real balance. It is
 * drawn to the app's actual layout on purpose — the guide goes to residents who
 * will recognise the shape of the screen faster than they will read a
 * description of it, which is the whole reason it is here rather than a generic
 * illustration.
 *
 * The mark is the Simple Icons glyph the portal already self-hosts (CC0; the
 * mark itself remains Google's trademark — see public/img/upi/README.md).
 * Every figure and name on the screen is the association's own example data.
 */
export function gpayScreen({ amount = '312', payee = 'DD DIAMOND PARK RWA',
  vpa = 'qr.ddwelfare@sib', note = '(2B_09_08_26)' } = {}) {
  return `<div class="gpay">
    <div class="gpay__bar">
      <span class="gpay__back">‹</span>
      <img class="gpay__mark" src="marks/gpay.svg" alt="">
    </div>
    <div class="gpay__to">
      <span class="gpay__av">D</span>
      <span class="gpay__who"><b>${esc(payee)}</b><i>${esc(vpa)}</i></span>
    </div>
    <div class="gpay__amt"><span>₹</span>${esc(amount)}</div>
    <div class="gpay__note">${esc(note)}</div>
    <div class="gpay__from">
      <span class="gpay__bank"></span>
      <span>Paying from<br><b>Bank account ···· 4417</b></span>
      <span class="gpay__chev">›</span>
    </div>
    <div class="gpay__cta">Pay ₹${esc(amount)}</div>
  </div>`;
}

/** The stylesheet these two need. Kept beside them so they travel together. */
export const DEVICE_CSS = `
.dev-fig{margin:0;display:flex;flex-direction:column;gap:2mm}
.dev-fig--center{align-items:center}
.dev-fig--left{align-items:flex-start}
.dev{display:flex;align-items:flex-start}
.dev-body{position:relative;flex:0 0 auto;
  width:calc(var(--sw) + var(--bz)*2);height:calc(var(--sh) + var(--bz)*2);
  background:linear-gradient(150deg,#3A4A43,#1B2A24 38%,#0E1713 70%,#2E3D36);
  border-radius:calc(var(--bz)*4.6);padding:var(--bz);
  box-shadow:0 .3mm 0 rgba(255,255,255,.22) inset}
.dev-screen{position:relative;width:100%;height:100%;overflow:hidden;background:#fff;
  border-radius:calc(var(--bz)*3.6);line-height:0}
.dev-screen > img{width:100%;height:100%;object-fit:cover;object-position:top}
.dev-scrim{position:absolute;inset:0;background:rgba(8,16,12,.55)}

/* The address the resident types, over the dev host the capture was taken
   against. Same principle as redactPhone: correct the one wrong string rather
   than stage the whole screenshot. */
.dev-url{position:absolute;left:50%;transform:translate(-50%,-50%);
  display:flex;align-items:center;justify-content:center;
  background:#fff;border-radius:99mm;padding:.5mm 2mm;white-space:nowrap;
  font:500 calc(var(--sw)*.052)/1.1 "Figtree",sans-serif;color:#1B2A24;
  box-shadow:0 0 0 .6mm #fff}
/* Chrome's omnibox sits at the top of the window, Safari's at the bottom.
   Its vertical position is set inline, because a cropped capture moves it. */
.dev-url--top{left:38%;background:#E9E7F0;box-shadow:0 0 0 .5mm #E9E7F0}

.dev-rail{position:relative;flex:0 0 var(--rail);width:var(--rail);
  height:calc(var(--sh) + var(--bz)*2)}
.dev-rail .pin{position:absolute;left:0;right:0;transform:translateY(-50%);
  display:flex;align-items:center}
.dev-rail .pin i{flex:1;height:.4mm;background:var(--green,#0B5D3B);opacity:.6}
.dev-rail .pin b{flex:0 0 auto;width:5.4mm;height:5.4mm;border-radius:50%;
  background:var(--green,#0B5D3B);color:#fff;text-align:center;
  font:800 3mm/5.4mm "Figtree",sans-serif}

/* The horizontal rail: a strip under the device, badges placed by X. */
.dev--hrail{flex-direction:column;align-items:center}
.dev-hrail{position:relative;width:calc(var(--sw) + var(--bz)*2);height:8mm;margin-top:.6mm}
.dev-hrail .pin{position:absolute;top:0;bottom:0;transform:translateX(-50%);
  display:flex;flex-direction:column;align-items:center}
.dev-hrail .pin i{flex:1;width:.4mm;background:var(--green,#0B5D3B);opacity:.6}
.dev-hrail .pin b{flex:0 0 auto;width:5.4mm;height:5.4mm;border-radius:50%;
  background:var(--green,#0B5D3B);color:#fff;text-align:center;
  font:800 3mm/5.4mm "Figtree",sans-serif}
/* Above: the badge on top, its line dropping to the screen below it. */
.dev-hrail--above{margin-top:0;margin-bottom:.6mm}
.dev-hrail--above .pin{flex-direction:column-reverse}


/* ── the drawn Google Pay screen ───────────────────────────────────── */
.gpay{position:absolute;inset:0;background:#fff;font-family:"Figtree",sans-serif;
  display:flex;flex-direction:column;padding:calc(var(--sw)*.055);line-height:1.25;text-align:left}
.gpay__bar{display:flex;align-items:center;justify-content:space-between;margin-bottom:calc(var(--sw)*.07)}
.gpay__back{font-size:calc(var(--sw)*.1);color:#5F6368;line-height:1}
.gpay__mark{width:calc(var(--sw)*.17);height:auto;object-fit:contain}
.gpay__to{display:flex;align-items:center;gap:calc(var(--sw)*.045);margin-bottom:calc(var(--sw)*.07)}
.gpay__av{flex:0 0 auto;width:calc(var(--sw)*.13);height:calc(var(--sw)*.13);border-radius:50%;
  background:#1A73E8;color:#fff;text-align:center;
  font:700 calc(var(--sw)*.06)/calc(var(--sw)*.13) "Figtree",sans-serif}
.gpay__who b{display:block;font-size:calc(var(--sw)*.048);color:#202124}
.gpay__who i{display:block;font-style:normal;font-size:calc(var(--sw)*.04);color:#5F6368}
.gpay__amt{font-size:calc(var(--sw)*.19);font-weight:700;color:#202124;letter-spacing:-.02em;
  margin-bottom:calc(var(--sw)*.03)}
.gpay__amt span{font-size:calc(var(--sw)*.12);font-weight:600}
.gpay__note{font-size:calc(var(--sw)*.042);color:#5F6368;
  border-bottom:.3mm solid #DADCE0;padding-bottom:calc(var(--sw)*.05);
  margin-bottom:calc(var(--sw)*.06)}
.gpay__from{display:flex;align-items:center;gap:calc(var(--sw)*.04);font-size:calc(var(--sw)*.04);
  color:#5F6368}
.gpay__from b{color:#202124;font-size:calc(var(--sw)*.043)}
.gpay__bank{flex:0 0 auto;width:calc(var(--sw)*.1);height:calc(var(--sw)*.1);border-radius:50%;
  background:#E8F0FE}
.gpay__chev{margin-left:auto;color:#5F6368;font-size:calc(var(--sw)*.07)}
.gpay__cta{margin-top:auto;background:#1A73E8;color:#fff;border-radius:99mm;text-align:center;
  padding:calc(var(--sw)*.045) 0;font-weight:700;font-size:calc(var(--sw)*.055)}

/* ── the drawn Android chooser ─────────────────────────────────────── */
.sheet-and{position:absolute;left:0;right:0;bottom:0;background:#FEF7FF;
  border-radius:calc(var(--sw)*.075) calc(var(--sw)*.075) 0 0;
  padding:calc(var(--sw)*.035) calc(var(--sw)*.05) calc(var(--sw)*.045);
  font-family:"Figtree",sans-serif;line-height:1.3;text-align:left}
.sheet-and__title{font-size:calc(var(--sw)*.058);font-weight:500;color:#1D1B20;
  margin-bottom:calc(var(--sw)*.035)}
.sheet-and__apps{display:flex;flex-direction:column;border-top:.3mm solid #E7E0EC}
.sheet-and__app{display:flex;align-items:center;gap:calc(var(--sw)*.045);
  padding:calc(var(--sw)*.035) 0}
.sheet-and__app .ic{flex:0 0 auto;width:calc(var(--sw)*.115);height:calc(var(--sw)*.115);
  border-radius:calc(var(--sw)*.026);color:#fff;text-align:center;
  font:700 calc(var(--sw)*.045)/calc(var(--sw)*.115) "Figtree",sans-serif}
.sheet-and__app .lb{font-size:calc(var(--sw)*.052);color:#1D1B20;line-height:1.15}
.sheet-and__acts{display:flex;gap:calc(var(--sw)*.09);justify-content:flex-end;
  border-top:.3mm solid #E7E0EC;padding-top:calc(var(--sw)*.04)}
.sheet-and__acts span{font-size:calc(var(--sw)*.05);font-weight:600;color:#4F378A}
`;
