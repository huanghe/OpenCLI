import { describe, expect, it } from 'vitest';
import { extractMemberEntry, parseListMembers } from './list-members.js';

describe('twitter list-members parser', () => {
    it('extracts a member entry with full metadata', () => {
        const result = {
            __typename: 'User',
            rest_id: '12345',
            core: { screen_name: 'AlicePhd', name: 'Alice (PhD)' },
            legacy: { description: 'NLP researcher', followers_count: 1234 },
        };
        expect(extractMemberEntry(result, new Set())).toEqual({
            screen_name: 'AlicePhd',
            name: 'Alice (PhD)',
            bio: 'NLP researcher',
            followers: 1234,
        });
    });

    it('falls back to legacy fields when core is missing', () => {
        const result = {
            __typename: 'User',
            id_str: '99',
            legacy: { screen_name: 'BobLegacy', name: 'Bob', description: '', followers_count: 0 },
        };
        const m = extractMemberEntry(result, new Set());
        expect(m?.screen_name).toBe('BobLegacy');
        expect(m?.name).toBe('Bob');
    });

    it('returns null for non-User typename', () => {
        expect(extractMemberEntry({ __typename: 'TweetTombstone', rest_id: '1' }, new Set())).toBeNull();
    });

    it('returns null when rest_id is missing', () => {
        expect(extractMemberEntry({ __typename: 'User', core: { screen_name: 'noid' } }, new Set())).toBeNull();
    });

    it('returns null when screen_name cannot be resolved', () => {
        expect(extractMemberEntry({ __typename: 'User', rest_id: '1' }, new Set())).toBeNull();
    });

    it('dedupes by rest_id within a single seen set', () => {
        const r = { __typename: 'User', rest_id: '7', core: { screen_name: 'dup' } };
        const seen = new Set();
        expect(extractMemberEntry(r, seen)).not.toBeNull();
        expect(extractMemberEntry(r, seen)).toBeNull();
    });

    it('parses members_timeline payload with users + cursor', () => {
        const payload = {
            data: {
                list: {
                    members_timeline: {
                        timeline: {
                            instructions: [
                                {
                                    type: 'TimelineAddEntries',
                                    entries: [
                                        {
                                            entryId: 'user-1',
                                            content: {
                                                itemContent: {
                                                    user_results: {
                                                        result: {
                                                            __typename: 'User',
                                                            rest_id: '1',
                                                            core: { screen_name: 'a', name: 'A' },
                                                            legacy: { description: '', followers_count: 5 },
                                                        },
                                                    },
                                                },
                                            },
                                        },
                                        {
                                            entryId: 'user-2',
                                            content: {
                                                itemContent: {
                                                    user_results: {
                                                        result: {
                                                            __typename: 'User',
                                                            rest_id: '2',
                                                            core: { screen_name: 'b', name: 'B' },
                                                            legacy: { description: 'bio', followers_count: 100 },
                                                        },
                                                    },
                                                },
                                            },
                                        },
                                        {
                                            entryId: 'cursor-bottom-XYZ',
                                            content: {
                                                entryType: 'TimelineTimelineCursor',
                                                cursorType: 'Bottom',
                                                value: 'CURSOR_NEXT',
                                            },
                                        },
                                    ],
                                },
                            ],
                        },
                    },
                },
            },
        };
        const { members, nextCursor } = parseListMembers(payload, new Set());
        expect(members).toHaveLength(2);
        expect(members.map(m => m.screen_name)).toEqual(['a', 'b']);
        expect(nextCursor).toBe('CURSOR_NEXT');
    });

    it('handles missing instructions gracefully', () => {
        expect(parseListMembers({}, new Set())).toEqual({ members: [], nextCursor: null });
        expect(parseListMembers({ data: {} }, new Set())).toEqual({ members: [], nextCursor: null });
        expect(parseListMembers({ data: { list: {} } }, new Set())).toEqual({ members: [], nextCursor: null });
    });

    it('dedupes across pages when reusing the same seen set', () => {
        const buildPayload = (restId) => ({
            data: {
                list: {
                    members_timeline: {
                        timeline: {
                            instructions: [{
                                entries: [{
                                    entryId: `user-${restId}`,
                                    content: {
                                        itemContent: {
                                            user_results: {
                                                result: {
                                                    __typename: 'User',
                                                    rest_id: String(restId),
                                                    core: { screen_name: `u${restId}` },
                                                    legacy: {},
                                                },
                                            },
                                        },
                                    },
                                }],
                            }],
                        },
                    },
                },
            },
        });
        const seen = new Set();
        const p1 = parseListMembers(buildPayload(1), seen);
        const p2 = parseListMembers(buildPayload(1), seen);  // same user reappears
        expect(p1.members).toHaveLength(1);
        expect(p2.members).toHaveLength(0);
    });

    it('falls back to alternate timeline paths', () => {
        const payload = {
            data: {
                list: {
                    timeline: {
                        timeline: {
                            instructions: [{
                                entries: [{
                                    entryId: 'user-9',
                                    content: {
                                        itemContent: {
                                            user_results: {
                                                result: {
                                                    __typename: 'User',
                                                    rest_id: '9',
                                                    core: { screen_name: 'fallback' },
                                                    legacy: {},
                                                },
                                            },
                                        },
                                    },
                                }],
                            }],
                        },
                    },
                },
            },
        };
        const { members } = parseListMembers(payload, new Set());
        expect(members.map(m => m.screen_name)).toEqual(['fallback']);
    });
});
