import { describe, expect, it, vi } from 'vitest';
import { getRegistry } from '@jackwener/opencli/registry';
import { ArgumentError, AuthRequiredError, CommandExecutionError, EmptyResultError } from '@jackwener/opencli/errors';
import { __test__ } from './list-members.js';

function userResult(id, screenName, extra = {}) {
    return {
        __typename: 'User',
        rest_id: id,
        core: { screen_name: screenName, name: `Name ${screenName}` },
        legacy: { description: `bio ${screenName}`, followers_count: 10 },
        avatar: { image_url: `https://pbs.twimg.com/profile_images/${id}/x_normal.jpg` },
        ...extra,
    };
}

function membersPayload(users, cursor) {
    const entries = users.map((u) => ({
        entryId: `user-${u.rest_id}`,
        content: { entryType: 'TimelineTimelineItem', itemContent: { itemType: 'TimelineUser', user_results: { result: u } } },
    }));
    if (cursor) {
        entries.push({ entryId: `cursor-bottom-${cursor}`, content: { entryType: 'TimelineTimelineCursor', cursorType: 'Bottom', value: cursor } });
    }
    return { data: { list: { members_timeline: { timeline: { instructions: [{ type: 'TimelineAddEntries', entries }] } } } } };
}

function makePage(responses) {
    const evaluate = vi.fn(async (script) => {
        const source = String(script);
        // queryId resolution probes (placeholder.json / bundle scan) → let the fallback win.
        if (source.includes('placeholder.json') || source.includes('client-web')) return null;
        return responses.shift();
    });
    return {
        goto: vi.fn().mockResolvedValue(undefined),
        wait: vi.fn().mockResolvedValue(undefined),
        getCookies: vi.fn().mockResolvedValue([{ name: 'ct0', value: 'csrf' }]),
        evaluate,
    };
}

describe('twitter list-members', () => {
    it('builds the ListMembers GraphQL url with and without cursor', () => {
        const url = __test__.buildListMembersUrl('QID', '123', 100, 'c1');
        expect(url).toContain('/i/api/graphql/QID/ListMembers');
        expect(decodeURIComponent(url)).toContain('"listId":"123"');
        expect(decodeURIComponent(url)).toContain('"cursor":"c1"');
        expect(decodeURIComponent(__test__.buildListMembersUrl('QID', '123', 100))).not.toContain('"cursor"');
    });

    it('extracts members with discovery fields and dedupes by rest_id', () => {
        const seen = new Set();
        expect(__test__.extractMemberEntry(userResult('1', 'alice', { is_blue_verified: true }), seen)).toEqual({
            user_id: '1',
            screen_name: 'alice',
            name: 'Name alice',
            bio: 'bio alice',
            followers: 10,
            verified: true,
            avatar: 'https://pbs.twimg.com/profile_images/1/x_400x400.jpg',
            url: 'https://x.com/alice',
        });
        expect(__test__.extractMemberEntry(userResult('1', 'alice'), seen)).toBeNull();
        expect(__test__.extractMemberEntry({ __typename: 'UserUnavailable' }, seen)).toBeNull();
    });

    it('parses members and the bottom cursor, including nested module items', () => {
        const seen = new Set();
        const payload = membersPayload([userResult('1', 'a'), userResult('2', 'b')], 'next');
        payload.data.list.members_timeline.timeline.instructions[0].entries.push({
            entryId: 'module-1',
            content: { items: [{ item: { itemContent: { user_results: { result: userResult('3', 'c') } } } }] },
        });
        const { members, nextCursor } = __test__.parseListMembers(payload, seen);
        expect(members.map((m) => m.screen_name)).toEqual(['a', 'b', 'c']);
        expect(nextCursor).toBe('next');
    });

    it('accepts numeric ids and list URLs, rejects garbage', () => {
        expect(__test__.parseListId('123')).toBe('123');
        expect(__test__.parseListId('https://x.com/i/lists/456/members')).toBe('456');
        expect(() => __test__.parseListId('abc')).toThrow(ArgumentError);
    });

    it('paginates until --limit and trims', async () => {
        const command = getRegistry().get('twitter/list-members');
        const page = makePage([
            membersPayload([userResult('1', 'a'), userResult('2', 'b')], 'c1'),
            membersPayload([userResult('3', 'c')], null),
        ]);
        const rows = await command.func(page, { 'list-id': '123', limit: 3 });
        expect(rows.map((r) => r.screen_name)).toEqual(['a', 'b', 'c']);
        expect(page.goto).toHaveBeenCalledWith('https://x.com/i/lists/123/members', expect.any(Object));
    });

    it('maps auth failures and empty lists', async () => {
        const command = getRegistry().get('twitter/list-members');
        const noCookie = makePage([]);
        noCookie.getCookies.mockResolvedValue([]);
        await expect(command.func(noCookie, { 'list-id': '1', limit: 10 })).rejects.toBeInstanceOf(AuthRequiredError);

        await expect(command.func(makePage([{ error: 403 }]), { 'list-id': '1', limit: 10 })).rejects.toBeInstanceOf(AuthRequiredError);
        await expect(command.func(makePage([{ error: 404 }]), { 'list-id': '1', limit: 10 })).rejects.toBeInstanceOf(CommandExecutionError);
        await expect(command.func(makePage([membersPayload([], null)]), { 'list-id': '1', limit: 10 })).rejects.toBeInstanceOf(EmptyResultError);
        await expect(command.func(makePage([]), { 'list-id': '1', limit: 0 })).rejects.toBeInstanceOf(ArgumentError);
    });
});
