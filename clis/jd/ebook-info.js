/**
 * 京东读书 — 电子书元信息（书名、作者、简介、封面、分类）
 *
 * 走 https://e.jd.com/<ebookId>.html 公开商品页，免登录、无需浏览器。
 * 用法:
 *   opencli jd ebook-info 30906459
 *   opencli jd ebook-info 'https://ebooks.jd.com/reader/?ebookId=30906459&return_url=%2Flogin'
 */
import { cli, Strategy } from '@jackwener/opencli/registry';
import { CliError, ArgumentError } from '@jackwener/opencli/errors';

const E_JD_ORIGIN = 'https://e.jd.com';
const FETCH_TIMEOUT_MS = 15_000;
const DESKTOP_UA =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36';

/**
 * 接受裸 ebookId 或包含 ebookId 的 URL（reader / item / e.jd.com / e-m.jd.com 等）。
 * 返回纯数字字符串。
 */
export function normalizeJdEbookId(input) {
    const text = String(input || '').trim();
    if (!text) return '';
    if (/^\d+$/.test(text)) return text;
    const queryMatch = text.match(/[?&]ebookId=(\d+)/i);
    if (queryMatch) return queryMatch[1];
    const eJdMatch = text.match(/e\.jd\.com\/(\d+)\.html/i);
    if (eJdMatch) return eJdMatch[1];
    const itemMatch = text.match(/item(?:\.m)?\.jd\.com\/(?:product\/)?(\d+)\.html/i);
    if (itemMatch) return itemMatch[1];
    const ebookMatch = text.match(/ebooks?\.jd\.com\/[^?#]*\/(\d+)/i);
    if (ebookMatch) return ebookMatch[1];
    const trailingDigits = text.match(/(\d{6,})/);
    if (trailingDigits) return trailingDigits[1];
    return text;
}

/** Decode a small set of HTML entities found in JD pages. */
export function decodeJdHtmlEntities(value) {
    return String(value || '')
        .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)))
        .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>');
}

/** Strip tags and collapse whitespace. */
function stripTags(value) {
    return decodeJdHtmlEntities(String(value || '').replace(/<[^>]+>/g, ''))
        .replace(/\s+/g, ' ')
        .trim();
}

function normalizeJdImageUrl(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') return '';
    let url = rawUrl.trim();
    if (!url) return '';
    if (url.startsWith('//')) url = `https:${url}`;
    if (!/^https?:\/\//.test(url) && /^[a-z]+\/t\d+\//.test(url)) {
        url = `https://img14.360buyimg.com/n1/${url}`;
    }
    if (!/^https?:\/\//.test(url)) return '';
    return url;
}

/**
 * Parse the consumer e.jd.com book detail HTML.
 * Returns a structured record (or throws for genuine "not found" pages).
 */
export function parseEJdHtml(html, ebookId) {
    const text = String(html || '');
    if (!text) {
        throw new CliError('NOT_FOUND', 'Empty response from e.jd.com', `Try opening https://e.jd.com/${ebookId}.html in a browser to confirm the book exists.`);
    }

    // Title and author live in the <title> tag in a stable, parseable shape:
    // 《<title>》(<author>)电子书下载、在线阅读、内容简介、评论 – 京东电子书频道
    const titleTagMatch = text.match(/<title>([\s\S]*?)<\/title>/i);
    const titleTagRaw = titleTagMatch ? decodeJdHtmlEntities(titleTagMatch[1]).trim() : '';

    let title = '';
    let author = '';
    const titleAuthorMatch = titleTagRaw.match(/^《(.+?)》(?:\((.*?)\))?/);
    if (titleAuthorMatch) {
        title = titleAuthorMatch[1].trim();
        author = (titleAuthorMatch[2] || '').trim();
    }

    // Fall back to the visible .sku-name block if title is missing.
    if (!title) {
        const skuName = text.match(/class="sku-name"[\s\S]*?>([\s\S]*?)<\/div>/i);
        if (skuName) title = stripTags(skuName[1]);
    }

    if (!title) {
        // The 404 page typically lacks <title> entirely or shows a "not found" template.
        throw new CliError('NOT_FOUND', `No JD ebook found for id ${ebookId}`, `Verify the ebookId by opening https://e.jd.com/${ebookId}.html`);
    }

    // Intro lives in <meta name="description" content="《...》(...)内容简介：　　XXX..."/>
    let intro = '';
    const descMatch = text.match(/<meta\s+name="description"\s+content="([^"]*)"/i);
    if (descMatch) {
        const raw = decodeJdHtmlEntities(descMatch[1]).trim();
        const idx = raw.indexOf('内容简介');
        intro = idx >= 0 ? raw.slice(idx + 4).replace(/^[：:　\s]+/, '').trim() : raw;
    }

    // Cover image: <img id="spec-img" data-origin="//img14.360buyimg.com/n1/.../cover.jpg" .../>
    let cover = '';
    const coverMatch = text.match(/id=["']spec-img["'][^>]*data-origin=["']([^"']+)["']/i);
    if (coverMatch) {
        cover = normalizeJdImageUrl(coverMatch[1]).replace(/\/n1\/s\d+x\d+_jfs\//, '/n1/jfs/');
    }

    // Breadcrumb categories: <div class="crumb..."> ... <div class="item"><a ...>类目</a></div> ...
    const category = (() => {
        const crumb = text.match(/<div\s+class=["']crumb-wrap["'][^>]*>([\s\S]*?)<!--\s*\.crumb\s*-->/i)
            || text.match(/<div\s+class=["']crumb[^"']*["'][^>]*>([\s\S]*?)<\/div>\s*<div\s+class=["']clr["']/i);
        if (!crumb) return '';
        const items = [];
        const itemRe = /<div\s+class=["']item(?:\s+[^"']+)?["'][^>]*>([\s\S]*?)<\/div>/gi;
        let m;
        while ((m = itemRe.exec(crumb[1])) !== null) {
            const t = stripTags(m[1]);
            if (!t || t === '>' || /^sep$/i.test(t)) continue;
            items.push(t);
        }
        // Drop the trailing entry (the book itself) so category is just the path.
        if (items.length && items[items.length - 1] === title) items.pop();
        return items.join(' > ');
    })();

    return {
        ebookId,
        title,
        author,
        intro,
        category,
        cover,
        url: `${E_JD_ORIGIN}/${ebookId}.html`,
    };
}

cli({
    site: 'jd',
    name: 'ebook-info',
    description: '京东读书电子书元信息（书名、作者、简介、封面、分类）— 公开页面，免登录',
    domain: 'e.jd.com',
    strategy: Strategy.PUBLIC,
    browser: false,
    args: [
        {
            name: 'ebook',
            type: 'str',
            required: true,
            positional: true,
            help: '电子书 ID（如 30906459），或包含 ebookId 的 URL',
        },
    ],
    columns: ['title', 'author', 'category', 'intro', 'cover', 'url', 'ebookId'],
    func: async (_page, args) => {
        const ebookId = normalizeJdEbookId(args.ebook);
        if (!/^\d+$/.test(ebookId)) {
            throw new ArgumentError(
                `Cannot extract ebookId from "${args.ebook}"`,
                'Pass a numeric ID (e.g. 30906459) or a URL containing ebookId=...',
            );
        }

        const url = `${E_JD_ORIGIN}/${ebookId}.html`;
        let resp;
        try {
            resp = await fetch(url, {
                headers: { 'User-Agent': DESKTOP_UA, Accept: 'text/html,*/*' },
                redirect: 'follow',
                signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
            });
        } catch (error) {
            const reason = error?.cause?.code ?? error?.message ?? 'unknown network error';
            throw new CliError('FETCH_ERROR', `Unable to reach ${url}`, `Network error (${reason}); try again later.`);
        }
        if (!resp.ok) {
            throw new CliError('FETCH_ERROR', `e.jd.com HTTP ${resp.status}`, `Verify the ebookId by opening ${url}`);
        }
        const html = await resp.text();
        const record = parseEJdHtml(html, ebookId);
        return [record];
    },
});

export const __test__ = { normalizeJdEbookId, decodeJdHtmlEntities, parseEJdHtml };
