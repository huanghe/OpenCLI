import { cli, Strategy } from '@jackwener/opencli/registry';
import { AuthRequiredError, CommandExecutionError } from '@jackwener/opencli/errors';
import { BROWSER_JSON_SNIFF_FN, throwIfLoginWall } from '@jackwener/opencli/utils';
import {
    extractAuthorAvatar,
    extractMedia,
    extractCard,
    extractQuotedTweet,
    describeTwitterApiError,
    resolveTwitterOperationMetadata,
    unwrapBrowserResult,
} from './shared.js';
import { TWITTER_BEARER_TOKEN, applyTopByEngagement } from './utils.js';
// ── Twitter GraphQL constants ──────────────────────────────────────────
const TWEET_DETAIL_QUERY_ID = 'nBS-WpgA6ZG0CyNHD517JQ';
const FEATURES = {
    responsive_web_graphql_exclude_directive_enabled: true,
    verified_phone_label_enabled: false,
    creator_subscriptions_tweet_preview_api_enabled: true,
    responsive_web_graphql_timeline_navigation_enabled: true,
    responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
    // Without this flag TweetDetail omits views.count entirely and every row reports '0'.
    view_counts_everywhere_api_enabled: true,
    longform_notetweets_consumption_enabled: true,
    longform_notetweets_rich_text_read_enabled: true,
    longform_notetweets_inline_media_enabled: true,
    freedom_of_speech_not_reach_fetch_enabled: true,
};
const FIELD_TOGGLES = { withArticleRichContentState: true, withArticlePlainText: false };
const TWEET_DETAIL_OPERATION = {
    queryId: TWEET_DETAIL_QUERY_ID,
    features: FEATURES,
    fieldToggles: FIELD_TOGGLES,
};
function buildTweetDetailUrl(tweetId, cursor, operation = TWEET_DETAIL_OPERATION) {
    const vars = {
        focalTweetId: tweetId,
        referrer: 'tweet',
        with_rux_injections: false,
        includePromotedContent: false,
        rankingMode: 'Recency',
        withCommunity: true,
        withQuickPromoteEligibilityTweetFields: true,
        withBirdwatchNotes: true,
        withVoice: true,
    };
    if (cursor)
        vars.cursor = cursor;
    const queryId = operation?.queryId || TWEET_DETAIL_QUERY_ID;
    const features = { ...FEATURES, ...(operation?.features || {}) };
    const fieldToggles = { ...FIELD_TOGGLES, ...(operation?.fieldToggles || {}) };
    return `https://x.com/i/api/graphql/${queryId}/TweetDetail`
        + `?variables=${encodeURIComponent(JSON.stringify(vars))}`
        + `&features=${encodeURIComponent(JSON.stringify(features))}`
        + `&fieldToggles=${encodeURIComponent(JSON.stringify(fieldToggles))}`;
}
function extractTweet(r, seen) {
    if (!r)
        return null;
    const tw = r.tweet || r;
    const l = tw.legacy || {};
    if (!tw.rest_id || seen.has(tw.rest_id))
        return null;
    seen.add(tw.rest_id);
    const u = tw.core?.user_results?.result;
    const noteText = tw.note_tweet?.note_tweet_results?.result?.text;
    const screenName = u?.legacy?.screen_name || u?.core?.screen_name || 'unknown';
    const bio = u?.legacy?.description || '';
    return {
        id: tw.rest_id,
        author: screenName,
        author_avatar: extractAuthorAvatar(u),
        author_verified: Boolean(u?.is_blue_verified || u?.legacy?.verified),
        bio,
        text: noteText || l.full_text || '',
        likes: l.favorite_count || 0,
        retweets: l.retweet_count || 0,
        // Same shape `twitter search` emits: a numeric string, '0' when X omits it.
        // Also feeds the log10(views) term of --top-by-engagement, which scored 0 before.
        views: tw.views?.count || '0',
        in_reply_to: l.in_reply_to_status_id_str || undefined,
        created_at: l.created_at,
        url: `https://x.com/${screenName}/status/${tw.rest_id}`,
        ...extractMedia(l),
        card: extractCard(tw),
        quoted_tweet: extractQuotedTweet(tw),
    };
}
function parseTweetDetail(data, seen) {
    const tweets = [];
    let nextCursor = null;
    const instructions = data?.data?.threaded_conversation_with_injections_v2?.instructions
        || data?.data?.tweetResult?.result?.timeline?.instructions
        || [];
    for (const inst of instructions) {
        for (const entry of inst.entries || []) {
            // Cursor entries
            const c = entry.content;
            if (c?.entryType === 'TimelineTimelineCursor' || c?.__typename === 'TimelineTimelineCursor') {
                if (c.cursorType === 'Bottom' || c.cursorType === 'ShowMore')
                    nextCursor = c.value;
                continue;
            }
            if (entry.entryId?.startsWith('cursor-bottom-') || entry.entryId?.startsWith('cursor-showMore-')) {
                nextCursor = c?.itemContent?.value || c?.value || nextCursor;
                continue;
            }
            // Direct tweet entry
            const tw = extractTweet(c?.itemContent?.tweet_results?.result, seen);
            if (tw)
                tweets.push(tw);
            // Conversation module (nested replies)
            for (const item of c?.items || []) {
                const nested = extractTweet(item.item?.itemContent?.tweet_results?.result, seen);
                if (nested)
                    tweets.push(nested);
            }
        }
    }
    return { tweets, nextCursor };
}

export const __test__ = {
    parseTweetDetail,
    buildTweetDetailUrl,
};
// ── CLI definition ────────────────────────────────────────────────────
cli({
    site: 'twitter',
    name: 'thread',
    access: 'read',
    description: 'Get a tweet thread (original + all replies)',
    domain: 'x.com',
    strategy: Strategy.COOKIE,
    browser: true,
    args: [
        { name: 'tweet-id', positional: true, type: 'string', required: true, help: 'Tweet numeric ID (e.g. 1234567890) or full status URL' },
        { name: 'limit', type: 'int', default: 50 },
        { name: 'top-by-engagement', type: 'int', default: 0, help: 'When set to N>0, re-rank the thread by weighted engagement (likes×1 + retweets×3 + replies×2 + bookmarks×5 + log10(views+1)×0.5) and return the top N. Default 0 keeps the conversation\'s structural ordering.' },
    ],
    columns: ['id', 'author', 'author_avatar', 'bio', 'text', 'likes', 'retweets', 'views', 'url', 'has_media', 'media_urls', 'media_posters', 'media_durations', 'card', 'quoted_tweet', 'author_verified'],
    func: async (page, kwargs) => {
        let tweetId = kwargs['tweet-id'];
        const urlMatch = tweetId.match(/\/status\/(\d+)/);
        if (urlMatch)
            tweetId = urlMatch[1];
        // Cookie context auto-established by framework pre-nav (Strategy.COOKIE + domain).
        // Read CSRF token directly from the cookie store via CDP — zero page.evaluate round-trip.
        const cookies = await page.getCookies({ url: 'https://x.com' });
        const ct0 = cookies.find((c) => c.name === 'ct0')?.value || null;
        if (!ct0)
            throw new AuthRequiredError('x.com', 'Not logged into x.com (no ct0 cookie)');
        // Ensure we are on the x.com origin before resolving bundles or issuing
        // authenticated same-origin GraphQL requests (a reused/reset tab can sit
        // on about:blank, where relative fetches throw `Failed to parse URL` and
        // cross-origin fetches fail CORS).
        const origin = unwrapBrowserResult(await page.evaluate('window.location.origin'));
        if (origin !== 'https://x.com') {
            await page.goto('https://x.com', { waitUntil: 'load', settleMs: 1000 });
        }
        const operation = await resolveTwitterOperationMetadata(page, 'TweetDetail', TWEET_DETAIL_OPERATION);
        // Build auth headers in TypeScript
        const headers = JSON.stringify({
            'Authorization': `Bearer ${decodeURIComponent(TWITTER_BEARER_TOKEN)}`,
            'X-Csrf-Token': ct0,
            'X-Twitter-Auth-Type': 'OAuth2Session',
            'X-Twitter-Active-User': 'yes',
        });
        // Paginate — fetch in browser, parse in TypeScript
        const allTweets = [];
        const seen = new Set();
        let cursor = null;
        for (let i = 0; i < 5; i++) {
            const apiUrl = buildTweetDetailUrl(tweetId, cursor, operation);
            // Browser-side: fetch + JSON parse with HTML-as-JSON sniffer so a
            // login wall / WAF page surfaces as a structured LoginWallError
            // instead of `SyntaxError: Unexpected token '<'`.
            const data = throwIfLoginWall(await page.evaluate(`async () => {
        ${BROWSER_JSON_SNIFF_FN}
        return await fetchJsonOrLoginWall(${JSON.stringify(apiUrl)}, { headers: ${headers}, credentials: 'include' });
      }`), { url: apiUrl });
            if (data?.error) {
                if (allTweets.length === 0)
                    throw new CommandExecutionError(describeTwitterApiError('TweetDetail', data.error));
                break;
            }
            // TypeScript-side: type-safe parsing + cursor extraction
            const { tweets, nextCursor } = parseTweetDetail(data, seen);
            allTweets.push(...tweets);
            if (!nextCursor || nextCursor === cursor)
                break;
            cursor = nextCursor;
        }
        const trimmed = allTweets.slice(0, kwargs.limit);
        return applyTopByEngagement(trimmed, kwargs['top-by-engagement']);
    },
});
