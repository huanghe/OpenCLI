import { describe, expect, it, vi } from 'vitest';
import {
    FETCH_BROWSE_FN,
    ensureYoutubeApiPage,
    extractJsonAssignmentFromHtml,
    extractSubscriptionChannel,
    prepareYoutubeApiPage,
    readYoutubeSapisid,
    throwYoutubeApiError,
} from './utils.js';
describe('youtube utils', () => {
    it('extractJsonAssignmentFromHtml parses bootstrap objects with nested braces in strings', () => {
        const html = `
      <script>
        var ytInitialPlayerResponse = {
          "title": "brace { inside } string",
          "nested": { "count": 2, "text": "quote \\"value\\"" }
        };
      </script>
    `;
        expect(extractJsonAssignmentFromHtml(html, 'ytInitialPlayerResponse')).toEqual({
            title: 'brace { inside } string',
            nested: { count: 2, text: 'quote "value"' },
        });
    });
    it('extractJsonAssignmentFromHtml supports window assignments', () => {
        const html = `
      <script>
        window["ytInitialData"] = {"contents":{"items":[1,2,3]}};
      </script>
    `;
        expect(extractJsonAssignmentFromHtml(html, 'ytInitialData')).toEqual({
            contents: { items: [1, 2, 3] },
        });
    });
    it('prepareYoutubeApiPage loads the quiet API bootstrap page', async () => {
        const page = {
            goto: vi.fn().mockResolvedValue(undefined),
            wait: vi.fn().mockResolvedValue(undefined),
        };
        await expect(prepareYoutubeApiPage(page)).resolves.toBeUndefined();
        expect(page.goto).toHaveBeenCalledWith('https://www.youtube.com', { waitUntil: 'none' });
        expect(page.wait).toHaveBeenCalledWith(2);
    });
    it('ensureYoutubeApiPage reuses a ready youtube tab without goto or wait', async () => {
        const page = {
            goto: vi.fn().mockResolvedValue(undefined),
            wait: vi.fn().mockResolvedValue(undefined),
            evaluate: vi.fn().mockResolvedValue({ session: 'site:youtube', data: true }),
        };
        await expect(ensureYoutubeApiPage(page)).resolves.toBeUndefined();
        expect(page.goto).not.toHaveBeenCalled();
        expect(page.wait).not.toHaveBeenCalled();
    });
    it('ensureYoutubeApiPage navigates and stops polling as soon as ytcfg becomes ready', async () => {
        const page = {
            goto: vi.fn().mockResolvedValue(undefined),
            wait: vi.fn().mockResolvedValue(undefined),
            evaluate: vi.fn()
                .mockResolvedValueOnce(false)
                .mockResolvedValueOnce(false)
                .mockResolvedValueOnce(true),
        };
        await expect(ensureYoutubeApiPage(page)).resolves.toBeUndefined();
        expect(page.goto).toHaveBeenCalledWith('https://www.youtube.com');
        expect(page.wait).toHaveBeenCalledTimes(1);
        expect(page.wait).toHaveBeenCalledWith(0.2);
    });
    it('readYoutubeSapisid reads URL-scoped cookies and prefers secure SAPISID', async () => {
        const page = {
            getCookies: vi.fn().mockResolvedValue([
                { name: 'SAPISID', value: 'legacy' },
                { name: '__Secure-3PAPISID', value: 'secure' },
            ]),
        };
        await expect(readYoutubeSapisid(page)).resolves.toBe('secure');
        expect(page.getCookies).toHaveBeenCalledWith({ url: 'https://www.youtube.com' });
    });
    it('readYoutubeSapisid falls back to legacy SAPISID', async () => {
        const page = {
            getCookies: vi.fn().mockResolvedValue([{ name: 'SAPISID', value: 'legacy' }]),
        };
        await expect(readYoutubeSapisid(page)).resolves.toBe('legacy');
    });
    it('extractSubscriptionChannel prefers explicit handle and subscriber count fields', () => {
        expect(extractSubscriptionChannel({
            title: { simpleText: 'OpenAI' },
            channelHandleText: { runs: [{ text: '@openai' }] },
            subscriberCountText: { simpleText: '1.23M subscribers' },
            videoCountText: { simpleText: '123 videos' },
            navigationEndpoint: { browseEndpoint: { canonicalBaseUrl: '/channel/UC123' } },
            channelId: 'UC123',
        })).toEqual({
            name: 'OpenAI',
            handle: '@openai',
            subscribers: '1.23M subscribers',
            url: 'https://www.youtube.com/channel/UC123',
        });
    });
    it('extractSubscriptionChannel falls back when handle/count fields are overloaded', () => {
        expect(extractSubscriptionChannel({
            title: {
                runs: [{ text: 'OpenAI' }],
            },
            subscriberCountText: { simpleText: '@openai' },
            videoCountText: { simpleText: '1.23M subscribers' },
            navigationEndpoint: { browseEndpoint: { canonicalBaseUrl: '/@openai' } },
            channelId: 'UC123',
        })).toEqual({
            name: 'OpenAI',
            handle: '@openai',
            subscribers: '1.23M subscribers',
            url: 'https://www.youtube.com/@openai',
        });
    });
});

describe('parseYoutubeCount', () => {
    it('parses subscriber / video display text into integers', async () => {
        const { parseYoutubeCount } = await import('./utils.js');
        expect(parseYoutubeCount('1.2M subscribers')).toBe(1200000);
        expect(parseYoutubeCount('345 videos')).toBe(345);
        expect(parseYoutubeCount('12.5K')).toBe(12500);
        expect(parseYoutubeCount('1,234 subscribers')).toBe(1234);
        expect(parseYoutubeCount('1.2万位订阅者')).toBe(12000);
        expect(parseYoutubeCount(7)).toBe(7);
    });

    it('returns null when no number is present', async () => {
        const { parseYoutubeCount } = await import('./utils.js');
        expect(parseYoutubeCount('')).toBeNull();
        expect(parseYoutubeCount('No videos')).toBeNull();
        expect(parseYoutubeCount(undefined)).toBeNull();
    });
});

describe('FETCH_BROWSE_FN and throwYoutubeApiError', () => {
    it('retries once on transient TypeError: Failed to fetch and succeeds when retry succeeds', async () => {
        let calls = 0;
        const fetchBrowse = new Function('fetch', `${FETCH_BROWSE_FN}; return fetchBrowse;`)(async () => {
            calls += 1;
            if (calls === 1) throw new TypeError('Failed to fetch');
            return { ok: true, status: 200, json: async () => ({ contents: {} }) };
        });
        await expect(fetchBrowse('key', { browseId: 'UC1' }, { retryDelayMs: 0 })).resolves.toEqual({ contents: {} });
        expect(calls).toBe(2);
    });

    it('returns __networkError after exhausting the single retry and maps to TransientNetworkError (exit 75)', async () => {
        let calls = 0;
        const fetchBrowse = new Function('fetch', `${FETCH_BROWSE_FN}; return fetchBrowse;`)(async () => {
            calls += 1;
            throw new TypeError('Failed to fetch');
        });
        const res = await fetchBrowse('key', { browseId: 'UC1' }, { retryDelayMs: 0 });
        expect(calls).toBe(2);
        expect(res).toMatchObject({ __networkError: true, status: 0 });
        expect(() => throwYoutubeApiError(res)).toThrow(expect.objectContaining({
            code: 'NETWORK_ERROR',
            exitCode: 75,
        }));
    });

    it('preserves HTTP status on error responses and maps 429 / 5xx to TEMPFAIL (exit 75)', async () => {
        const fetchBrowse = new Function('fetch', `${FETCH_BROWSE_FN}; return fetchBrowse;`)(async () => ({
            ok: false,
            status: 429,
        }));
        const res429 = await fetchBrowse('key', { browseId: 'UC1' });
        expect(res429).toEqual({ error: 'InnerTube browse API returned HTTP 429', status: 429 });
        expect(() => throwYoutubeApiError(res429)).toThrow(expect.objectContaining({
            code: 'RATE_LIMITED',
            exitCode: 75,
        }));
        expect(() => throwYoutubeApiError({ error: 'HTTP 503', status: 503 })).toThrow(expect.objectContaining({
            code: 'NETWORK_ERROR',
            exitCode: 75,
        }));
        expect(() => throwYoutubeApiError({ error: 'HTTP 400', status: 400 })).toThrow(expect.objectContaining({
            code: 'COMMAND_EXEC',
            exitCode: 1,
        }));
    });
});
