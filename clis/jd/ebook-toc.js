/**
 * 京东读书 — 电子书目录
 *
 * 走 cread.jd.com 的试读入口，让浏览器执行混淆过的 catalog.js，
 * 然后通过 XHR 拦截抓取 /read/lC.action 响应；DOM 渲染好的目录列表为兜底。
 *
 * 用法:
 *   opencli jd ebook-toc 30906459
 *   opencli jd ebook-toc 30906459 --limit 10
 */
import { cli, Strategy } from '@jackwener/opencli/registry';
import { CliError, AuthRequiredError } from '@jackwener/opencli/errors';
import { normalizeJdEbookId } from './ebook-info.js';

const READER_ENTRY = 'https://cread.jd.com/read/startRead.action';
const CATALOG_API_HINT = 'lC.action';
const READY_TIMEOUT_S = 20;

/** Walk the catalog response and flatten chapters into [{index, title, anchor, level}]. */
export function flattenJdCatalog(rawContent) {
    if (!rawContent) return [];
    let content = rawContent;
    if (typeof content === 'string') {
        try { content = JSON.parse(content); }
        catch { /* keep string; nothing to flatten */ return []; }
    }
    const root = Array.isArray(content)
        ? content
        : Array.isArray(content?.catalog) ? content.catalog
        : Array.isArray(content?.chapters) ? content.chapters
        : Array.isArray(content?.list) ? content.list
        : Array.isArray(content?.items) ? content.items
        : Array.isArray(content?.children) ? content.children
        : [];
    if (!root.length) return [];

    const out = [];
    let counter = 0;
    const walk = (nodes, level) => {
        for (const node of nodes) {
            if (!node || typeof node !== 'object') continue;
            const title = String(
                node.title ?? node.name ?? node.label ?? node.chapterName ?? node.text ?? ''
            ).trim();
            const anchor = String(
                node.id ?? node.chapterId ?? node.href ?? node.anchor ?? node.url ?? ''
            ).trim();
            if (title) {
                counter += 1;
                out.push({ index: counter, title, anchor, level });
            }
            const kids = Array.isArray(node.children) ? node.children
                : Array.isArray(node.subItems) ? node.subItems
                : Array.isArray(node.list) ? node.list
                : null;
            if (kids?.length) walk(kids, level + 1);
        }
    };
    walk(root, 0);
    return out;
}

/** Pull the catalog list from the rendered DOM (the JD_catalogList container). */
function readCatalogFromDomJs() {
    return `
        (() => {
            const container = document.querySelector('.JD_catalogList');
            if (!container) return [];
            const items = [];
            const walk = (nodes, level) => {
                for (const node of nodes) {
                    const title = (node.querySelector(':scope > a, :scope > span, :scope > p')?.textContent
                        || node.textContent || '').trim().split('\\n')[0].trim();
                    if (title) {
                        items.push({
                            title,
                            anchor: node.getAttribute('data-id') || node.getAttribute('data-href') || node.querySelector('a')?.getAttribute('href') || '',
                            level,
                        });
                    }
                    const kids = node.querySelectorAll(':scope > ul > li, :scope > ol > li, :scope > div > li');
                    if (kids?.length) walk(kids, level + 1);
                }
            };
            const top = container.querySelectorAll(':scope > li, :scope > ul > li, :scope > div > li');
            walk(top, 0);
            return items;
        })()
    `;
}

cli({
    site: 'jd',
    name: 'ebook-toc',
    description: '京东读书电子书目录（章节列表）— 通过浏览器拦截 catalog API；试读 / 免费书一般免登录可见',
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
            name: 'limit',
            type: 'int',
            default: 200,
            required: false,
            help: '最多返回多少章节（默认 200）',
        },
    ],
    columns: ['index', 'title', 'level', 'anchor'],
    func: async (page, args) => {
        const ebookId = normalizeJdEbookId(args.ebook);
        if (!/^\d+$/.test(ebookId)) {
            throw new CliError('INVALID_ARGUMENT', `Cannot extract ebookId from "${args.ebook}"`);
        }
        const limit = Math.max(1, Math.min(Number(args.limit) || 200, 5000));

        // Install XHR interceptor BEFORE navigation so we catch the catalog request.
        // The actual URL is built by JD's obfuscated UrlBuilder; matching by substring
        // (`lC.action`) is enough to grab whatever shape it ships.
        const entryUrl = `${READER_ENTRY}?bookId=${encodeURIComponent(ebookId)}&readType=1`;
        await page.goto(entryUrl, { waitUntil: 'load', settleMs: 2000 });

        // If JD bounced us to login, surface a clean auth error.
        const currentUrl = await page.evaluate('window.location.href');
        if (typeof currentUrl === 'string' && /passport\.jd\.com|return_url=/i.test(currentUrl)) {
            throw new AuthRequiredError(
                'JD ebook reader requires login',
                `Open ${entryUrl} in Chrome and log in to JD first, then re-run.`,
            );
        }

        // Now install interceptor and trigger a catalog re-request via reload.
        // (catalog is fetched at page bootstrap; reloading after interceptor is the
        // simplest way to make sure we capture the response.)
        await page.installInterceptor(CATALOG_API_HINT);
        await page.goto(entryUrl, { waitUntil: 'load', settleMs: 3000 });

        // Wait for the catalog DOM to fill in OR for the interceptor to capture.
        try {
            await page.wait({ selector: '.JD_catalogList li, .JD_catalogList a', timeout: READY_TIMEOUT_S });
        } catch {
            // Continue — interceptor capture might still have data even if DOM template
            // shape differs.
        }

        // 1) Try intercepted catalog API response first.
        const intercepted = await page.getInterceptedRequests();
        let chapters = [];
        for (const req of intercepted) {
            const body = req?.responseBody ?? req?.response ?? req?.body ?? req?.data;
            if (!body) continue;
            let parsed = body;
            if (typeof parsed === 'string') {
                try { parsed = JSON.parse(parsed); } catch { /* leave as string */ }
            }
            const content = parsed?.content ?? parsed?.data ?? parsed;
            const flat = flattenJdCatalog(content);
            if (flat.length) {
                chapters = flat;
                break;
            }
        }

        // 2) Fallback to scraping the rendered DOM if interceptor missed it.
        if (!chapters.length) {
            const fromDom = await page.evaluate(readCatalogFromDomJs());
            if (Array.isArray(fromDom) && fromDom.length) {
                chapters = fromDom.map((item, i) => ({
                    index: i + 1,
                    title: String(item.title || '').trim(),
                    anchor: String(item.anchor || '').trim(),
                    level: Number(item.level) || 0,
                }));
            }
        }

        if (!chapters.length) {
            throw new CliError(
                'EMPTY_RESULT',
                'Could not extract a catalog for this JD ebook',
                `Open ${entryUrl} in Chrome to confirm the trial-read page renders chapters; the JD reader DOM/API may have changed.`,
            );
        }

        return chapters.slice(0, limit);
    },
});

export const __test__ = { flattenJdCatalog };
