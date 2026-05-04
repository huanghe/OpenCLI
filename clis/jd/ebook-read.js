/**
 * 京东读书 — 抓取试读 / 已渲染章节正文
 *
 * 走 cread.jd.com 的试读阅读器（startRead.action），在浏览器里等内容渲染后
 * 直接从 #JD_content / #JD_article DOM 抠段落文本。
 *
 * 已知限制：
 *   - 只能拿到当前已渲染的页（试读：通常是开头若干页；付费章节翻不到）
 *   - 不会自动翻页、不会跨章节
 *   - DRM/反爬变更或登录失效都会让命令失败 — 用 OPENCLI_DIAGNOSTIC=1 看错误
 *
 * 用法:
 *   opencli jd ebook-read 30906459
 *   opencli jd ebook-read 30906459 --max-paragraphs 100
 */
import { cli, Strategy } from '@jackwener/opencli/registry';
import { CliError, AuthRequiredError } from '@jackwener/opencli/errors';
import { normalizeJdEbookId } from './ebook-info.js';

const READER_ENTRY = 'https://cread.jd.com/read/startRead.action';
const RENDER_TIMEOUT_S = 25;

/** Run inside the page: walk #JD_content for visible paragraphs/headings. */
function extractRenderedReaderJs(maxParagraphs) {
    return `
        (() => {
            const article = document.querySelector('#JD_article') || document.body;
            const content = article.querySelector('#JD_content') || article;
            const title = (document.querySelector('.catalog_title p, .title')?.textContent || document.title || '').trim();
            const items = [];
            const seen = new Set();
            const isHeading = (el) => /^h[1-6]$/i.test(el.tagName) || el.classList.contains('title') || el.classList.contains('chapter-title');
            const candidates = content.querySelectorAll('h1, h2, h3, h4, h5, h6, p, .p, .text, .chapter-title');
            for (const el of candidates) {
                const text = (el.textContent || '').replace(/\\s+/g, ' ').trim();
                if (!text || text.length < 2) continue;
                if (seen.has(text)) continue;
                seen.add(text);
                items.push({
                    chapter: title,
                    kind: isHeading(el) ? 'heading' : 'paragraph',
                    content: text,
                });
                if (items.length >= ${Math.max(1, Number(maxParagraphs) || 500)}) break;
            }
            return items;
        })()
    `;
}

cli({
    site: 'jd',
    name: 'ebook-read',
    description: '京东读书电子书正文 — 通过浏览器渲染后从 DOM 抽段落（受 DRM/登录限制，仅试读可见部分）',
    domain: 'cread.jd.com',
    strategy: Strategy.COOKIE,
    browser: true,
    navigateBefore: false,
    args: [
        {
            name: 'ebook',
            type: 'str',
            required: true,
            positional: true,
            help: '电子书 ID（如 30906459），或包含 ebookId 的 URL',
        },
        {
            name: 'max-paragraphs',
            type: 'int',
            default: 500,
            required: false,
            help: '最多返回多少条段落 / 标题（默认 500）',
        },
    ],
    columns: ['chapter', 'kind', 'content'],
    func: async (page, args) => {
        const ebookId = normalizeJdEbookId(args.ebook);
        if (!/^\d+$/.test(ebookId)) {
            throw new CliError('INVALID_ARGUMENT', `Cannot extract ebookId from "${args.ebook}"`);
        }
        const maxParagraphs = Math.max(1, Math.min(Number(args['max-paragraphs']) || 500, 5000));

        const entryUrl = `${READER_ENTRY}?bookId=${encodeURIComponent(ebookId)}&readType=1`;
        await page.goto(entryUrl, { waitUntil: 'load', settleMs: 3000 });

        // Login bounce detection.
        const currentUrl = await page.evaluate('window.location.href');
        if (typeof currentUrl === 'string' && /passport\.jd\.com|return_url=/i.test(currentUrl)) {
            throw new AuthRequiredError(
                'JD ebook reader requires login',
                `Open ${entryUrl} in Chrome and log in to JD first, then re-run.`,
            );
        }

        // Give catalog.js + chapter.js time to render the first chapter into #JD_content.
        try {
            await page.wait({ selector: '#JD_content p, #JD_content h1, #JD_content h2, #JD_content h3, #JD_content .p', timeout: RENDER_TIMEOUT_S });
        } catch {
            // Continue — even if specific selectors don't match, evaluate may still find content.
        }
        // Small extra settle for paginated EPUB reader.
        await page.wait({ time: 2 });

        const items = await page.evaluate(extractRenderedReaderJs(maxParagraphs));
        if (!Array.isArray(items) || !items.length) {
            throw new CliError(
                'EMPTY_RESULT',
                'No reader content was rendered for this JD ebook',
                `Open ${entryUrl} in Chrome and confirm the trial-read page actually shows text. The reader DOM may have changed, or this book has no public preview.`,
            );
        }
        return items;
    },
});
