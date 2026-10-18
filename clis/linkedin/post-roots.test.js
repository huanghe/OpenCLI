import { afterEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { buildPostsScript, collectPosts } from './posts-core.js';
import { locatePostCards } from './post-roots.js';
const doms = [];
afterEach(() => { for (const dom of doms.splice(0)) dom.window.close(); });
const post = (id, body = `Distinct post body ${id}`) => `<a href="/in/author-${id}/">Author ${id}</a>\n<a href="/feed/update/urn:li:activity:${id}/?tracking=1">2h</a>\n<p dir="ltr">${body}</p>\n<div>12 reactions</div>\n<div>3 comments</div>`;
function fixture(html) {
  const dom = new JSDOM(`<main>${html}</main>`, { url: 'https://www.linkedin.com/in/test/recent-activity/all/', runScripts: 'outside-only' });
  doms.push(dom); return dom;
}
describe('LinkedIn permalink card roots', () => {
  it('extracts separate list items without legacy card classes', () => {
    const dom = fixture(`<ul><li>${post('111')}</li><li>${post('222')}</li></ul>`);
    const payload = dom.window.eval(buildPostsScript());
    expect(payload.rows).toHaveLength(2);
    expect(payload.rows.map(row => row.author)).toEqual(['Author 111', 'Author 222']);
    expect(payload.rows.map(row => row.body)).toEqual(['Distinct post body 111', 'Distinct post body 222']);
    expect(payload.rows[0]).toMatchObject({ comments: 3, reactions: 12 });
    expect(payload.unmatchedPermalinks).toBe(0);
  });
  it('finds a generic single-post container and deduplicates alternate tracking links', () => {
    const dom = fixture(`<section><div>${post('111')}<a href="/posts/author_activity-111-abcd/?tracking=2">Post link</a></div><div>${post('222')}</div></section>`);
    const found = locatePostCards(dom.window.document);
    expect(found.cards).toHaveLength(2); expect(found.unmatchedPermalinks).toBe(0);
  });
  it('does not merge separate permalinks in a shared container', () => {
    const dom = fixture(`<div>${post('111')}${post('222')}</div>`);
    const found = locatePostCards(dom.window.document);
    expect(found.cards).toHaveLength(0); expect(found.unmatchedPermalinks).toBe(2);
  });
  it('does not treat a bare permalink or navigation link as a post card', () => {
    const dom = fixture('<nav><a href="/posts/navigation">Navigation</a></nav><div><a href="/posts/unstructured">Post</a></div>');
    const found = locatePostCards(dom.window.document);
    expect(found.cards).toHaveLength(0); expect(found.unmatchedPermalinks).toBe(1);
  });
  it('ignores hidden clones and external lookalike links', () => {
    const dom = fixture(`<ul><li hidden>${post('111')}</li><li>${post('222')}</li></ul><a href="https://evil.invalid/posts/x">External</a>`);
    const found = locatePostCards(dom.window.document);
    expect(found.cards).toHaveLength(1); expect(found.unmatchedPermalinks).toBe(0);
    expect(found.cards[0].textContent).toContain('Author 222');
  });
  it('keeps complete legacy cards once, including short posts', () => {
    const dom = fixture('<article><div class="feed-shared-update-v2"><p class="update-components-text">A short post</p><a href="/posts/short">link</a></div><div>9 comments</div></article>');
    const payload = dom.window.eval(buildPostsScript());
    expect(payload.rows).toHaveLength(1); expect(payload.rows[0]).toMatchObject({ body: 'A short post', comments: 9 });
  });
});
describe('LinkedIn posts collection outcomes', () => {
  function pageFor(payload) {
    return { goto: vi.fn(), wait: vi.fn(), autoScroll: vi.fn(), evaluate: vi.fn().mockResolvedValueOnce(false).mockResolvedValue(payload) };
  }
  it('reports layout drift when permalinks cannot be associated with cards', async () => {
    await expect(collectPosts(pageFor({ rows: [], unmatchedPermalinks: 2 }), { limit: 2 })).rejects.toMatchObject({ code: 'COMMAND_EXEC', message: expect.stringContaining('layout') });
  });
  it('preserves genuine empty result behavior', async () => {
    await expect(collectPosts(pageFor({ rows: [], unmatchedPermalinks: 0 }), { limit: 2 })).rejects.toMatchObject({ code: 'EMPTY_RESULT' });
  });
  it('waits for later hydrated cards after an initially unmatched permalink', async () => {
    const page = pageFor({ rows: [{ body: 'Loaded body', url: 'https://www.linkedin.com/posts/a' }], unmatchedPermalinks: 0 });
    page.evaluate.mockReset().mockResolvedValueOnce(false).mockResolvedValueOnce({ rows: [], unmatchedPermalinks: 1 }).mockResolvedValue({ rows: [{ body: 'Loaded body', url: 'https://www.linkedin.com/posts/a' }], unmatchedPermalinks: 0 });
    expect(await collectPosts(page, { limit: 1 })).toHaveLength(1); expect(page.autoScroll).toHaveBeenCalledTimes(1);
  });
});
