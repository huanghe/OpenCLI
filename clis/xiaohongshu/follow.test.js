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
 *   5. page.wait                    — modal-mount settle
 *   6. page.evaluate(modalScript)   — dismiss any post-click modal
 *   7. page.wait                    — post-confirm settle
 *   8. page.goto(url)               — reload to force server state into DOM
 *   9. page.wait                    — reload settle
 *  10. page.evaluate(verifyScript)  — read fresh button state, authoritative
 *
 * The already-following fast path stops after step 4 with no reload.
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

    it('returns followed on the no-modal happy path (click → no_modal → reload → verify)', async () => {
        const page = makePage([
            profileUrl,                                                  // location.href
            { ok: true, state: 'click-dispatched', diag: {} },           // clickScript
            { ok: true, state: 'no_modal' },                             // modalScript
            { ok: true, state: 'followed' },                             // verifyScript
        ]);
        const result = await getCommand().func(page, { 'user-id': validId });
        expect(result).toEqual([{ status: 'followed', user_id: validId, url: profileUrl }]);
        expect(page.goto).toHaveBeenCalledTimes(2);
        expect(page.evaluate).toHaveBeenCalledTimes(4);
    });

    it('returns followed on the modal-present happy path (click → confirmed → reload → verify)', async () => {
        const page = makePage([
            profileUrl,
            { ok: true, state: 'click-dispatched',
              diag: { dialogs_after_click: 1, clicked_button_html: '<button class="follow-button">关注</button>' } },
            { ok: true, state: 'confirmed',
              diag: { modal_state: 'confirmed', modal_button_labels: ['确认关注', '取消'] } },
            { ok: true, state: 'followed' },
        ]);
        const result = await getCommand().func(page, { 'user-id': validId });
        expect(result[0].status).toBe('followed');
        expect(page.goto).toHaveBeenCalledTimes(2);
    });

    it('returns already-following without modal or reload when 已关注 visible on entry', async () => {
        const page = makePage([
            profileUrl,
            { ok: true, state: 'already-following' },
        ]);
        const result = await getCommand().func(page, { 'user-id': validId });
        expect(result[0].status).toBe('already-following');
        expect(page.goto).toHaveBeenCalledTimes(1);
        expect(page.evaluate).toHaveBeenCalledTimes(2);
    });

    it('accepts a full profile URL with query and extracts the user id', async () => {
        const page = makePage([
            profileUrl,
            { ok: true, state: 'click-dispatched', diag: {} },
            { ok: true, state: 'no_modal' },
            { ok: true, state: 'followed' },
        ]);
        await getCommand().func(page, { 'user-id': `${profileUrl}?xsec_token=abc` });
        expect(page.goto).toHaveBeenNthCalledWith(1, profileUrl);
    });

    it('unwraps browser bridge envelopes at every evaluate boundary', async () => {
        const page = makePage([
            { session: 's', data: profileUrl },
            { session: 's', data: { ok: true, state: 'click-dispatched', diag: {} } },
            { session: 's', data: { ok: true, state: 'no_modal' } },
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

    it('throws a clear network error when Chrome falls to chrome-error://chromewebdata/', async () => {
        const page = makePage([
            'chrome-error://chromewebdata/',
        ]);
        await expect(getCommand().func(page, { 'user-id': validId }))
            .rejects.toThrowError(/browser could not load .* chrome-error.*network issue/);
        // Did not proceed to clickScript / modalScript / reload.
        expect(page.evaluate).toHaveBeenCalledTimes(1);
        expect(page.goto).toHaveBeenCalledTimes(1);
    });

    it('throws with diagnostics when click step cannot find the CTA in scope', async () => {
        const page = makePage([
            profileUrl,
            { ok: false, state: 'failed',
              reason: 'Follow CTA not found in profile-header scope (logged out, blocked, private, or label list out of date).',
              diag: { url_after: profileUrl, scope_button_labels: ['消息', '设置'] } },
        ]);
        await expect(getCommand().func(page, { 'user-id': validId }))
            .rejects.toThrowError(/CTA not found .*scope_buttons=.*消息/);
        expect(page.goto).toHaveBeenCalledTimes(1);
        expect(page.evaluate).toHaveBeenCalledTimes(2);
    });

    it('throws risk_verification with modal_text when xhs pops a captcha/identity modal', async () => {
        const page = makePage([
            profileUrl,
            { ok: true, state: 'click-dispatched', diag: { dialogs_after_click: 1 } },
            { ok: false, state: 'risk_verification',
              reason: 'xhs returned a risk-verification modal (滑动验证) — needs manual action in the browser before retrying.',
              diag: { modal_state: 'risk', modal_text: '请完成滑动验证以继续操作', url_after: profileUrl } },
        ]);
        await expect(getCommand().func(page, { 'user-id': validId }))
            .rejects.toThrowError(/risk_verification.*滑动验证.*modal_state=risk.*modal_text/);
        // Did not reload (risk modal blocks).
        expect(page.goto).toHaveBeenCalledTimes(1);
    });

    it('throws no_confirm with modal_button_labels when the modal has unknown buttons', async () => {
        const page = makePage([
            profileUrl,
            { ok: true, state: 'click-dispatched', diag: { dialogs_after_click: 1 } },
            { ok: false, state: 'no_confirm',
              reason: 'xhs follow-confirmation modal appeared, but no recognized confirm button was found. Add the modal label list to CONFIRM_LABELS in follow.js.',
              diag: { modal_state: 'unknown_buttons',
                      modal_text: '小红书很高兴遇见你',
                      modal_button_labels: ['立即体验', '稍后再说'] } },
        ]);
        await expect(getCommand().func(page, { 'user-id': validId }))
            .rejects.toThrowError(/no_confirm.*modal_buttons=\["立即体验","稍后再说"\]/);
    });

    it('throws not-followed with merged diagnostics when post-reload server still shows 关注', async () => {
        const page = makePage([
            profileUrl,
            { ok: true, state: 'click-dispatched',
              diag: { clicked_button_html: '<button>关注</button>', dialogs_after_click: 1 } },
            { ok: true, state: 'confirmed',
              diag: { modal_state: 'confirmed', modal_button_labels: ['确认关注'] } },
            { ok: false, state: 'not-followed',
              reason: 'After reload, server still shows 关注 — click reached the handler but server did not commit the follow (backend rejected, or modal-confirm step missed the actual confirm button).',
              diag: { url_after: profileUrl, scope_button_labels: ['关注'] } },
        ]);
        await expect(getCommand().func(page, { 'user-id': validId }))
            .rejects.toThrowError(/not-followed.*clicked_button_html.*modal_state=confirmed.*scope_buttons/);
        expect(page.goto).toHaveBeenCalledTimes(2);
    });

    it('throws unknown when post-reload scope is missing', async () => {
        const page = makePage([
            profileUrl,
            { ok: true, state: 'click-dispatched', diag: {} },
            { ok: true, state: 'no_modal' },
            { ok: false, state: 'unknown',
              reason: 'Post-reload: no profile-header scope on page (login bounce? rate limit?).',
              diag: { url_after: profileUrl } },
        ]);
        await expect(getCommand().func(page, { 'user-id': validId }))
            .rejects.toThrowError(/unknown:.*no profile-header scope/);
    });

    it('throws CommandExecutionError for malformed evaluate payloads at each boundary', async () => {
        const page1 = makePage([{ not: 'a string' }]);
        await expect(getCommand().func(page1, { 'user-id': validId }))
            .rejects.toThrowError(/malformed current-url payload/);

        const page2 = makePage([
            profileUrl,
            { ok: 'yes', state: 'click-dispatched' },
        ]);
        await expect(getCommand().func(page2, { 'user-id': validId }))
            .rejects.toThrowError(/malformed click-action payload/);

        const page3 = makePage([
            profileUrl,
            { ok: true, state: 'click-dispatched', diag: {} },
            { state: 'no_modal' },                              // missing ok
        ]);
        await expect(getCommand().func(page3, { 'user-id': validId }))
            .rejects.toThrowError(/malformed modal-action payload/);

        const page4 = makePage([
            profileUrl,
            { ok: true, state: 'click-dispatched', diag: {} },
            { ok: true, state: 'no_modal' },
            { state: 'followed' },                              // missing ok
        ]);
        await expect(getCommand().func(page4, { 'user-id': validId }))
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
        it('renders empty when diag is absent or empty', () => {
            expect(__test__.formatDiagnostics(undefined)).toBe('');
            expect(__test__.formatDiagnostics({})).toBe('');
        });
        it('surfaces click + modal + verify fields when all present', () => {
            const s = __test__.formatDiagnostics({
                clicked_button_html: '<button class="follow">关注</button>',
                scope_class: 'user-info',
                dialogs_after_click: 1,
                modal_state: 'confirmed',
                modal_button_labels: ['确认关注', '取消'],
                modal_text: '小红书提示',
                scope_button_labels: ['关注', '消息'],
                url_after: profileUrl,
            });
            expect(s).toMatch(/clicked_button_html=/);
            expect(s).toMatch(/scope=user-info/);
            expect(s).toMatch(/dialogs_after_click=1/);
            expect(s).toMatch(/modal_state=confirmed/);
            expect(s).toMatch(/modal_buttons=\["确认关注","取消"\]/);
            expect(s).toMatch(/modal_text=/);
            expect(s).toMatch(/scope_buttons=/);
            expect(s).toMatch(/url_after=https:/);
        });
        it('caps scope_button_labels at 12 entries and modal_button_labels at 8', () => {
            const longScope = Array.from({ length: 30 }, (_, i) => `btn${i}`);
            const longModal = Array.from({ length: 20 }, (_, i) => `m${i}`);
            const s = __test__.formatDiagnostics({
                scope_button_labels: longScope,
                modal_button_labels: longModal,
            });
            expect(s).toMatch(/btn0/);
            expect(s).toMatch(/btn11/);
            expect(s).not.toMatch(/btn12/);
            expect(s).toMatch(/m0/);
            expect(s).toMatch(/m7/);
            expect(s).not.toMatch(/m8/);
        });
    });

    describe('__test__ scripts', () => {
        it('buildClickScript is self-contained and dispatches a full event sequence', () => {
            const src = __test__.buildClickScript();
            expect(src).not.toMatch(/\$\{/);              // no template-literal leaks
            expect(src).toMatch(/SCOPE_SELECTORS/);
            expect(src).toMatch(/PointerEvent\('pointerdown'/);
            expect(src).toMatch(/MouseEvent\('click'/);
            expect(src).toMatch(/dialogs_after_click/);
            // Class-based CTA matcher present (handles span-wrapped 关注 label).
            expect(src).toMatch(/follow-button/);
            // No DOM-flip polling — verify runs post-reload.
            expect(src).not.toMatch(/STATE_FLIP_TIMEOUT_MS/);
        });
        it('buildHandleModalScript detects risk modals and enforces a no-confirm fallback', () => {
            const src = __test__.buildHandleModalScript();
            expect(src).not.toMatch(/\$\{/);
            expect(src).toMatch(/RISK_KEYWORDS/);
            expect(src).toMatch(/CONFIRM_LABELS/);
            expect(src).toMatch(/CANCEL_LABELS/);
            expect(src).toMatch(/no_confirm/);
            expect(src).toMatch(/risk_verification/);
            // Same event-sequence dispatch on confirm button:
            expect(src).toMatch(/PointerEvent\('pointerdown'/);
        });
    });
});
