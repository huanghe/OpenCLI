/**
 * Twitter/X list-members — every account the list owner has added to a list.
 *
 * Uses the ListMembers GraphQL operation (cookie + queryId, same pattern as
 * lists.js / list-tweets.js / following.js) with cursor pagination. Unlike
 * list-tweets it surfaces members who have not posted recently.
 */
import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError, AuthRequiredError, CommandExecutionError, EmptyResultError } from '@jackwener/opencli/errors';
import { describeTwitterApiError, extractAuthorAvatar, resolveTwitterQueryId, unwrapBrowserResult } from './shared.js';
import { TWITTER_BEARER_TOKEN } from './utils.js';

const LIST_MEMBERS_QUERY_ID = 'EkmM6fQjaFMaQbj2wGFQ9w';
const OPERATION_NAME = 'ListMembers';
const MAX_PAGINATION_PAGES = 100;
const MAX_LIMIT = 5000;

const FEATURES = {
    rweb_video_screen_enabled: false,
    profile_label_improvements_pcf_label_in_post_enabled: true,
    responsive_web_profile_redirect_enabled: false,
    rweb_tipjar_consumption_enabled: false,
    verified_phone_label_enabled: false,
    creator_subscriptions_tweet_preview_api_enabled: true,
    responsive_web_graphql_timeline_navigation_enabled: true,
    responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
    premium_content_api_read_enabled: false,
    communities_web_enable_tweet_community_results_fetch: true,
    c9s_tweet_anatomy_moderator_badge_enabled: true,
    responsive_web_grok_analyze_button_fetch_trends_enabled: false,
    responsive_web_grok_analyze_post_followups_enabled: true,
    responsive_web_jetfuel_frame: true,
    responsive_web_grok_share_attachment_enabled: true,
    responsive_web_grok_annotations_enabled: true,
    articles_preview_enabled: true,
    responsive_web_edit_tweet_api_enabled: true,
    graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
    view_counts_everywhere_api_enabled: true,
    longform_notetweets_consumption_enabled: true,
    responsive_web_twitter_article_tweet_consumption_enabled: true,
    tweet_awards_web_tipping_enabled: false,
    content_disclosure_indicator_enabled: true,
    content_disclosure_ai_generated_indicator_enabled: true,
    responsive_web_grok_show_grok_translated_post: false,
    responsive_web_grok_analysis_button_from_backend: true,
    post_ctas_fetch_enabled: false,
    freedom_of_speech_not_reach_fetch_enabled: true,
    standardized_nudges_misinfo: true,
    tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
    longform_notetweets_rich_text_read_enabled: true,
    longform_notetweets_inline_media_enabled: false,
    responsive_web_grok_image_annotation_enabled: true,
    responsive_web_grok_imagine_annotation_enabled: true,
    responsive_web_grok_community_note_auto_translation_is_enabled: false,
    responsive_web_enhance_cards_enabled: false,
};

export function buildListMembersUrl(queryId, listId, count, cursor) {
    const vars = { listId: String(listId), count };
    if (cursor) vars.cursor = cursor;
    return `/i/api/graphql/${queryId}/${OPERATION_NAME}`
        + `?variables=${encodeURIComponent(JSON.stringify(vars))}`
        + `&features=${encodeURIComponent(JSON.stringify(FEATURES))}`;
}

/**
 * Extract one member from a `user_results.result` node. Dedupes on rest_id
 * (numeric id is stable; handles can change). Returns null for non-user
 * payloads and repeats.
 */
export function extractMemberEntry(result, seen) {
    if (!result || result.__typename !== 'User') return null;
    const restId = String(result.rest_id || result.id_str || '');
    if (!restId || seen.has(restId)) return null;
    seen.add(restId);
    const core = result.core || {};
    const legacy = result.legacy || {};
    const screenName = core.screen_name || legacy.screen_name || '';
    if (!screenName) return null;
    return {
        user_id: restId,
        screen_name: screenName,
        name: core.name || legacy.name || '',
        bio: result.profile_bio?.description || legacy.description || '',
        followers: result.relationship_counts?.followers ?? legacy.followers_count ?? legacy.normal_followers_count ?? 0,
        verified: Boolean(result.is_blue_verified || result.verification?.verified || legacy.verified),
        avatar: extractAuthorAvatar(result) || null,
        url: `https://x.com/${screenName}`,
    };
}

/**
 * Parse a ListMembers response.
 *
 *   data.list.members_timeline.timeline.instructions[].entries[]
 *     entryId "user-<rest_id>"  → content.itemContent.user_results.result
 *     entryId "cursor-bottom-…" → content.value
 *
 * Several wrapper paths are tolerated so a field rename does not zero the
 * whole command.
 */
export function parseListMembers(data, seen) {
    const members = [];
    let nextCursor = null;
    const instructions = data?.data?.list?.members_timeline?.timeline?.instructions
        || data?.data?.list?.timeline?.timeline?.instructions
        || data?.data?.list_members_timeline?.timeline?.instructions
        || [];
    for (const inst of instructions) {
        for (const entry of inst.entries || []) {
            const content = entry?.content;
            if (content?.entryType === 'TimelineTimelineCursor'
                || content?.__typename === 'TimelineTimelineCursor'
                || (typeof entry?.entryId === 'string'
                    && (entry.entryId.startsWith('cursor-bottom-') || entry.entryId.startsWith('cursor-showMore-')))) {
                if (content?.cursorType === 'Bottom' || content?.cursorType === 'ShowMore' || !content?.cursorType) {
                    nextCursor = content?.value || content?.itemContent?.value || nextCursor;
                }
                continue;
            }
            const direct = extractMemberEntry(content?.itemContent?.user_results?.result, seen);
            if (direct) {
                members.push(direct);
                continue;
            }
            for (const item of content?.items || []) {
                const nested = extractMemberEntry(
                    item?.item?.itemContent?.user_results?.result
                    || item?.itemContent?.user_results?.result,
                    seen,
                );
                if (nested) members.push(nested);
            }
        }
    }
    return { members, nextCursor };
}

export function parseListId(raw) {
    const text = String(raw ?? '').trim();
    const fromUrl = text.match(/\/i\/lists\/(\d+)/);
    const listId = fromUrl ? fromUrl[1] : text;
    if (!/^\d+$/.test(listId)) {
        throw new ArgumentError(
            `Invalid list id: ${JSON.stringify(raw)}. Expected a numeric ID or https://x.com/i/lists/<id>.`,
            'Find list ids with `opencli twitter lists`.',
        );
    }
    return listId;
}

cli({
    site: 'twitter',
    name: 'list-members',
    access: 'read',
    description: 'Fetch members of a Twitter/X list (everyone the list owner has added)',
    domain: 'x.com',
    strategy: Strategy.COOKIE,
    browser: true,
    args: [
        { name: 'list-id', positional: true, type: 'string', required: true, help: 'Numeric list id or https://x.com/i/lists/<id>' },
        { name: 'limit', type: 'int', default: 200, help: `Maximum members to return (1-${MAX_LIMIT}, default 200)` },
    ],
    columns: ['user_id', 'screen_name', 'name', 'bio', 'followers', 'verified', 'avatar', 'url'],
    func: async (page, kwargs) => {
        const listId = parseListId(kwargs['list-id']);
        const limit = kwargs.limit === undefined || kwargs.limit === null ? 200 : Number(kwargs.limit);
        if (!Number.isInteger(limit) || limit <= 0 || limit > MAX_LIMIT) {
            throw new ArgumentError(`twitter list-members --limit must be an integer between 1 and ${MAX_LIMIT}`, 'Example: opencli twitter list-members 1234567890 --limit 500');
        }

        const cookies = await page.getCookies({ url: 'https://x.com' });
        const ct0 = cookies.find((c) => c.name === 'ct0')?.value || null;
        if (!ct0) throw new AuthRequiredError('x.com', 'Not logged into x.com (no ct0 cookie)');

        await page.goto(`https://x.com/i/lists/${listId}/members`, { waitUntil: 'load', settleMs: 1000 });
        const queryId = await resolveTwitterQueryId(page, OPERATION_NAME, LIST_MEMBERS_QUERY_ID);
        const headers = {
            'Authorization': `Bearer ${decodeURIComponent(TWITTER_BEARER_TOKEN)}`,
            'X-Csrf-Token': ct0,
            'X-Twitter-Auth-Type': 'OAuth2Session',
            'X-Twitter-Active-User': 'yes',
        };

        const all = [];
        const seen = new Set();
        let cursor = null;
        for (let i = 0; i < MAX_PAGINATION_PAGES && all.length < limit; i++) {
            // ListMembers serves at most 100 users per page; over-fetch a little
            // so the final slice does not need an extra round-trip.
            const remaining = limit - all.length + 20;
            const fetchCount = Math.min(100, remaining);
            const apiUrl = buildListMembersUrl(queryId, listId, fetchCount, cursor);
            const data = unwrapBrowserResult(await page.evaluate(async (url, headers) => {
                const r = await fetch(url, { headers, credentials: 'include' });
                return r.ok ? await r.json() : { error: r.status };
            }, apiUrl, headers));
            if (data?.error) {
                if (data.error === 401 || data.error === 403) {
                    throw new AuthRequiredError('x.com', `Twitter list-members request failed (HTTP ${data.error})`);
                }
                if (all.length === 0) {
                    throw new CommandExecutionError(describeTwitterApiError(OPERATION_NAME, data.error, 'The list may be private or the queryId expired.'));
                }
                break;
            }
            const { members, nextCursor } = parseListMembers(data, seen);
            all.push(...members);
            if (!nextCursor || nextCursor === cursor || members.length === 0) break;
            cursor = nextCursor;
        }
        if (all.length === 0) {
            throw new EmptyResultError('twitter list-members', `List ${listId} has no visible members (empty, private, or deleted).`);
        }
        return all.slice(0, limit);
    },
});

export const __test__ = { buildListMembersUrl, extractMemberEntry, parseListMembers, parseListId, FEATURES };
