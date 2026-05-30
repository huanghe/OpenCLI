import { describe, expect, it, vi } from 'vitest';
import { getRegistry } from '@jackwener/opencli/registry';
import { ArgumentError, AuthRequiredError, CommandExecutionError } from '@jackwener/opencli/errors';

import { __test__ } from './follow.js';

/**
 * The patched follow.js does, in order:
 *   1. page.goto(url)               — navigate to profile
 *   2. page.wait                    — settle
 *   3. page.evaluate(location.href) — login redirect check
 *   4. page.evaluate(clickScript)   — find scope, click CTA, return diag
 *   5. page.wait                    — post-click settle
 *   6. page.goto(url)               — reload to force server-state into DOM
 *   7. page.wait                    — reload settle
 *   8. page.evaluate(verifyScript)  — read fresh button state, authoritative
 *
 * makePage queues evaluate results in the order they will be consumed.
 */
function makePage(evaluateResults = []) {
    const evaluate = vi.fn();
    for (const r of evaluateResults) evaluate.mockResolvedValueOnce(r);
    evaluate.mockResolvedValue(undefined);
    return {
        goto: vi.fn().mockResolvedValue(undefined),
        wait: vi.fn().mockResolvedValue(undefined),
        evaluate,
    };
}

const validId = '5d8f88dc0000000001005d3a';
const profileUrl = `https://www.xiaohongshu.com/user/profile/${validId}`;

describe('xiaohongshu follow', () => {
    const getCommand = () => getRegistry().get('xiaohongshu/follow');

    it('returns followed when click dispatches and post-reload verify sees 已关注', async () => {
        const page = makePage([
            profileUrl,                              // location.href
            { ok: true, state: 'click-dispatched',   // clickScript
              diag: { clicked_button_html: '<button>关注</button>', dialogs_after_click: 0 } },
            { ok: true, state: 'followed' },         // verifyScript
        ]);
        const result = await getCommand().func(page, { 'user-id': validId });
        expect(result).toEqual([{ status: 'followed', user_id: validId, url: profileUrl }]);
        // Profile loaded once at start, reloaded once after click.
        expect(page.goto).toHaveBeenCalledTimes(2);
        expect(page.goto).toHaveBeenNthCalledWith(1, profileUrl);
        expect(page.goto).toHaveBeenNthCalledWith(2, profileUrl);
    });

    it('returns already-following without reloading when 已关注 is showing on entry', async () => {
        const page = makePage([
            profileUrl,
            { ok: true, state: 'already-following' },  // clickScript short-circuits
        ]);
        const result = await getCommand().func(page, { 'user-id': validId });
        expect(result[0].status).toBe('already-following');
        // No reload needed when fast-path hits.
        expect(page.goto).toHaveBeenCalledTimes(1);
    });

    it('accepts a full profile URL with query and extracts the user id', async () => {
        const page = makePage([
            profileUrl,
            { ok: true, state: 'click-dispatched', diag: {} },
            { ok: true, state: 'followed' },
        ]);
        await getCommand().func(page, {
            'user-id': `${profileUrl}?xsec_token=abc&xsec_source=pc`,
        });
        expect(page.goto).toHaveBeenNthCalledWith(1, profileUrl);
    });

    it('unwraps browser bridge envelopes at every evaluate boundary', async () => {
        const page = makePage([
            { session: 's', data: profileUrl },
            { session: 's', data: { ok: true, state: 'click-dispatched', diag: {} } },
            { session: 's', data: { ok: true, state: 'followed' } },
        ]);
        const result = await getCommand().func(page, { 'user-id': validId });
        expect(result[0].status).toBe('followed');
    });

    it('rejects malformed user ids before navigation', async () => {
        const page = makePage();
        await expect(getCommand().func(page, { 'user-id': '' })).rejects.toBeInstanceOf(ArgumentError);
        await expect(getCommand().func(page, { 'user-id': 'short' })).rejects.toBeInstanceOf(ArgumentError);
        expect(page.goto).not.toHaveBeenCalled();
    });

    it('throws AuthRequiredError when xhs redirects to /login', async () => {
        const page = makePage([
            'https://www.xiaohongshu.com/login?redirectPath=/user/profile/' + validId,
        ]);
        await expect(getCommand().func(page, { 'user-id': validId })).rejects.toBeInstanceOf(AuthRequiredError);
    });

    it('throws with diagnostics when the click step cannot find the CTA in scope', async () => {
        const page = makePage([
            profileUrl,
            { ok: false, state: 'failed',
              reason: 'Follow CTA not found in profile-header scope (logged out, blocked, private, or label list out of date).',
              diag: { url_after: profileUrl, scope_button_labels: ['消息', '设置'] } },
        ]);
        await expect(getCommand().func(page, { 'user-id': validId }))
            .rejects.toThrowError(/CTA not found .*scope_buttons=.*消息/);
        // Should not reload when click itself failed.
        expect(page.goto).toHaveBeenCalledTimes(1);
    });

    it('throws not-followed with merged diagnostics when post-reload server still shows 关注', async () => {
        const page = makePage([
            profileUrl,
            { ok: true, state: 'click-dispatched',
              diag: { clicked_button_html: '<button>关注</button>', dialogs_after_click: 1 } },
            { ok: false, state: 'not-followed',
              reason: 'After reload, server still shows 关注 — click did not take effect (likely React handler missed, modal blocked, or backend silently rejected).',
              diag: { url_after: profileUrl, scope_button_labels: ['关注', '消息'] } },
        ]);
        await expect(getCommand().func(page, { 'user-id': validId }))
            .rejects.toThrowError(/not-followed.*clicked_button_html.*dialogs_after_click=1.*scope_buttons/);
        // Reload did happen; verify-fail surfaces in the error.
        expect(page.goto).toHaveBeenCalledTimes(2);
    });

    it('throws unknown state with diagnostics when post-reload scope vanishes', async () => {
        const page = makePage([
            profileUrl,
            { ok: true, state: 'click-dispatched', diag: {} },
            { ok: false, state: 'unknown',
              reason: 'Post-reload: no profile-header scope on page (login bounce? rate limit?).',
              diag: { url_after: profileUrl } },
        ]);
        await expect(getCommand().func(page, { 'user-id': validId }))
            .rejects.toThrowError(/unknown:.*no profile-header scope/);
    });

    it('throws CommandExecutionError for malformed evaluate payloads', async () => {
        const page1 = makePage([{ not: 'a string' }]);
        await expect(getCommand().func(page1, { 'user-id': validId }))
            .rejects.toThrowError(/malformed current-url payload/);

        const page2 = makePage([
            profileUrl,
            { ok: 'yes', state: 'click-dispatched' },  // ok is not boolean
        ]);
        await expect(getCommand().func(page2, { 'user-id': validId }))
            .rejects.toThrowError(/malformed click-action payload/);

        const page3 = makePage([
            profileUrl,
            { ok: true, state: 'click-dispatched', diag: {} },
            { state: 'followed' },                     // missing ok
        ]);
        await expect(getCommand().func(page3, { 'user-id': validId }))
            .rejects.toThrowError(/malformed verify-action payload/);
    });

    describe('__test__.assertUserId', () => {
        it('normalizes raw user ids and URL forms', () => {
            expect(__test__.assertUserId(validId)).toBe(validId);
            expect(__test__.assertUserId(profileUrl)).toBe(validId);
            expect(__test__.assertUserId(`${profileUrl}?xsec_token=t`)).toBe(validId);
            expect(__test__.assertUserId(`${profileUrl}/`)).toBe(validId);
        });
        it('rejects too-short or non-alphanumeric ids', () => {
            expect(() => __test__.assertUserId('')).toThrow(ArgumentError);
            expect(() => __test__.assertUserId('abc')).toThrow(ArgumentError);
            expect(() => __test__.assertUserId('!!!')).toThrow(ArgumentError);
        });
    });

    describe('__test__.formatDiagnostics', () => {
        it('renders an empty string when diag is absent or empty', () => {
            expect(__test__.formatDiagnostics(undefined)).toBe('');
            expect(__test__.formatDiagnostics({})).toBe('');
        });
        it('surfaces clicked button HTML, scope buttons, and url_after', () => {
            const s = __test__.formatDiagnostics({
                clicked_button_html: '<button class="follow">关注</button>',
                scope_class: 'user-info',
                dialogs_after_click: 2,
                scope_button_labels: ['关注', '消息', '设置'],
                url_after: profileUrl,
            });
            expect(s).toMatch(/clicked_button_html=/);
            expect(s).toMatch(/scope=user-info/);
            expect(s).toMatch(/dialogs_after_click=2/);
            expect(s).toMatch(/scope_buttons=.*关注.*消息/);
            expect(s).toMatch(/url_after=https:/);
        });
        it('caps scope_button_labels at 12 entries to keep error lines readable', () => {
            const labels = Array.from({ length: 30 }, (_, i) => `btn${i}`);
            const s = __test__.formatDiagnostics({ scope_button_labels: labels });
            expect(s).toMatch(/btn0/);
            expect(s).toMatch(/btn11/);
            expect(s).not.toMatch(/btn12/);  // 13th label dropped
        });
    });

    describe('__test__.buildClickScript', () => {
        it('emits a self-contained IIFE that references SCOPE_SELECTORS and PointerEvent', () => {
            const src = __test__.buildClickScript();
            // No template literal escapes leaked through:
            expect(src).not.toMatch(/\$\{/);
            // Key behaviors of the patched script:
            expect(src).toMatch(/SCOPE_SELECTORS/);
            expect(src).toMatch(/PointerEvent\('pointerdown'/);
            expect(src).toMatch(/dispatchEvent\(new MouseEvent\('click'/);
            // No silent fallback to document anymore:
            expect(src).not.toMatch(/roots\s*=.*\[\s*document\s*\]/);
            // Click-then-poll-for-flip pattern is GONE — verify runs post-reload:
            expect(src).not.toMatch(/STATE_FLIP_TIMEOUT_MS/);
        });
    });
});
