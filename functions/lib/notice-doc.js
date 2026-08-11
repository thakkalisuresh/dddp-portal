/**
 * A notice, as a document the committee can read without the portal.
 *
 * The CSV bundle already carries `notices.csv` and `comments.csv`, and they are
 * useless for this: a notice is prose with a thread hanging off it, and reading
 * that out of two spreadsheets joined by id is not something anybody will do.
 * So each notice is also written into the shared Drive folder as a Google Doc,
 * sitting next to its own photographs.
 *
 * HTML rather than a real .docx or .pdf, and then converted BY DRIVE on upload.
 * A .docx is a ZIP and this project already refused to take on a zip library
 * for the backup bundle; a PDF needs one too, plus image decoding. Uploading
 * `text/html` with a target mimeType of `application/vnd.google-apps.document`
 * costs one metadata field and no dependency at all, and what the committee
 * ends up with is better than either: a native Doc they can comment on and
 * export to Word or PDF themselves.
 *
 * WHY THIS RETURNS A STRING WHEN THE REST OF THE APP REFUSES TO.
 * `public/js/markdown.js` produces DOM nodes precisely so that no HTML string
 * ever exists to hide a `<script>` inside. That reasoning is about a browser
 * rendering resident-supplied text. Here there is no browser and no DOM — the
 * output is a file posted to Drive's converter — so the same protection has to
 * come from escaping every text node on the way out instead, which is what
 * `escapeHtml` below is for and why every value goes through it. The parser
 * itself is imported rather than reimplemented: a second markdown
 * implementation would drift from the one residents actually see.
 */

import { parse } from '../../public/js/markdown.js';
import { toIST } from './tenancy.js';

/** Every one of the five, including the apostrophe: attribute contexts exist. */
export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function inlineHtml(nodes) {
  return nodes.map((node) => {
    if (node.type === 'text') return escapeHtml(node.value);
    if (node.type === 'link') {
      // The parser has already refused anything but http, https, mailto and
      // tel, so this is escaping an allowed URL rather than deciding on it.
      return `<a href="${escapeHtml(node.href)}">${inlineHtml(node.children)}</a>`;
    }
    const tag = node.type === 'strong' ? 'strong' : 'em';
    return `<${tag}>${inlineHtml(node.children)}</${tag}>`;
  }).join('');
}

/** The same subset residents see: paragraphs, bullets, bold, italic, links. */
export function markdownToHtml(source) {
  return parse(source).map((block) => {
    if (block.type === 'ul') {
      return `<ul>${block.items.map((i) => `<li>${inlineHtml(i)}</li>`).join('')}</ul>`;
    }
    // Line breaks inside a paragraph are meaningful — a committee that types an
    // address over three lines means those three lines — and the board honours
    // them with pre-wrap. A converted Doc has no CSS, so they become <br>.
    return `<p>${inlineHtml(block.children).replace(/\n/g, '<br>')}</p>`;
  }).join('\n');
}

/**
 * One notice, its thread, and what was attached to it.
 *
 * Withdrawn notices are included and SAID to be withdrawn. A notice that was
 * posted and then taken down is often the one somebody needs to see later, and
 * an archive that quietly omits it is an archive that cannot be trusted to
 * answer the question. Hidden comments are the same argument: the fact of a
 * moderated comment is part of the record, its text is not, so the row is shown
 * as withheld rather than dropped or quoted.
 *
 * Times are IST. Nobody on this committee thinks in UTC, and a document that
 * disagrees with the noticeboard about what day something was posted is a
 * document that starts an argument.
 */
export function noticeHtml({ notice, comments = [], attachments = [] }) {
  const heading = escapeHtml(notice.title);
  const kind = notice.kind === 'event' ? 'Event' : 'Notice';
  const posted = toIST(notice.posted_at);

  const meta = [`${kind} · posted ${escapeHtml(posted)}`];
  if (notice.event_date) meta.push(`Event date: ${escapeHtml(notice.event_date)}`);
  if (notice.scope && notice.scope !== 'all') meta.push(`Shown to: ${escapeHtml(notice.scope)}`);
  if (!notice.active) meta.push('WITHDRAWN — this notice is no longer on the board');

  const thread = comments.length
    ? [
      `<h2>Comments (${comments.length})</h2>`,
      ...comments.map((c) => {
        const who = escapeHtml(c.author_name ?? 'Unknown');
        const flat = c.author_flat ? ` (${escapeHtml(c.author_flat)})` : '';
        const when = escapeHtml(toIST(c.created_at));
        const body = c.hidden_at
          ? '<p><em>Comment withheld by a moderator. The text is not reproduced '
            + 'here; that it existed is.</em></p>'
          : markdownToHtml(c.body);
        return `<p><strong>${who}${flat}</strong> — ${when}</p>${body}`;
      }),
    ].join('\n')
    : '';

  const files = attachments.length
    ? [
      `<h2>Attachments (${attachments.length})</h2>`,
      '<ul>',
      ...attachments.map((a) => `<li>${escapeHtml(a.id)}-${escapeHtml(a.filename)}`
        + `${a.bytes ? ` — ${Math.round(a.bytes / 1024)} KB` : ''}`
        + `${a.deleted_at ? ' (deleted)' : ''}</li>`),
      '</ul>',
      // The images are siblings of this document rather than inside it, so the
      // Doc stays readable and the originals stay original. Said out loud
      // because a reader who does not know that will assume they are missing.
      '<p><em>The files themselves are in this same folder.</em></p>',
    ].join('\n')
    : '';

  return [
    '<!doctype html><html><head><meta charset="utf-8">',
    `<title>${heading}</title></head><body>`,
    `<h1>${heading}</h1>`,
    `<p>${meta.map(escapeHtml).join('<br>')}</p>`,
    markdownToHtml(notice.body),
    thread,
    files,
    '</body></html>',
  ].filter(Boolean).join('\n');
}

/**
 * What the document would say, reduced to one string.
 *
 * The doc is rewritten only when this changes. Notices have no `updated_at` —
 * the PATCH that edits a title or body writes neither — so there is no
 * timestamp to compare, and rewriting every notice every night would churn a
 * hundred Drive files to record that nothing happened. Hashing what actually
 * goes into the document answers exactly the right question, including the case
 * a timestamp would miss entirely: a comment hidden by a moderator changes the
 * document without changing anything's created_at.
 */
export async function noticeSignature({ notice, comments = [], attachments = [] }) {
  const material = JSON.stringify([
    notice.title, notice.body, notice.active, notice.scope, notice.kind,
    notice.event_date, notice.posted_at,
    comments.map((c) => [c.id, c.body, c.hidden_at]),
    attachments.map((a) => [a.id, a.filename, a.deleted_at]),
  ]);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(material));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
