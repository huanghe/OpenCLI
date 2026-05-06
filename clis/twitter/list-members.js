import { cli, Strategy } from '@jackwener/opencli/registry';
import { AuthRequiredError, CommandExecutionError } from '@jackwener/opencli/errors';

const BEARER_TOKEN = 'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';
const LIST_MEMBERS_QUERY_ID = 'EkmM6fQjaFMaQbj2wGFQ9w';
const OPERATION_NAME = 'ListMembers';

const FEATURES = {
    rweb_video_screen_enabled: false,
    profile_label_improvements_pcf_label_in_post_enabled: true,
    rweb_tipjar_consumption_enabled: true,
    verified_phone_label_enabled: false,
    creator_subscriptions_tweet_preview_api_enabled: true,
    responsive_web_graphql_timeline_navigation_enabled: true,
    responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
    premium_content_api_read_enabled: false,
    communities_web_enable_tweet_community_results_fetch: true,
    c9s_tweet_anatomy_moderator_badge_enabled: true,
    responsive_web_grok_analyze_button_fetch_trends_enabled: false,
    responsive_web_grok_analyze_post_followups_enabled: true,
    responsive_web_jetfuel_frame: false,
    responsive_web_grok_share_attachment_enabled: true,
    articles_preview_enabled: true,
    responsive_web_edit_tweet_api_enabled: true,
    graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
    view_counts_everywhere_api_enabled: true,
    longform_notetweets_consumption_enabled: true,
    responsive_web_twitter_article_tweet_consumption_enabled: true,
    tweet_awards_web_tipping_enabled: false,
    responsive_web_grok_show_grok_translated_post: false,
    responsive_web_grok_analysis_button_from_backend: false,
    creator_subscriptions_quote_tweet_preview_enabled: false,
    freedom_of_speech_not_reach_fetch_enabled: true,
    standardized_nudges_misinfo: true,
    tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
    longform_notetweets_rich_text_read_enabled: true,
    longform_notetweets_inline_media_enabled: true,
    responsive_web_grok_image_annotation_enabled: true,
    responsive_web_enhance_cards_enabled: false,
};

function buildUrl(queryId, listId, count, cursor) {
    const vars = { listId: String(listId), count };
    if (cursor) vars.cursor = cursor;
    return `/i/api/graphql/${queryId}/${OPERATION_NAME}`
        + `?variables=${encodeURIComponent(JSON.stringify(vars))}`
        + `&features=${encodeURIComponent(JSON.stringify(FEATURES))}`;
}

/**
 * 从一个 user_results.result 节点抽出 member。dedupe 用 user.rest_id（数字 ID 比 screen_name
 * 稳定——X 允许改 handle，rest_id 不变）。
 * 返回 null 表示这条 entry 不是 user payload 或已经见过。
 */
export function extractMemberEntry(result, seen) {
    if (!result || result.__typename !== 'User') return null;
    const restId = result.rest_id || result.id_str || '';
    if (!restId || seen.has(restId)) return null;
    seen.add(restId);
    const core = result.core || {};
    const legacy = result.legacy || {};
    const screenName = core.screen_name || legacy.screen_name || '';
    if (!screenName) return null;
    return {
        screen_name: screenName,
        name: core.name || legacy.name || '',
        bio: legacy.description || result.profile_bio?.description || '',
        followers: legacy.followers_count || legacy.normal_followers_count || 0,
    };
}

/**
 * 解析 ListMembers GraphQL 响应。
 *
 * 响应骨架（推断自 ListLatestTweetsTimeline 等同源 GraphQL；真实结构可能略有差异，
 * 解析器对多种可能的 wrapping 路径都做了兜底，避免 X 改字段时整个挂掉）：
 *
 *   data.list.members_timeline.timeline.instructions[]
 *     .entries[]
 *       .entryId = "user-<rest_id>"  ← 普通成员
 *       .content.itemContent.user_results.result
 *
 *       .entryId = "cursor-bottom-..." | "cursor-showMore-..."  ← 翻页游标
 *       .content.value
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
            // 游标
            if (content?.entryType === 'TimelineTimelineCursor'
                || content?.__typename === 'TimelineTimelineCursor'
                || (typeof entry?.entryId === 'string'
                    && (entry.entryId.startsWith('cursor-bottom-') || entry.entryId.startsWith('cursor-showMore-')))) {
                if (content?.cursorType === 'Bottom' || content?.cursorType === 'ShowMore' || !content?.cursorType) {
                    nextCursor = content?.value || content?.itemContent?.value || nextCursor;
                }
                continue;
            }
            // 用户成员
            const direct = extractMemberEntry(content?.itemContent?.user_results?.result, seen);
            if (direct) {
                members.push(direct);
                continue;
            }
            // 嵌套 module（少见但稳一手）
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

cli({
    site: 'twitter',
    name: 'list-members',
    description: 'Fetch members of a Twitter/X list (everyone the list owner has added)',
    domain: 'x.com',
    strategy: Strategy.COOKIE,
    browser: true,
    args: [
        { name: 'listId', positional: true, type: 'string', required: true },
        { name: 'limit', type: 'int', default: 200 },
    ],
    columns: ['screen_name', 'name', 'bio', 'followers'],
    func: async (page, kwargs) => {
        const listId = String(kwargs.listId || '').trim();
        if (!listId || !/^\d+$/.test(listId)) {
            throw new CommandExecutionError(`Invalid listId: ${JSON.stringify(kwargs.listId)}. Expected a numeric ID (see \`opencli twitter lists\`).`);
        }
        const limit = kwargs.limit || 200;
        await page.goto('https://x.com');
        await page.wait(3);
        const ct0 = await page.evaluate(`() => {
            return document.cookie.split(';').map(c => c.trim()).find(c => c.startsWith('ct0='))?.split('=')[1] || null;
        }`);
        if (!ct0) throw new AuthRequiredError('x.com', 'Not logged into x.com (no ct0 cookie)');
        const queryId = await page.evaluate(`async () => {
            try {
                const ghResp = await fetch('https://raw.githubusercontent.com/fa0311/twitter-openapi/refs/heads/main/src/config/placeholder.json');
                if (ghResp.ok) {
                    const data = await ghResp.json();
                    const entry = data['${OPERATION_NAME}'];
                    if (entry && entry.queryId) return entry.queryId;
                }
            } catch {}
            try {
                const scripts = performance.getEntriesByType('resource')
                    .filter(r => r.name.includes('client-web') && r.name.endsWith('.js'))
                    .map(r => r.name);
                for (const scriptUrl of scripts.slice(0, 15)) {
                    try {
                        const text = await (await fetch(scriptUrl)).text();
                        const re = /queryId:"([A-Za-z0-9_-]+)"[^}]{0,200}operationName:"${OPERATION_NAME}"/;
                        const m = text.match(re);
                        if (m) return m[1];
                    } catch {}
                }
            } catch {}
            return null;
        }`) || LIST_MEMBERS_QUERY_ID;
        const headers = JSON.stringify({
            'Authorization': `Bearer ${decodeURIComponent(BEARER_TOKEN)}`,
            'X-Csrf-Token': ct0,
            'X-Twitter-Auth-Type': 'OAuth2Session',
            'X-Twitter-Active-User': 'yes',
        });
        const all = [];
        const seen = new Set();
        let cursor = null;
        // 上限 20 页（每页最多 100 用户，2000 上限 + 兜底防死循环）
        for (let i = 0; i < 20 && all.length < limit; i++) {
            const fetchCount = Math.min(100, limit - all.length + 20);
            const apiUrl = buildUrl(queryId, listId, fetchCount, cursor);
            const data = await page.evaluate(`async () => {
                const r = await fetch(${JSON.stringify(apiUrl)}, { headers: ${headers}, credentials: 'include' });
                return r.ok ? await r.json() : { error: r.status };
            }`);
            if (data?.error) {
                if (all.length === 0) {
                    throw new CommandExecutionError(`HTTP ${data.error}: Failed to fetch list members. queryId may have expired or list may be private.`);
                }
                break;
            }
            const { members, nextCursor } = parseListMembers(data, seen);
            all.push(...members);
            if (!nextCursor || nextCursor === cursor || members.length === 0) break;
            cursor = nextCursor;
        }
        return all.slice(0, limit);
    },
});
