/**
 * Put a realistic review queue on the local Proofs screen.
 *
 * The screen is empty on a fresh seed, so it cannot be photographed at all
 * without this. Proofs go in through the REAL upload endpoint rather than as
 * INSERT statements: the endpoint is what hashes the image, writes it to R2,
 * runs the vision parse and decides whether the claim matches the bill. A row
 * inserted straight into the table would render as a proof with no image and
 * no parsed amount — which is not what a treasurer will ever see.
 *
 * The mock screenshots are the fictional "UniPay" props: no real payer, no
 * real UTR, DEMO stamped in the footer. Amounts are generated to equal the
 * demo bills they are attached to, because assessProof compares to the paisa
 * and a queue where every row reads "short by ₹4" teaches the wrong lesson.
 *
 * LOCAL ONLY. There is deliberately no --remote path.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { query } from './lib/d1.mjs';

const BASE = process.env.GUIDE_BASE ?? 'http://localhost:8788';
const PROPS = resolve('guides/out/props');
// No fallback, for the reason set out in capture.mjs: the demo residents exist
// on production too, so a literal here is a live credential in a tracked file.
const RESIDENT_PW = process.env.GUIDE_RESIDENT_PW ?? process.env.DEMO_RESIDENT_PW;
if (!RESIDENT_PW) {
  throw new Error('Set GUIDE_RESIDENT_PW before preparing proofs. See guides/README.md.');
}

/** How many of the unpaid July bills to attach a proof to. */
const WANT = 5;

function pickBills() {
  return query(
    `SELECT b.id AS bill_id, b.flat, b.total, o.mobile, o.name
       FROM bills b JOIN owners o ON o.id = b.owner_id
      WHERE b.period = '2026-07' AND b.status = 'unpaid' AND o.role = 'owner'
        AND NOT EXISTS (SELECT 1 FROM payment_proofs p WHERE p.bill_id = b.id)
      ORDER BY b.total DESC LIMIT ${WANT}`,
  );
}

function generateProps(amounts) {
  mkdirSync(PROPS, { recursive: true });
  execFileSync('node', [
    'scripts/gen-mock-proofs.mjs',
    '--amounts', amounts.join(','),
    '--out', PROPS,
  ], { stdio: 'inherit' });
}

async function login(mobile) {
  const r = await fetch(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mobile, password: RESIDENT_PW, remember: true }),
  });
  if (!r.ok) throw new Error(`login ${mobile}: ${r.status} ${await r.text()}`);
  const cookie = r.headers.getSetCookie?.().map((c) => c.split(';')[0]).join('; ')
    ?? (r.headers.get('set-cookie') || '').split(';')[0];
  if (!cookie) throw new Error(`login ${mobile}: no session cookie returned`);
  return cookie;
}

async function upload(cookie, billId, file) {
  const form = new FormData();
  form.append('image', new Blob([readFileSync(file)], { type: 'image/png' }), 'payment.png');
  const r = await fetch(`${BASE}/api/bills/${billId}/proof`, {
    method: 'POST', headers: { cookie }, body: form,
  });
  return { status: r.status, body: await r.text() };
}

const bills = pickBills();
if (!bills.length) {
  console.log('  Every candidate bill already has a proof. Nothing to do.');
  process.exit(0);
}

console.log(`\n  Generating ${bills.length} props to match real bill totals\n`);
generateProps(bills.map((b) => b.total));

console.log('\n  Uploading through POST /api/bills/:id/proof\n');
let ok = 0;
for (const [i, b] of bills.entries()) {
  const file = join(PROPS, `mock-${String(i + 1).padStart(2, '0')}-${b.total}.png`);
  try {
    const cookie = await login(b.mobile);
    const res = await upload(cookie, b.bill_id, file);
    const tag = res.status === 200 || res.status === 201 ? 'ok' : `HTTP ${res.status}`;
    console.log(`  ${b.flat.padEnd(4)} ₹${String(b.total).padEnd(5)} ${tag}`);
    if (tag === 'ok') ok += 1;
    else console.log(`         ${res.body.slice(0, 160)}`);
  } catch (err) {
    console.log(`  ${b.flat.padEnd(4)} ₹${String(b.total).padEnd(5)} FAILED  ${err.message}`);
  }
}

const pending = query("SELECT COUNT(*) AS n FROM payment_proofs WHERE status = 'pending'")[0]?.n;
console.log(`\n  ${ok}/${bills.length} uploaded · ${pending} now pending review\n`);
