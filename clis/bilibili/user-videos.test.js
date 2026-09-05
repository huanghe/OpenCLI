import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockApiGet, mockResolveUid } = vi.hoisted(() => ({
    mockApiGet: vi.fn(),
    mockResolveUid: vi.fn(),
}));
vi.mock('./utils.js', async (importOriginal) => ({
    ...(await importOriginal()),
    apiGet: mockApiGet,
    resolveUid: mockResolveUid,
}));

import { getRegistry } from '@jackwener/opencli/registry';
import './user-videos.js';

const command = getRegistry().get('bilibili/user-videos');

/** One vlist entry shaped like /x/space/wbi/arc/search returns it. */
function vlistItem() {
    return {
        title: '去了一趟西班牙2.0（日全食篇）',
        bvid: 'BV1Na4Q64Eos',
        play: 2483267,
        comment: 3319,
        video_review: 42447,
        created: 1788058800,
        length: '24:34',
        pic: 'http://i0.hdslb.com/bfs/archive/cover.jpg',
        description: '时隔两个月',
        is_pay: 0,
    };
}

describe('bilibili user-videos adapter', () => {
    beforeEach(() => {
        mockApiGet.mockReset();
        mockResolveUid.mockReset().mockResolvedValue('946974');
    });

    it('surfaces cover / duration / exact timestamp already present in vlist', async () => {
        mockApiGet.mockResolvedValue({ data: { list: { vlist: [vlistItem()] } } });
        const [row] = await command.func({}, { uid: '946974', limit: 1 });
        expect(row).toMatchObject({
            rank: 1,
            plays: 2483267,
            comments: 3319,
            danmaku: 42447,
            // date stays day-granularity; created_ts is the raw unix second.
            date: '2026-08-30',
            created_ts: 1788058800,
            duration: '24:34',
            duration_sec: 1474,
            bvid: 'BV1Na4Q64Eos',
            cover: 'https://i0.hdslb.com/bfs/archive/cover.jpg',
            desc: '时隔两个月',
            is_pay: false,
        });
    });

    it('declares every emitted key in columns', async () => {
        mockApiGet.mockResolvedValue({ data: { list: { vlist: [vlistItem()] } } });
        const [row] = await command.func({}, { uid: '946974', limit: 1 });
        expect(Object.keys(row).sort()).toEqual([...command.columns].sort());
    });
});
