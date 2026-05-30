import { describe, expect, it, vi } from 'vitest';
import { getRegistry } from '@jackwener/opencli/registry';
import { ArgumentError, AuthRequiredError, CommandExecutionError } from '@jackwener/opencli/errors';

import { __test__ } from './follow.js';

/**
 * Adapter flow (v5 — CDP-trusted click + interceptor + diagnostics):
 *   1. page.goto(url)                     [goto:1]
 *   2. page.wait                          [wait]
 *   3. page.evaluate(location.href)       [eval:1] — login check
 *   4. page.installInterceptor('/api/sns') [intercept install — optional]
 *   5. page.evaluate(locateCtaScript)     [eval:2]
 *   6. page.click('[…follow-cta]')        [click:1 — only when cta-tagged]
 *   7. page.evaluate(click_log readback)  [eval:3]
 *   8. page.evaluate(doc_click_log readback) [eval:4]
 *   9. page.wait                          [wait]
 *  10. page.evaluate(locateModalScript)   [eval:5]
 *  11. page.click('[…modal-confirm]')     [click:2 — only when confirm-tagged]
 *  12. page.wait                          [wait]
 *  13. page.getInterceptedRequests()      [intercept read — optional]
 *  14. page.goto(url) reload              [goto:2]
 *  15. page.wait                          [wait]
 *  16. page.evaluate(verifyScript)        [eval:6]
 *
 * Fast paths short-circuit earlier (already-following stops after eval:2).
 */
function makePage(evaluateResults = [], extra = {}) {
    const evaluate = vi.fn();
    for (const r of evaluateResults) evaluate.mockResolvedValueOnce(r);
    evaluate.mockResolvedValue(undefined);
    return {
        goto: vi.fn().mockResolvedValue(undefined),
        wait: vi.fn().mockResolvedValue(undefined),
        evaluate,
        click: extra.click ?? vi.fn().mockResolvedValue({ matches_n: 1, match_level: 'exact' }),
        installInterceptor: extra.installInterceptor ?? vi.fn().mockResolvedValue(undefined),
        getInterceptedRequests: extra.getInterceptedRequests ?? vi.fn().mockResolvedValue([]),
    };
}

const validId = '5d8f88dc0000000001005d3a';
const profileUrl = `https://www.xiaohongshu.com/user/profile/${validId}`;

describe('xiaohongshu follow', () => {
    const getCommand = () => getRegistry().get('xiaohongshu/follow');

    it('returns followed on the no-modal happy path with trusted click + post-reload verify', async () => {
        const page = makePage([
            profileUrl,                                                 // eval:1 location.href
            { ok: true, state: 'cta-tagged', diag: { clicked_button_html: '<button class="follow-button">关注</button>' } }, // eval:2 locate
            [{ kind: 'click', isTrusted: true }],                       // eval:3 click_log
            [{ kind: 'click', isTrusted: true, clientX: 100, clientY: 200, targetHtml: '<button>关注</button>' }], // eval:4 doc_click_log
            { ok: true, state: 'no_modal' },                            // eval:5 modal
            { ok: true, state: 'followed' },                            // eval:6 verify
        ]);
        const result = await getCommand().func(page, { 'user-id': validId });
        expect(result).toEqual([{ status: 'followed', user_id: validId, url: profileUrl }]);
        expect(page.goto).toHaveBeenCalledTimes(2);                     // profile + reload
        expect(page.click).toHaveBeenCalledTimes(1);                    // CTA only
        expect(page.click.mock.calls[0][0]).toBe(`[data-opencli-target="${__test__.CTA_TAG}"]`);
        expect(page.installInterceptor).toHaveBeenCalledWith('/api/sns');
    });

    it('returns followed when a confirm modal appears and is dismissed via trusted click', async () => {
        const page = makePage([
            profileUrl,
            { ok: true, state: 'cta-tagged', diag: { clicked_button_html: '<button>关注</button>' } },
            [{ kind: 'click', isTrusted: true }],
            [{ kind: 'click', isTrusted: true }],
            { ok: true, state: 'confirm-tagged', diag: { modal_state: 'confirm-tagged', modal_button_labels: ['确认关注', '取消'] } },
            { ok: true, state: 'followed' },
        ]);
        const result = await getCommand().func(page, { 'user-id': validId });
        expect(result[0].status).toBe('followed');
        // Two trusted clicks: CTA + modal confirm.
        expect(page.click).toHaveBeenCalledTimes(2);
        expect(page.click.mock.calls[0][0]).toBe(`[data-opencli-target="${__test__.CTA_TAG}"]`);
        expect(page.click.mock.calls[1][0]).toBe(`[data-opencli-target="${__test__.MODAL_TAG}"]`);
    });

    it('returns already-following without trusted click or reload when 已关注 visible on entry', async () => {
        const page = makePage([
            profileUrl,
            { ok: true, state: 'already-following' },
        ]);
        const result = await getCommand().func(page, { 'user-id': validId });
        expect(result[0].status).toBe('already-following');
        expect(page.goto).toHaveBeenCalledTimes(1);
        expect(page.click).not.toHaveBeenCalled();
    });

    it('accepts a full profile URL with query and extracts the user id', async () => {
        const page = makePage([
            profileUrl,
            { ok: true, state: 'cta-tagged', diag: {} },
            [{ kind: 'click', isTrusted: true }],
            [],
            { ok: true, state: 'no_modal' },
            { ok: true, state: 'followed' },
        ]);
        await getCommand().func(page, { 'user-id': `${profileUrl}?xsec_token=abc` });
        expect(page.goto).toHaveBeenNthCalledWith(1, profileUrl);
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

    it('throws a clear network error on chrome-error://chromewebdata/', async () => {
        const page = makePage(['chrome-error://chromewebdata/']);
        await expect(getCommand().func(page, { 'user-id': validId }))
            .rejects.toThrowError(/browser could not load .* chrome-error.*network issue/);
        expect(page.click).not.toHaveBeenCalled();
    });

    it('throws with diagnostics when the locate step finds no CTA in scope', async () => {
        const page = makePage([
            profileUrl,
            { ok: false, state: 'failed',
              reason: 'Follow CTA not found in profile-header scope (logged out, blocked, private, or label list out of date).',
              diag: { url_after: profileUrl, scope_button_labels: ['消息', '设置'] } },
        ]);
        await expect(getCommand().func(page, { 'user-id': validId }))
            .rejects.toThrowError(/CTA not found .*scope_buttons=.*消息/);
        expect(page.click).not.toHaveBeenCalled();
    });

    it('throws risk_verification when xhs pops a captcha/identity modal after click', async () => {
        const page = makePage([
            profileUrl,
            { ok: true, state: 'cta-tagged', diag: {} },
            [{ kind: 'click', isTrusted: true }],
            [],
            { ok: false, state: 'risk_verification',
              reason: 'xhs returned a risk-verification modal (滑动验证) — needs manual action in the browser before retrying.',
              diag: { modal_state: 'risk', modal_text: '请完成滑动验证以继续操作', url_after: profileUrl } },
        ]);
        await expect(getCommand().func(page, { 'user-id': validId }))
            .rejects.toThrowError(/risk_verification.*滑动验证.*modal_state=risk.*modal_text/);
    });

    it('surfaces the antibot-blocked signature when click is trusted but no follow API request fires', async () => {
        const page = makePage([
            profileUrl,
            { ok: true, state: 'cta-tagged',
              diag: { clicked_button_html: '<button class="follow-button">关注</button>', scope_class: 'user-info' } },
            [{ kind: 'click', isTrusted: true }],                       // trusted click DID reach element
            [{ kind: 'click', isTrusted: true, clientX: 100, clientY: 200, targetHtml: 'follow' }],
            { ok: true, state: 'no_modal' },
            { ok: false, state: 'not-followed',
              reason: 'After reload, server still shows 关注 — trusted click delivered but server rejected the follow (rate-limited, abnormal-account flag, or target not followable from this account).',
              diag: { url_after: profileUrl, scope_button_labels: ['关注'] } },
        ], {
            getInterceptedRequests: vi.fn().mockResolvedValue([]),       // zero intercepted /api/sns calls
        });
        await expect(getCommand().func(page, { 'user-id': validId }))
            .rejects.toThrowError(/follow blocked.*no \/api\/sns follow request.*anti-automation/);
    });

    it('throws CommandExecutionError for malformed evaluate payloads at each boundary', async () => {
        const page1 = makePage([{ not: 'a string' }]);
        await expect(getCommand().func(page1, { 'user-id': validId }))
            .rejects.toThrowError(/malformed current-url payload/);

        const page2 = makePage([
            profileUrl,
            { ok: 'yes', state: 'cta-tagged' },
        ]);
        await expect(getCommand().func(page2, { 'user-id': validId }))
            .rejects.toThrowError(/malformed locate-action payload/);
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
        it('surfaces click, modal, candidate, intercept, and verify fields', () => {
            const s = __test__.formatDiagnostics({
                clicked_button_html: '<button class="follow">关注</button>',
                scope_class: 'user-info',
                modal_state: 'confirm-tagged',
                modal_button_labels: ['确认关注', '取消'],
                click_log: 'pointerdown(trusted=true),click(trusted=true)',
                doc_click_log: '4 events; first=pointerdown',
                candidates: [{ idx: 0, text: '关注', rect: { x: 990, y: 104, w: 96, h: 40 }, isOurTag: true }],
                intercepted_follow_count: 0,
                scope_button_labels: ['关注', '消息'],
                url_after: profileUrl,
            });
            expect(s).toMatch(/clicked_button_html=/);
            expect(s).toMatch(/scope=user-info/);
            expect(s).toMatch(/modal_state=confirm-tagged/);
            expect(s).toMatch(/click_log=pointerdown\(trusted=true\)/);
            expect(s).toMatch(/doc_click_log=4 events/);
            expect(s).toMatch(/candidates=.*ourTag/);
            expect(s).toMatch(/intercepted_follow_count=0/);
            expect(s).toMatch(/scope_buttons=/);
            expect(s).toMatch(/url_after=https:/);
        });
    });

    describe('__test__ scripts', () => {
        it('buildLocateCtaScript tags via data-opencli-target and registers diagnostic listeners', () => {
            const src = __test__.buildLocateCtaScript();
            expect(src).not.toMatch(/\$\{/);                              // no template-literal leaks
            expect(src).toMatch(/data-opencli-target/);
            expect(src).toMatch(__test__.CTA_TAG);
            expect(src).toMatch(/scrollIntoView/);
            expect(src).toMatch(/__opencli_click_log/);
            expect(src).toMatch(/__opencli_doc_click_log/);
            // Does NOT dispatch click itself — that's page.click's job now.
            expect(src).not.toMatch(/dispatchEvent\(new MouseEvent\('click'/);
        });
        it('buildLocateModalConfirmScript tags confirm + detects risk modals', () => {
            const src = __test__.buildLocateModalConfirmScript();
            expect(src).not.toMatch(/\$\{/);
            expect(src).toMatch(/data-opencli-target/);
            expect(src).toMatch(__test__.MODAL_TAG);
            expect(src).toMatch(/RISK_KEYWORDS/);
            expect(src).toMatch(/CONFIRM_LABELS/);
            expect(src).toMatch(/risk_verification/);
            expect(src).toMatch(/no_confirm/);
        });
    });
});
