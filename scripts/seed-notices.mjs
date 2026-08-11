#!/usr/bin/env node
/**
 * Notice board seed — a board with some history on it, for testing.
 *
 * seed-dev.mjs posts two notices and no comments, which is enough to prove the
 * page renders and nothing else. This one fills the board the way it looks
 * after a few months of a committee using it: both kinds, both scopes,
 * comments on and off, a withdrawn notice, a hidden comment, and an unread
 * tail so the badge has something to count.
 *
 * LOCAL ONLY, and it clears the board first. Notices and comments are the two
 * tables where a reseed is destructive in a way residents would notice, so
 * there is deliberately no --remote path here.
 */

import { execFileSync } from 'node:child_process';

const q = (v) => (v == null ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);

/** Days ago, as the ISO string postNotice writes (lib/notices.js §unread). */
const ago = (days, hour = 10) => {
  const d = new Date(Date.now() - days * 86_400_000);
  d.setUTCHours(hour, (days * 17) % 60, 0, 0);
  return d.toISOString();
};

/** Dated forward for events that have not happened yet. */
const ahead = (days) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

// owner_id → who they are, for readability below. Matches seed-dev + demo rows.
const SEKHARAN = 3, PRIYA_T = 4, RAJAN = 5, JOY = 6, LANDLORD = 7, MEERA = 8,
      RAVI = 9, ANU_T = 10, LATHA = 13, MANOJ = 16, VINOD = 19, JAYAN = 22,
      RAMESH = 24, NISHA_T = 25, DEEPA = 26, HARI = 29, SHAJI = 54;
const MUKESH = 2; // admin, hides the one comment that needed hiding

const NOTICES = [
  {
    title: 'August gas bills are out',
    body: 'August bills are on your dashboard now. Due by the 10th. Pay by UPI and upload the screenshot — the portal reads the UTR off it, so there is nothing to type in.',
    kind: 'notice', scope: 'all', allowComments: 0, postedAt: ago(14),
  },
  {
    title: 'Water tank cleaning — both tanks',
    body: 'Overhead and sump tanks will be cleaned this Sunday. Supply will be off from 9 AM to roughly 2 PM. Please store what you need on Saturday night.',
    kind: 'event', eventDate: ahead(4), scope: 'all', allowComments: 1, postedAt: ago(11),
    comments: [
      { by: MEERA,    at: ago(11, 12), body: 'Will the borewell pump also be off, or just the tank supply?' },
      { by: JOY,      at: ago(11, 14), body: 'Just the tanks. Borewell runs as usual, so the taps in the car wash area will have water.' },
      { by: ANU_T,    at: ago(10, 9),  body: 'Thanks for the notice. Could this go out on WhatsApp too? Not everyone opens the portal daily.' },
      { by: RAVI,     at: ago(10, 18), body: '2 PM is optimistic based on last year. Please plan for 4.' },
    ],
  },
  {
    title: 'Lift B — annual maintenance shutdown',
    body: 'Lift B will be out of service for its annual inspection on Thursday, 8 AM to 1 PM. Lift A runs through. Residents on the upper floors with mobility needs, please tell the security desk in advance and we will schedule around you.',
    kind: 'notice', scope: 'all', allowComments: 1, postedAt: ago(9),
    comments: [
      { by: LATHA,    at: ago(9, 11),  body: 'My mother is on 13. Told the desk, they have noted it. Thank you for asking.' },
      { by: MANOJ,    at: ago(8, 20),  body: 'Can the AMC people be asked to do this on a weekday morning rather than a Thursday? School run is chaos.' },
      { by: NISHA_T,  at: ago(8, 21),  body: 'Thursday is a weekday.' },
      { by: MANOJ,    at: ago(7, 8),   body: 'Meant to say a Monday. Point stands about the timing.' },
    ],
  },
  {
    title: 'AGM 2026 — agenda and audited accounts',
    body: 'The AGM is on the 30th at 6 PM in the community hall. Agenda and the audited accounts for FY 2025–26 are with the secretary; ask for a copy or collect one from the office. Proxy forms must reach us 48 hours in advance.\n\nItems: adoption of accounts, sinking fund revision, lift AMC renewal, committee elections.',
    kind: 'notice', scope: 'owners', allowComments: 1, postedAt: ago(7),
    comments: [
      { by: LANDLORD, at: ago(7, 15),  body: 'I am in Sharjah and cannot attend. Is a scanned proxy form acceptable, or does it have to be the original?' },
      { by: JOY,      at: ago(6, 10),  body: 'Scanned is fine if it reaches us 48 hours before and the original follows by post. Several owners abroad do this every year.' },
      { by: RAJAN,    at: ago(6, 19),  body: 'Please circulate the accounts as a PDF on the portal rather than only in the office. Half of us work in Bangalore.' },
      { by: SEKHARAN, at: ago(5, 9),   body: 'Seconding that. Also asking that the lift AMC quotes be attached, not just the recommendation.' },
    ],
  },
  {
    title: 'Onam celebration — volunteers wanted',
    body: 'Onam sadhya and games in the community hall. We need volunteers for pookalam, the kitchen, and the children’s games. Put your name down with any committee member. Contributions are voluntary this year — the cultural fund covers most of it.',
    kind: 'event', eventDate: ahead(11), scope: 'all', allowComments: 1, postedAt: ago(5),
    comments: [
      { by: DEEPA,    at: ago(5, 13),  body: 'Count me in for the pookalam. I can bring flowers from the market if someone can drive.' },
      { by: JAYAN,    at: ago(5, 16),  body: 'I will drive. Ping me the day before.' },
      { by: PRIYA_T,  at: ago(4, 11),  body: 'Are tenants included in the sadhya headcount? Asking because last year the list only had owner names on it.' },
      { by: JOY,      at: ago(4, 12),  body: 'Everyone living here is included. Last year’s list was a clerical mistake and we are sorry for it.' },
      { by: HARI,     at: ago(3, 20),  body: 'Kitchen team, happy to help. Vegetarian only again?' },
    ],
  },
  {
    title: 'Visitor parking — the rules, once more',
    body: 'Visitor slots are the six marked V1–V6 near the gate. They are not overflow for a second family car. Security has been asked to log the flat number for every visitor vehicle parked over four hours, and repeat cases come to the committee.',
    kind: 'notice', scope: 'all', allowComments: 1, postedAt: ago(3),
    comments: [
      { by: RAMESH,   at: ago(3, 12),  body: 'Long overdue. V3 and V4 have had the same two cars in them since March.' },
      { by: VINOD,    at: ago(3, 13),  body: 'One of those is mine and it is there because my allotted slot has a leaking pipe over it that has been reported four times.' },
      { by: SHAJI,    at: ago(2, 9),   body: 'Then fix the pipe. That is a maintenance failure, not a parking one.',
        hiddenBy: MUKESH, hiddenAt: ago(2, 15) },
      { by: JOY,      at: ago(2, 10),  body: 'The pipe is on the plumber’s list for this week. Vinod, use V6 until it is done — I have told security.' },
    ],
  },
  {
    title: 'Sinking fund — proposed revision to ₹4/sq ft',
    body: 'The committee proposes raising the sinking fund contribution from ₹3 to ₹4 per sq ft per month from October, to fund terrace waterproofing and the lift modernisation due in 2028. This needs an owners’ vote at the AGM. Working sheet is with the treasurer.',
    kind: 'notice', scope: 'owners', allowComments: 0, postedAt: ago(1),
  },
  {
    title: 'Terrace waterproofing — quotes invited',
    body: 'Superseded by the AGM agenda item. Kept for the record.',
    kind: 'notice', scope: 'all', allowComments: 0, active: 0, postedAt: ago(20),
  },
];

const sql = ['DELETE FROM comments;', 'DELETE FROM notices;'];

for (const n of NOTICES) {
  sql.push(
    `INSERT INTO notices (title, body, kind, event_date, allow_comments, scope, active, posted_at)
     VALUES (${q(n.title)}, ${q(n.body)}, ${q(n.kind)}, ${q(n.eventDate ?? null)},
             ${n.allowComments}, ${q(n.scope)}, ${n.active ?? 1}, ${q(n.postedAt)});`
  );
  for (const c of n.comments ?? []) {
    sql.push(
      `INSERT INTO comments (notice_id, owner_id, body, created_at, hidden_by, hidden_at)
       VALUES ((SELECT id FROM notices WHERE title = ${q(n.title)}), ${c.by}, ${q(c.body)}, ${q(c.at)},
               ${c.hiddenBy ?? 'NULL'}, ${q(c.hiddenAt ?? null)});`
    );
  }
}

// Everyone's badge starts from four days back, so the last three notices read
// as unread. A board where nothing is new tests the badge's zero case only.
sql.push(`UPDATE owners SET notices_seen_at = ${q(ago(4, 0))};`);

execFileSync('npx', ['wrangler', 'd1', 'execute', 'dddp', '--local', '--command', sql.join('\n')], {
  stdio: 'inherit',
  cwd: new URL('..', import.meta.url).pathname,
});

const comments = NOTICES.reduce((n, x) => n + (x.comments?.length ?? 0), 0);
console.log(`\nSeeded ${NOTICES.length} notices (1 withdrawn, 2 owners-only, 2 events) and ${comments} comments.`);
console.log('One comment is hidden by an admin.');
console.log('Unread badge: 2 for an owner, 1 for a tenant — the newest notice is owners-only.');
