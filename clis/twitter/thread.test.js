import { describe, expect, it, vi } from 'vitest';
import { getRegistry } from '@jackwener/opencli/registry';
import { __test__ } from './thread.js';

describe('twitter thread parser', () => {
    it('extracts author bio from tweet user entity', () => {
        const command = getRegistry().get('twitter/thread');
        expect(command?.columns).toEqual(['id', 'author', 'author_avatar', 'bio', 'text', 'likes', 'retweets', 'views', 'url', 'has_media', 'media_urls', 'media_posters', 'media_durations', 'card', 'quoted_tweet', 'author_verified']);
        const result = __test__.parseTweetDetail({
            data: {
                threaded_conversation_with_injections_v2: {
                    instructions: [
                        {
                            entries: [
                                {
                                    content: {
                                        itemContent: {
                                            tweet_results: {
                                                result: {
                                                    rest_id: '1',
                                                    legacy: {
                                                        full_text: 'thread tweet',
                                                        favorite_count: 3,
                                                        retweet_count: 2,
                                                    },
                                                    core: {
                                                        user_results: {
                                                            result: {
                                                                legacy: {
                                                                    screen_name: 'alice',
                                                                    description: 'Thread author bio',
                                                                },
                                                            },
                                                        },
                                                    },
                                                },
                                            },
                                        },
                                    },
                                },
                            ],
                        },
                    ],
                },
            },
        }, new Set());
        expect(result.tweets).toHaveLength(1);
        expect(result.tweets[0]).toMatchObject({
            id: '1',
            author: 'alice',
            author_verified: false,
            bio: 'Thread author bio',
            text: 'thread tweet',
            likes: 3,
            retweets: 2,
            url: 'https://x.com/alice/status/1',
        });
    });

    it('builds an absolute x.com TweetDetail URL using resolved queryId and preserves required features', () => {
        const url = __test__.buildTweetDetailUrl('123456', null, {
            queryId: 'RotatedQueryId_123',
            features: { extra_flag_enabled: true },
            fieldToggles: { customToggle: true },
        });
        expect(url.startsWith('https://x.com/i/api/graphql/RotatedQueryId_123/TweetDetail?')).toBe(true);
        const parsed = new URL(url);
        const features = JSON.parse(parsed.searchParams.get('features'));
        const fieldToggles = JSON.parse(parsed.searchParams.get('fieldToggles'));
        expect(features.view_counts_everywhere_api_enabled).toBe(true);
        expect(features.extra_flag_enabled).toBe(true);
        expect(fieldToggles.withArticleRichContentState).toBe(true);
        expect(fieldToggles.customToggle).toBe(true);
    });
});

describe('twitter thread command behavior', () => {
    const samplePayload = {
        data: {
            threaded_conversation_with_injections_v2: {
                instructions: [
                    {
                        entries: [
                            {
                                content: {
                                    itemContent: {
                                        tweet_results: {
                                            result: {
                                                rest_id: '999',
                                                legacy: { full_text: 'hello thread', favorite_count: 1, retweet_count: 0 },
                                                core: { user_results: { result: { legacy: { screen_name: 'bob' } } } },
                                            },
                                        },
                                    },
                                },
                            },
                        ],
                    },
                ],
            },
        },
    };

    it('navigates to https://x.com when current origin is not x.com and uses resolved queryId', async () => {
        const command = getRegistry().get('twitter/thread');
        const evaluatedScripts = [];
        const page = {
            getCookies: vi.fn().mockResolvedValue([{ name: 'ct0', value: 'csrf-token' }]),
            goto: vi.fn().mockResolvedValue(undefined),
            evaluate: vi.fn(async (script) => {
                evaluatedScripts.push(String(script));
                if (script === 'window.location.origin') return 'null';
                if (String(script).includes('placeholder.json')) {
                    return { queryId: 'DynamicTweetDetailId', features: { extra_flag: true }, fieldToggles: {} };
                }
                return samplePayload;
            }),
        };

        const rows = await command.func(page, { 'tweet-id': 'https://x.com/bob/status/999', limit: 10, 'top-by-engagement': 0 });
        expect(page.goto).toHaveBeenCalledWith('https://x.com', { waitUntil: 'load', settleMs: 1000 });
        expect(rows).toHaveLength(1);
        expect(rows[0].id).toBe('999');
        const fetchScript = evaluatedScripts.find((s) => s.includes('fetchJsonOrLoginWall'));
        expect(fetchScript).toContain('https://x.com/i/api/graphql/DynamicTweetDetailId/TweetDetail');
    });

    it('skips extra navigation when tab is already on https://x.com', async () => {
        const command = getRegistry().get('twitter/thread');
        const page = {
            getCookies: vi.fn().mockResolvedValue([{ name: 'ct0', value: 'csrf-token' }]),
            goto: vi.fn().mockResolvedValue(undefined),
            evaluate: vi.fn(async (script) => {
                if (script === 'window.location.origin') return { session: 'site:twitter', data: 'https://x.com' };
                if (String(script).includes('placeholder.json')) return null;
                return samplePayload;
            }),
        };

        const rows = await command.func(page, { 'tweet-id': '999', limit: 10, 'top-by-engagement': 0 });
        expect(page.goto).not.toHaveBeenCalled();
        expect(rows).toHaveLength(1);
    });
});
