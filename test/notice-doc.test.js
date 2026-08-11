import { describe, it, expect } from 'vitest';
import {
  escapeHtml, markdownToHtml, noticeHtml, noticeSignature,
} from '../functions/lib/notice-doc.js';

const notice = {
  id: 12, title: 'Water tank cleaning', body: 'The tank will be cleaned.',
  kind: 'notice', posted_at: '2026-08-09T05:30:00Z', active: 1, scope: 'all',
};

describe('escaping, because this is the one place the app emits an HTML string', () => {
  it('escapes all five, including the apostrophe', () => {
    expect(escapeHtml(`<&">'`)).toBe('&lt;&amp;&quot;&gt;&#39;');
  });

  it('gives back empty for null rather than the word null', () => {
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
  });

  it('cannot be talked into emitting a script tag from a notice body', () => {
    const html = noticeHtml({
      notice: { ...notice, title: '<script>alert(1)</script>', body: '<img onerror=x>' },
    });
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('the same markdown subset residents see', () => {
  it('renders bold, italic and bullets', () => {
    expect(markdownToHtml('**Tuesday**')).toBe('<p><strong>Tuesday</strong></p>');
    expect(markdownToHtml('*maybe*')).toBe('<p><em>maybe</em></p>');
    expect(markdownToHtml('- one\n- two'))
      .toBe('<ul><li>one</li><li>two</li></ul>');
  });

  it('keeps a link, and escapes the href', () => {
    expect(markdownToHtml('[pay](https://x.test/a?b=1&c=2)'))
      .toContain('href="https://x.test/a?b=1&amp;c=2"');
  });

  it('refuses a javascript: link exactly as the board does', () => {
    // The parser hands back the literal text; this only has to not undo that.
    const html = markdownToHtml('[tap](javascript:alert(1))');
    expect(html).not.toContain('href="javascript:');
    expect(html).toContain('[tap]');
  });

  it('keeps line breaks inside a paragraph, which an address depends on', () => {
    expect(markdownToHtml('Line one\nLine two')).toBe('<p>Line one<br>Line two</p>');
  });

  it('leaves arithmetic alone rather than guessing at emphasis', () => {
    expect(markdownToHtml('5*3*2 = 30')).toBe('<p>5*3*2 = 30</p>');
  });
});

describe('the document a committee member opens', () => {
  it('leads with the title and says when it was posted, in IST', () => {
    const html = noticeHtml({ notice });
    expect(html).toContain('<h1>Water tank cleaning</h1>');
    expect(html).toContain('11:00');       // 05:30 UTC is 11:00 IST
    expect(html).not.toContain('05:30');
  });

  // An archive that quietly omits what was taken down cannot be trusted to
  // answer the question it exists for.
  it('includes a withdrawn notice and says that it was withdrawn', () => {
    expect(noticeHtml({ notice: { ...notice, active: 0 } })).toContain('WITHDRAWN');
  });

  it('records that a comment was moderated without reproducing it', () => {
    const html = noticeHtml({
      notice,
      comments: [{
        id: 1, body: 'the offending text', created_at: '2026-08-09T06:00:00Z',
        author_name: 'Hari', author_flat: '13E', hidden_at: '2026-08-09T07:00:00Z',
      }],
    });
    expect(html).toContain('withheld');
    expect(html).not.toContain('the offending text');
    expect(html).toContain('Hari');
  });

  it('lists attachments as siblings, and says where they are', () => {
    const html = noticeHtml({
      notice,
      attachments: [{ id: 41, filename: 'IMG_2081.jpg', bytes: 204800 }],
    });
    expect(html).toContain('41-IMG_2081.jpg');
    expect(html).toContain('200 KB');
    expect(html).toContain('same folder');
  });

  it('says nothing about comments or attachments when there are none', () => {
    const html = noticeHtml({ notice });
    expect(html).not.toContain('Comments');
    expect(html).not.toContain('Attachments');
  });
});

describe('the signature that decides whether to rewrite', () => {
  it('is stable when nothing changed', async () => {
    expect(await noticeSignature({ notice }))
      .toBe(await noticeSignature({ notice }));
  });

  it('changes when the body is edited', async () => {
    expect(await noticeSignature({ notice }))
      .not.toBe(await noticeSignature({ notice: { ...notice, body: 'Moved to Friday.' } }));
  });

  it('changes when a comment arrives', async () => {
    expect(await noticeSignature({ notice }))
      .not.toBe(await noticeSignature({ notice, comments: [{ id: 1, body: 'ok' }] }));
  });

  // The case a timestamp comparison would miss entirely: nothing was created,
  // but the document should no longer say what it says.
  it('changes when a comment is hidden', async () => {
    const comments = [{ id: 1, body: 'x', hidden_at: null }];
    expect(await noticeSignature({ notice, comments }))
      .not.toBe(await noticeSignature({
        notice, comments: [{ ...comments[0], hidden_at: '2026-08-10T00:00:00Z' }],
      }));
  });

  it('changes when a notice is withdrawn', async () => {
    expect(await noticeSignature({ notice }))
      .not.toBe(await noticeSignature({ notice: { ...notice, active: 0 } }));
  });
});
