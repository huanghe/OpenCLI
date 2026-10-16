import { beforeEach, describe, expect, it, vi } from 'vitest';
const { browserFetchMock } = vi.hoisted(() => ({
    browserFetchMock: vi.fn(),
}));
vi.mock('./_shared/browser-fetch.js', () => ({
    browserFetch: browserFetchMock,
}));
import { getRegistry } from '@jackwener/opencli/registry';
import './collections.js';
describe('douyin collections', () => {
    beforeEach(() => {
        browserFetchMock.mockReset();
    });

    it('uses the current mix list request shape', async () => {
        const registry = getRegistry();
        const command = [...registry.values()].find((cmd) => cmd.site === 'douyin' && cmd.name === 'collections');
        expect(command?.func).toBeDefined();
        if (!command?.func)
            throw new Error('douyin collections command not registered');
        browserFetchMock.mockResolvedValueOnce({
            mix_list: [],
        });
        const rows = await command.func({}, { limit: 12 });
        expect(browserFetchMock).toHaveBeenCalledWith({}, 'GET', 'https://creator.douyin.com/web/api/mix/list/?status=0,1,2,3,6&count=12&cursor=0&should_query_new_mix=1&device_platform=web&aid=1128');
        expect(rows).toEqual([]);
    });
});
