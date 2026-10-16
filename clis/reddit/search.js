import { AuthRequiredError, CommandExecutionError } from '@jackwener/opencli/errors';
import { BROWSER_JSON_SNIFF_FN, throwIfLoginWall } from '@jackwener/opencli/utils';
import { cli, Strategy } from '@jackwener/opencli/registry';

function buildRedditSearchPath(kwargs) {
    const query = String(kwargs.query ?? '');
    const subreddit = String(kwargs.subreddit ?? '').trim();
    const sort = String(kwargs.sort ?? 'relevance');
    const time = String(kwargs.time ?? 'all');
    const limit = Number(kwargs.limit ?? 15);
    const basePath = subreddit
        ? `/r/${encodeURIComponent(subreddit)}/search.json`
        : '/search.json';
    const params = new URLSearchParams({
        q: query,
        sort,
        t: time,
        limit: String(limit),
        restrict_sr: subreddit ? 'on' : 'off',
        raw_json: '1',
    });
    return `${basePath}?${params.toString()}`;
}

function unwrapEvaluateResult(payload) {
    if (payload && typeof payload === 'object' && !Array.isArray(payload)
        && 'session' in payload && 'data' in payload) {
        return payload.data;
    }
    return payload;
}

function decodeHtml(value) {
    if (typeof value !== 'string' || !value) return '';
    return value
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#x27;/gi, "'")
        .replace(/&#39;/g, "'");
}

function mapRedditSearchRow(child, index) {
    const item = child?.data;
    if (!item || typeof item !== 'object') {
        throw new CommandExecutionError(`Reddit search row ${index + 1} was missing data.`);
    }
    const preview = item.preview?.images?.[0]?.source?.url || '';
    const gallery = [];
    const galleryItems = item.gallery_data?.items;
    const media = item.media_metadata;
    if (Array.isArray(galleryItems) && media) {
        for (const entry of galleryItems) {
            const source = media[entry?.media_id]?.s;
            if (source?.u) gallery.push(decodeHtml(source.u));
        }
    }
    return {
        id: item.id || '',
        title: item.title || '',
        subreddit: item.subreddit_name_prefixed || '',
        author: item.author || '',
        score: item.score || 0,
        comments: item.num_comments || 0,
        url: item.permalink ? `https://www.reddit.com${item.permalink}` : '',
        created_utc: item.created_utc || 0,
        selftext: item.selftext || '',
        post_hint: item.post_hint || '',
        url_overridden_by_dest: decodeHtml(item.url_overridden_by_dest || ''),
        preview_image_url: decodeHtml(preview),
        gallery_urls: gallery,
    };
}

function mapSearchResult(result) {
    if (result?.kind === 'auth') {
        throw new AuthRequiredError('reddit.com', result.detail);
    }
    if (result?.kind === 'http') {
        const status = result.status;
        if (typeof status !== 'number') {
            throw new CommandExecutionError('Reddit search HTTP result was missing a numeric status.');
        }
        if (status === 401 || status === 403) {
            throw new AuthRequiredError('reddit.com', `Reddit search returned HTTP ${status}`);
        }
        const hint = status === 429
            ? 'Reddit rate limited this request. Stop retrying and wait for the channel cooldown.'
            : undefined;
        throw new CommandExecutionError(
            `Reddit search returned HTTP ${status}.`,
            hint,
        );
    }
    if (result?.kind === 'malformed') {
        throw new CommandExecutionError(`Reddit search returned a malformed listing: ${result.detail}`);
    }
    if (result?.kind === 'exception') {
        throw new CommandExecutionError(`Reddit search failed: ${result.detail}`);
    }
    if (result?.kind !== 'ok' || !Array.isArray(result.rows)) {
        throw new CommandExecutionError(`Unexpected Reddit search result: ${JSON.stringify(result)}`);
    }
    return result.rows.map(mapRedditSearchRow);
}

cli({
    site: 'reddit',
    name: 'search',
    access: 'read',
    description: 'Search Reddit Posts',
    domain: 'www.reddit.com',
    navigateBefore: false,
    strategy: Strategy.COOKIE,
    browser: true,
    args: [
        { name: 'query', type: 'string', required: true, positional: true, help: 'Reddit search query' },
        { name: 'subreddit', type: 'string', default: '', help: 'Search within a specific subreddit' },
        { name: 'sort', type: 'string', default: 'relevance', help: 'Sort order: relevance, hot, top, new, comments' },
        { name: 'time', type: 'string', default: 'all', help: 'Time filter: hour, day, week, month, year, all' },
        { name: 'limit', type: 'int', default: 15 },
    ],
    columns: ['id', 'title', 'subreddit', 'author', 'score', 'comments', 'url', 'created_utc', 'selftext', 'post_hint', 'url_overridden_by_dest', 'preview_image_url', 'gallery_urls'],
    func: async (page, kwargs) => {
        if (!page) throw new CommandExecutionError('Browser session required for Reddit search');
        await page.goto('https://www.reddit.com');
        const requestPath = buildRedditSearchPath(kwargs);
        const rawResult = await page.evaluate(`(async () => {
      ${BROWSER_JSON_SNIFF_FN}
      try {
        const payload = await fetchJsonOrLoginWall(${JSON.stringify(requestPath)}, { credentials: 'include' });
        if (payload?.__loginWall) return { kind: 'login-wall', sentinel: payload };
        if (payload?.error) return { kind: 'http', status: payload.error };
        if (!Array.isArray(payload?.data?.children)) {
          return { kind: 'malformed', detail: 'payload is missing data.children' };
        }
        return { kind: 'ok', rows: payload.data.children };
      } catch (error) {
        return { kind: 'exception', detail: String(error?.message || error) };
      }
    })()`);
        const result = unwrapEvaluateResult(rawResult);
        if (result?.kind === 'login-wall') {
            throwIfLoginWall(result.sentinel, { url: requestPath });
        }
        return mapSearchResult(result).slice(0, Number(kwargs.limit ?? 15));
    },
});

export const __test__ = {
    buildRedditSearchPath,
    mapSearchResult,
    unwrapEvaluateResult,
};
