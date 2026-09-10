/**
 * Build the capture manifest for the simulator screenshots.
 *
 *   node guides/measure-sim.mjs        # writes guides/out/sim-shots.json
 *
 * Every mark is MEASURED off the image by lib/measure.mjs rather than typed in.
 * The first draft of this guide had hand-written percentages, and by the time
 * anyone looked closely they pointed at the wrong controls — badge 3 sat on
 * "Uncheck on a shared phone" instead of the Log in button. A number nobody can
 * re-derive is a number that rots.
 *
 * What is hand-written here is only WHICH band is which control, which is a
 * statement about the screen's structure and does not drift when a control
 * moves a few pixels.
 */
import { writeFileSync } from 'node:fs';
import { bands, pct } from './lib/measure.mjs';

const SPEC = {
  'ios-login': {
    device: 'iphone',
    marks: [
      { n: 1, from: 'rules', pair: [0, 1], what: 'mobile number field (focused, green outline)' },
      { n: 2, from: 'greyRules', pair: [0, 1], what: 'password field' },
      { n: 3, from: 'filled', band: 0, what: 'Log in button' },
    ],
  },
  'and-01-pay': {
    device: 'android',
    marks: [
      { n: 1, from: 'filled', band: 0, what: 'Pay ₹312 button' },
      { n: 2, from: 'greyRules', pair: [0, 1], what: 'Google Pay row' },
      { n: 3, from: 'greyRules', pair: [4, 5], what: 'Paytm row' },
    ],
  },
  'ios-03-breakdown': {
    device: 'iphone',
    marks: [
      { n: 1, from: 'greyRules', pair: [0, 1], what: 'Google Pay row' },
      { n: 2, from: 'greyRules', pair: [4, 5], what: 'Paytm row' },
    ],
  },
  // The bill screen at scroll top also carries the whole pay block, so it is
  // the figure for the iPhone flow as well. Rows are grey-outlined cards.
  'ios-01-bill-pay': {
    device: 'iphone',
    marks: [
      { n: 1, from: 'greyRules', pair: [0, 1], what: 'Google Pay row' },
      { n: 2, from: 'greyRules', pair: [4, 5], what: 'Paytm row' },
    ],
  },
  'ios-02-scroll1': { device: 'iphone', marks: [] },
  'ios-04-proof': { device: 'iphone', marks: [] },
  'ios-05-notices': { device: 'iphone', marks: [] },
  'ios-06-me': { device: 'iphone', marks: [] },
  'and-02-stuck': { device: 'android', marks: [] },
  'and-03-fallback': { device: 'android', marks: [] },
};

const out = {};
for (const [name, spec] of Object.entries(SPEC)) {
  const file = `guides/out/sim/${name}.png`;
  const b = await bands(file);
  const marks = [];
  for (const m of spec.marks) {
    const list = b[m.from] ?? [];
    let band;
    if (m.band != null) band = list[m.band];
    else if (m.pair) {
      const a = list[m.pair[0]], z = list[m.pair[1]];
      band = a && z ? [a[0], z[1]] : null;
    }
    // Loud, not silent. A mark that cannot be measured is a badge that would
    // otherwise be drawn confidently in the wrong place.
    if (!band) {
      console.error(`  ! ${name} mark ${m.n} (${m.what}): no ${m.from} band — NOT emitted`);
      continue;
    }
    marks.push({ ...pct(b, band, m.n), what: m.what });
  }
  out[name] = { file: `sim/${name}.png`, w: b.w, h: b.h, device: spec.device, marks, pill: b.pill };
  console.log(`  ${name.padEnd(20)} ${b.w}x${b.h}  ${marks.length}/${spec.marks.length} marks  pill ${b.pill ? b.pill.top.toFixed(1) + '%' : '—'}`);
}

writeFileSync('guides/out/sim-shots.json', JSON.stringify(out, null, 2));
console.log(`\n  wrote guides/out/sim-shots.json (${Object.keys(out).length} captures)`);
