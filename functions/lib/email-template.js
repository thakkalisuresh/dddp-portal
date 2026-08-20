/**
 * The association's email look, in the subset of HTML mail clients render.
 *
 * Every rule here is a workaround for something a mail client does:
 *
 *   - INLINE CSS ONLY. Gmail strips <style> blocks in some contexts and every
 *     external stylesheet in all of them. A `style=` attribute on the element
 *     is the only styling that reliably survives the trip.
 *   - TABLES, not divs. Outlook renders through Word's engine, which has no
 *     float and no flexbox, and silently collapses a div-based layout into a
 *     single column of full-bleed text.
 *   - NO WEB FONTS. The site's Lexend does not load here; the stack degrades
 *     to whatever the device has, so nothing may depend on the metrics.
 *   - 600px. What an Outlook reading pane shows without a horizontal
 *     scrollbar, and narrow enough to read on a phone without zooming.
 *
 * The colours are lifted from public/css/tokens.css rather than reinvented, so
 * an email and the page it links to are recognisably the same association.
 * They are hard-coded because a CSS variable is not a thing an email client
 * resolves.
 *
 * renderEmail() returns BOTH bodies from one description of the message, which
 * is what the block list is for: a caller writing the two by hand would
 * eventually correct an amount in one and not the other, and whichever body
 * the resident's client showed them would decide whether they saw the truth.
 */

const ASSOCIATION = "DD Diamond Park Residents' Welfare Association";
/**
 * The portal's public address.
 *
 * Exported because a job with no request to read an origin off — the 3am
 * announcement sweep — still has to put a working link in an email, and a
 * fourth hand-written copy of this string is a fourth place for it to go stale
 * the day the domain changes.
 */
export const SITE = 'https://diamondpark.pages.dev';

/* Straight from tokens.css. */
const INK = '#0F172A';
const MUTED = '#52525B';
const PAPER = '#FAFAF8';
const SURFACE = '#FFFFFF';
const BORDER = '#DDDCD6';
const ACCENT = '#0A6B4A';
const ACCENT_WASH = '#F1F8F5';
const ACCENT_LINE = '#BEDCD0';

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif";

/* ── the blocks a message is made of ─────────────────────────────────────── */

/**
 * A paragraph of prose.
 */
export const para = (text) => ({ type: 'para', text });

/**
 * A section heading, for a message long enough to have sections.
 */
export const heading = (text) => ({ type: 'heading', text });

/**
 * The one number the message is about — an amount due, a reading, a code.
 * One per email; a second one competing with it makes neither stand out.
 */
export const figure = (value, caption = '') => ({ type: 'figure', value, caption });

/**
 * Label/value rows: `[['Flat', 'A-204'], ['Units', '31']]`.
 */
export const details = (entries) => ({ type: 'details', entries });

/**
 * The single thing you want the reader to do.
 */
export const action = (label, url) => ({ type: 'action', label, url });

/**
 * Small print — the "if you did not ask for this" line.
 */
export const aside = (text) => ({ type: 'aside', text });

/* ── rendering ───────────────────────────────────────────────────────────── */

/**
 * One message description in, `{ subject, html, text }` out.
 *
 * `title` doubles as the subject and the headline, so the line in the inbox
 * list and the line at the top of the message cannot drift apart.
 * `preview` is the grey line the inbox shows after the subject; skip it and
 * clients scrape the first words of the body, which is usually "Hello,".
 */
export function renderEmail({ title, preview = '', blocks = [], footer = '' }) {
  return {
    subject: subjectFor(title),
    html: renderHtml({ title, preview, blocks, footer }),
    text: renderText({ title, blocks, footer }),
  };
}

/**
 * The opening of a notice, short enough that the portal is still the place to
 * read it.
 *
 * Deliberately not the whole body. A notice email that reproduces the notice
 * gives nobody a reason to open the board, and the board is where the
 * attachments, the edits and the read-receipts live.
 *
 * The marks are stripped rather than rendered because notice bodies are the
 * markdown subset in public/js/markdown.js, and `**Sunday**` reaching an inbox
 * as four asterisks is how a committee stops trusting the mail. Only the
 * documented subset is handled — bold, italic, links, bullets. If the notice
 * email is ever built for real, importing that module's pure `parse` is the
 * better answer than this; it is not worth the layering argument for an
 * excerpt.
 *
 * Returns `truncated` so the caller knows whether it is promising a longer
 * notice than it has shown.
 */
export function excerpt(body, limit = 280) {
  const flat = String(body)
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')   // [text](url) -> text
    .replace(/\*\*([^*]+)\*\*/g, '$1')          // **bold**
    .replace(/\*([^*]+)\*/g, '$1')              // *italic*
    .replace(/^\s*-\s+/gm, '')                  // - bullet
    .replace(/\s+/g, ' ')
    .trim();

  if (flat.length <= limit) return { text: flat, truncated: false };

  // Cut at a word boundary. A notice sliced mid-word reads as a bug rather
  // than as an excerpt, and residents report it as one.
  const cut = flat.slice(0, limit + 1);
  const space = cut.lastIndexOf(' ');
  const kept = cut.slice(0, space > 0 ? space : limit).replace(/[\s,;:.\u2014-]+$/, '');
  return { text: `${kept}\u2026`, truncated: true };
}

/**
 * The subject carries the association's name; the headline does not.
 *
 * In an inbox list "Payment received for July 2026" is from nobody in
 * particular, so the subject is prefixed. Inside the message that prefix would
 * sit directly under a banner already reading DD DIAMOND PARK, so the headline
 * uses the bare title. Deriving one from the other is what stops a caller
 * writing a subject that no longer describes the mail underneath it.
 *
 * Idempotent, because every subject already written starts with the prefix.
 */
export function subjectFor(title) {
  return /^Diamond Park\b/.test(title) ? title : `Diamond Park — ${title}`;
}

/**
 * `&` and `<` in a resident's name must not become markup.
 */
export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderHtml({ title, preview, blocks, footer }) {
  const body = blocks.map(htmlBlock).join('\n');

  // The preheader is shown by the inbox and hidden in the open message. The
  // trailing whitespace stops Gmail from padding the preview with the first
  // words of the real body.
  const preheader = preview
    ? `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">`
      + `${escapeHtml(preview)}${'&#8199;&#65279;'.repeat(40)}</div>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
</head>
<body style="margin:0;padding:0;background:${PAPER};font-family:${FONT};">
${preheader}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${PAPER};">
<tr><td align="center" style="padding:24px 12px;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="width:100%;max-width:600px;background:${SURFACE};border:1px solid ${BORDER};border-radius:4px;">
<tr><td style="padding:20px 32px;background:${ACCENT_WASH};border-bottom:1px solid ${ACCENT_LINE};">
<div style="font-family:${FONT};font-size:12px;letter-spacing:0.13em;text-transform:uppercase;color:${ACCENT};font-weight:600;">DD Diamond Park</div>
<div style="font-family:${FONT};font-size:20px;line-height:1.25;color:${INK};font-weight:600;padding-top:6px;">${escapeHtml(title)}</div>
</td></tr>
<tr><td style="padding:24px 32px;font-family:${FONT};font-size:16px;line-height:1.5;color:${INK};">
${body}
</td></tr>
<tr><td style="padding:16px 32px 20px;border-top:1px solid ${BORDER};font-family:${FONT};font-size:13px;line-height:1.5;color:${MUTED};">
${footer ? `<div style="padding-bottom:8px;">${escapeHtml(footer)}</div>` : ''}
<div>${escapeHtml(ASSOCIATION)}<br><a href="${SITE}" style="color:${ACCENT};text-decoration:underline;">${SITE.replace(/^https:\/\//, '')}</a></div>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

function htmlBlock(block) {
  switch (block.type) {
    case 'para':
      return `<p style="margin:0 0 16px;">${escapeHtml(block.text)}</p>`;

    case 'heading':
      return `<p style="margin:24px 0 8px;font-size:12px;letter-spacing:0.13em;`
        + `text-transform:uppercase;color:${MUTED};font-weight:600;">${escapeHtml(block.text)}</p>`;

    case 'figure':
      return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px;">`
        + `<tr><td align="center" style="padding:20px 16px;background:${ACCENT_WASH};border:1px solid ${ACCENT_LINE};border-radius:4px;">`
        + `<div style="font-family:${FONT};font-size:32px;line-height:1.15;font-weight:600;color:${INK};">${escapeHtml(block.value)}</div>`
        + (block.caption
          ? `<div style="font-family:${FONT};font-size:13px;color:${MUTED};padding-top:6px;">${escapeHtml(block.caption)}</div>`
          : '')
        + `</td></tr></table>`;

    case 'details': {
      // Borders on the cells, not the table: `border-collapse` is one of the
      // properties Outlook is least reliable about.
      const rows = block.entries.map(([label, value], i) => {
        const top = i === 0 ? '' : `border-top:1px solid ${BORDER};`;
        return `<tr>`
          + `<td style="${top}padding:8px 0;font-family:${FONT};font-size:14px;color:${MUTED};">${escapeHtml(label)}</td>`
          + `<td align="right" style="${top}padding:8px 0;font-family:${FONT};font-size:14px;color:${INK};font-weight:600;">${escapeHtml(value)}</td>`
          + `</tr>`;
      }).join('');
      return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px;">${rows}</table>`;
    }

    case 'action':
      // A table rather than a padded <a>: Outlook ignores padding on inline
      // elements, which turns the button into an ordinary blue link.
      return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 20px;">`
        + `<tr><td style="background:${ACCENT};border-radius:6px;">`
        + `<a href="${escapeHtml(block.url)}" style="display:inline-block;padding:12px 24px;font-family:${FONT};`
        + `font-size:16px;font-weight:600;color:#FFFFFF;text-decoration:none;">${escapeHtml(block.label)}</a>`
        + `</td></tr></table>`;

    case 'aside':
      return `<p style="margin:0 0 12px;font-size:13px;line-height:1.5;color:${MUTED};">${escapeHtml(block.text)}</p>`;

    default:
      return '';
  }
}

/**
 * The same message as plain text.
 *
 * Not a degraded copy of the HTML. It is what some residents actually read,
 * so a link has to arrive as a URL they can copy and a table as labels that
 * still line up.
 */
function renderText({ title, blocks, footer }) {
  const out = [title, '='.repeat(Math.min(title.length, 72)), ''];

  for (const block of blocks) {
    switch (block.type) {
      case 'para':
        out.push(wrap(block.text), '');
        break;
      case 'heading':
        out.push(block.text.toUpperCase(), '');
        break;
      case 'figure':
        out.push(`    ${block.value}`, ...(block.caption ? [`    ${block.caption}`] : []), '');
        break;
      case 'details': {
        const width = Math.max(...block.entries.map(([label]) => label.length));
        for (const [label, value] of block.entries) {
          out.push(`  ${label.padEnd(width)}   ${value}`);
        }
        out.push('');
        break;
      }
      case 'action':
        out.push(`${block.label}:`, `  ${block.url}`, '');
        break;
      case 'aside':
        out.push(wrap(block.text), '');
        break;
      default:
        break;
    }
  }

  if (footer) out.push(wrap(footer), '');
  out.push('--', ASSOCIATION, SITE);
  return out.join('\n');
}

/** Hard-wrap at 72, the width a plain-text mail is read at. */
function wrap(text, width = 72) {
  const lines = [];
  for (const paragraph of String(text).split('\n')) {
    let line = '';
    for (const word of paragraph.split(' ')) {
      if (line && (line + ' ' + word).length > width) { lines.push(line); line = word; }
      else line = line ? `${line} ${word}` : word;
    }
    lines.push(line);
  }
  return lines.join('\n');
}
