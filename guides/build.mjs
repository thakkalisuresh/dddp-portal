/**
 * Render both guides to HTML, then to PDF twice each.
 *
 * Twice, because the two renderings are the point: the screen PDF is the portal
 * exactly, and the print PDF is the same markup with the tokens swapped down to
 * hairline rules and black text. Playwright renders print media by default, so
 * the screen version is the one that needs emulateMedia.
 *
 *   node guides/capture.mjs && node guides/build.mjs
 */
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { document_, loadShots } from './lib/render.mjs';
import { pages as adminPages } from './content/admin.mjs';
import { pages as residentPages } from './content/resident.mjs';

const OUT = resolve('guides/out');
const VERSION = process.env.GUIDE_VERSION ?? '1.0';
const DATE = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

const DOCS = [
  { slug: 'admin-handbook', title: 'Running the gas billing — DD Diamond Park', build: adminPages },
  { slug: 'resident-guide', title: 'Your gas bill — DD Diamond Park', build: residentPages },
];

async function main() {
  if (!existsSync(resolve('guides/out/shots.json'))) {
    console.error('  No shots.json. Run: node guides/capture.mjs');
    process.exit(1);
  }
  loadShots();
  mkdirSync(OUT, { recursive: true });

  const br = await chromium.launch();
  const page = await br.newPage();
  const overflows = [];

  for (const doc of DOCS) {
    const html = document_({ title: doc.title, pages: doc.build({ version: VERSION, date: DATE }) });
    const htmlPath = resolve(OUT, `${doc.slug}.html`);
    writeFileSync(htmlPath, html);

    await page.goto(`file://${htmlPath}`, { waitUntil: 'networkidle' });
    await page.evaluate(() => document.fonts.ready);

    for (const [media, suffix] of [['screen', ''], ['print', '-print']]) {
      await page.emulateMedia({ media });
      const pdf = resolve(OUT, `${doc.slug}${suffix}.pdf`);
      await page.pdf({
        path: pdf,
        format: 'A4',
        printBackground: true,
        preferCSSPageSize: true,
      });
      console.log(`  ${doc.slug}${suffix}.pdf`);
    }

    // Does every page still fit on its sheet?
    //
    // Overflow is the failure mode this pipeline is most prone to and the one
    // hardest to see: a page that runs 3mm long does not look broken in the
    // HTML, it just silently becomes two PDF pages and pushes every page
    // number after it out by one. Measured rather than eyeballed.
    await page.emulateMedia({ media: 'print' });
    const over = await page.evaluate((limitMm) => {
      const limit = limitMm * 96 / 25.4;
      return [...document.querySelectorAll('section.page')].flatMap((el, i) => {
        const h = el.getBoundingClientRect().height;
        const label = el.querySelector('.runfoot span')?.textContent?.trim()
          || el.querySelector('h1')?.textContent?.trim() || `page ${i + 1}`;
        return h > limit ? [{ i: i + 1, label, mm: Math.round(h * 25.4 / 96) }] : [];
      });
    }, 251);

    const count = (html.match(/class="page/g) || []).length;
    console.log(`    ${count} pages · ${doc.slug}.html`);
    if (over.length) {
      overflows.push(...over.map((o) => `${doc.slug} p${o.i} "${o.label}" — ${o.mm}mm of 251mm`));
    }
  }

  await br.close();
  console.log(`\n  Version ${VERSION} · ${DATE}`);
  if (overflows.length) {
    console.log(`\n  ${overflows.length} page(s) overflow their sheet:`);
    overflows.forEach((o) => console.log(`    · ${o}`));
    process.exitCode = 1;
  } else {
    console.log('  every page fits its sheet');
  }
}

await main();
