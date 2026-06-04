import { describe, expect, it, vi } from 'vitest';
import { getRegistry } from '@jackwener/opencli/registry';
import { ArgumentError, AuthRequiredError, CommandExecutionError } from '@jackwener/opencli/errors';

import { __test__ } from './follow.js';

/**
 * Adapter flow (v5 — hover-preamble + CDP-trusted click + interceptor + captcha-detection):
 *   1. page.goto(url)                              [goto:initial]
 *   2. page.wait
 *   3. page.evaluate(location.href)                [eval:url-check]
 *      → throws on chrome-error / login / captcha schemes
 *   4. page.installInterceptor('/')                [intercept install — optional]
 *   5. page.evaluate(locateCtaScript)              [eval:locate]
 *      → returns 'already-following' (short-circuit) | 'cta-tagged' | 'failed'
 *   6. page.evaluate(CTA rect probe)               [eval:rect-probe]
 *      → returns {x, y, w, h}
 *   7. page.cdp(Input.dispatchMouseEvent ×N)       [cdp hover preamble + click]
 *      (only when state was 'cta-tagged')
 *   8. page.evaluate(click_log readback)           [eval:click-log]
 *   9. page.evaluate(doc_click_log readback)       [eval:doc-click-log]
 *  10. page.wait
 *  11. page.evaluate(locateModalScript)            [eval:modal]
 *      → 'no_modal' | 'confirm-tagged' | 'risk_verification' | 'no_confirm'
 *  12. page.click('[…modal-confirm]')              [click — only when confirm-tagged]
 *  13. page.wait (POST_CONFIRM_SETTLE_MS = 3s)
 *  14. page.getInterceptedRequests()               [intercept read — optional]
 *  15. page.goto(url) reload                       [goto:reload]
 *  16. page.wait
 *  17. page.evaluate(location.href)                [eval:verify-href]
 *      → throws if redirected to captcha
 *  18. page.evaluate(verifyScript)                 [eval:verify]
 *      → 'followed' | 'not-followed' | 'unknown'
 *
 * Fast paths skip later steps (already-following stops after eval:locate).
 */
function makePage(slots = {}, extra = {}) {
    // Build the eval sequence from named slots; missing slots are skipped.
    // Each slot key tracks one page.evaluate() call in the documented order.
    // Tests pass only the slots they need; non-relevant slots default to
    // sensible mocks that let the flow proceed past them.
    const sequence = [];
    const push = (key, value, defaultValue) => {
        if (key in slots) sequence.push(slots[key]);
        else if (defaultValue !== undefined) sequence.push(defaultValue);
    };
    push('urlCheck', slots.urlCheck, undefined);
    push('locate', slots.locate, undefined);
    push('rectProbe', slots.rectProbe, { x: 100, y: 200, w: 96, h: 40 });
    push('clickLog', slots.clickLog, []);
    push('docClickLog', slots.docClickLog, []);
    push('modal', slots.modal, { ok: true, state: 'no_modal' });
    push('verifyHref', slots.verifyHref, `https://www.xiaohongshu.com/user/profile/${validId}`);
    push('verify', slots.verify, undefined);

    const evaluate = vi.fn();
    for (const r of sequence) evaluate.mockResolvedValueOnce(r);
    evaluate.mockResolvedValue(undefined);
    return {
        goto: vi.fn().mockResolvedValue(undefined),
        wait: vi.fn().mockResolvedValue(undefined),
        evaluate,
        click: extra.click ?? vi.fn().mockResolvedValue({ matches_n: 1, match_level: 'exact' }),
        cdp: extra.cdp ?? vi.fn().mockResolvedValue(undefined),
        installInterceptor: extra.installInterceptor ?? vi.fn().mockResolvedValue(undefined),
        getInterceptedRequests: extra.getInterceptedRequests ?? vi.fn().mockResolvedValue([]),
    };
}

const validId = '5d8f88dc0000000001005d3a';
const profileUrl = `https://www.xiaohongshu.com/user/profile/${validId}`;

describe('xiaohongshu follow', () => {
    const getCommand = () => getRegistry().get('xiaohongshu/follow');

    it('returns followed on the no-modal happy path with hover-preamble CDP click + reload verify', async () => {
        const page = makePage({
            urlCheck: profileUrl,
            locate: { ok: true, state: 'cta-tagged',
                      diag: { clicked_button_html: '<button class="follow-button">关注</button>' } },
            clickLog: [{ kind: 'click', isTrusted: true }],
            docClickLog: [{ kind: 'click', isTrusted: true, clientX: 100, clientY: 200, targetHtml: '<button>关注</button>' }],
            modal: { ok: true, state: 'no_modal' },
            verify: { ok: true, state: 'followed' },
        });
        const result = await getCommand().func(page, { 'user-id': validId });
        expect(result).toEqual([{ status: 'followed', user_id: validId, url: profileUrl }]);
        expect(page.goto).toHaveBeenCalledTimes(2);                     // profile + reload
        // No page.click for CTA (we use cdp directly now); modal didn't fire.
        expect(page.click).not.toHaveBeenCalled();
        // CDP hover preamble: 5 moves + press + release = 7 dispatch calls.
        expect(page.cdp).toHaveBeenCalled();
        expect(page.cdp.mock.calls.length).toBeGreaterThanOrEqual(7);
        expect(page.installInterceptor).toHaveBeenCalledWith('/');
    });

    it('returns followed when a confirm modal appears and is dismissed via trusted click', async () => {
        const page = makePage({
            urlCheck: profileUrl,
            locate: { ok: true, state: 'cta-tagged', diag: {} },
            clickLog: [{ kind: 'click', isTrusted: true }],
            docClickLog: [{ kind: 'click', isTrusted: true }],
            modal: { ok: true, state: 'confirm-tagged',
                     diag: { modal_state: 'confirm-tagged', modal_button_labels: ['确认关注', '取消'] } },
            verify: { ok: true, state: 'followed' },
        });
        const result = await getCommand().func(page, { 'user-id': validId });
        expect(result[0].status).toBe('followed');
        // Modal confirm still uses page.click(); CTA uses cdp directly.
        expect(page.click).toHaveBeenCalledTimes(1);
        expect(page.click.mock.calls[0][0]).toBe(`[data-opencli-target="${__test__.MODAL_TAG}"]`);
    });

    it('returns already-following without click or reload when 已关注 visible on entry', async () => {
        const page = makePage({
            urlCheck: profileUrl,
            locate: { ok: true, state: 'already-following' },
        });
        const result = await getCommand().func(page, { 'user-id': validId });
        expect(result[0].status).toBe('already-following');
        expect(page.goto).toHaveBeenCalledTimes(1);
        expect(page.click).not.toHaveBeenCalled();
        expect(page.cdp).not.toHaveBeenCalled();
    });

    it('accepts a full profile URL with query and extracts the user id', async () => {
        const page = makePage({
            urlCheck: profileUrl,
            locate: { ok: true, state: 'cta-tagged', diag: {} },
            verify: { ok: true, state: 'followed' },
        });
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
        const page = makePage({
            urlCheck: 'https://www.xiaohongshu.com/login?redirectPath=/user/profile/' + validId,
        });
        await expect(getCommand().func(page, { 'user-id': validId })).rejects.toBeInstanceOf(AuthRequiredError);
    });

    it('throws a clear network error on chrome-error://chromewebdata/', async () => {
        const page = makePage({ urlCheck: 'chrome-error://chromewebdata/' });
        await expect(getCommand().func(page, { 'user-id': validId }))
            .rejects.toThrowError(/browser could not load .* chrome-error.*network issue/);
        expect(page.cdp).not.toHaveBeenCalled();
    });

    it('throws rate-limited when xhs redirects the initial nav to /website-login/captcha', async () => {
        const captchaUrl = `https://www.xiaohongshu.com/website-login/captcha?redirectPath=...&verifyType=124&verifyBiz=461&verifyMsg=null`;
        const page = makePage({ urlCheck: captchaUrl });
        await expect(getCommand().func(page, { 'user-id': validId }))
            .rejects.toThrowError(/rate-limited:.*verifyBiz=461.*Open https:\/\/www\.xiaohongshu\.com.*solve the captcha.*back off/);
        expect(page.cdp).not.toHaveBeenCalled();
    });

    it('throws rate-limited at verify when the post-click reload lands on captcha', async () => {
        const captchaUrl = `https://www.xiaohongshu.com/website-login/captcha?verifyBiz=461`;
        const page = makePage({
            urlCheck: profileUrl,
            locate: { ok: true, state: 'cta-tagged', diag: {} },
            clickLog: [{ kind: 'click', isTrusted: true }],
            docClickLog: [{ kind: 'click', isTrusted: true }],
            modal: { ok: true, state: 'no_modal' },
            verifyHref: captchaUrl,
            // verify slot intentionally omitted — should throw before reaching it.
        });
        await expect(getCommand().func(page, { 'user-id': validId }))
            .rejects.toThrowError(/rate-limited at verify.*captcha.*may have committed/);
    });

    it('throws with diagnostics when the locate step finds no CTA in scope', async () => {
        const page = makePage({
            urlCheck: profileUrl,
            locate: { ok: false, state: 'failed',
              reason: 'Follow CTA not found in profile-header scope (logged out, blocked, private, or label list out of date).',
              diag: { url_after: profileUrl, scope_button_labels: ['消息', '设置'] } },
        });
        await expect(getCommand().func(page, { 'user-id': validId }))
            .rejects.toThrowError(/CTA not found .*scope_buttons=.*消息/);
        expect(page.cdp).not.toHaveBeenCalled();
    });

    it('throws risk_verification when xhs pops a captcha/identity modal after click', async () => {
        const page = makePage({
            urlCheck: profileUrl,
            locate: { ok: true, state: 'cta-tagged', diag: {} },
            clickLog: [{ kind: 'click', isTrusted: true }],
            docClickLog: [],
            modal: { ok: false, state: 'risk_verification',
              reason: 'xhs returned a risk-verification modal (滑动验证) — needs manual action in the browser before retrying.',
              diag: { modal_state: 'risk', modal_text: '请完成滑动验证以继续操作', url_after: profileUrl } },
        });
        await expect(getCommand().func(page, { 'user-id': validId }))
            .rejects.toThrowError(/risk_verification.*滑动验证.*modal_state=risk.*modal_text/);
    });

    it('surfaces an unobserved-failure error when trusted click reached the CTA but no follow API request fires', async () => {
        const page = makePage({
            urlCheck: profileUrl,
            locate: { ok: true, state: 'cta-tagged',
              diag: { clicked_button_html: '<button class="follow-button">关注</button>', scope_class: 'user-info' } },
            clickLog: [{ kind: 'click', isTrusted: true }],              // doc-level trusted click observed
            docClickLog: [{ kind: 'click', isTrusted: true, clientX: 100, clientY: 200, targetHtml: 'follow' }],
            modal: { ok: true, state: 'no_modal' },
            verify: { ok: false, state: 'not-followed',
              reason: 'After reload, server still shows 关注 — trusted click delivered but server rejected the follow (rate-limited, abnormal-account flag, or target not followable from this account).',
              diag: { url_after: profileUrl, scope_button_labels: ['关注'] } },
        }, {
            getInterceptedRequests: vi.fn().mockResolvedValue([]),       // zero intercepted /api/sns calls
        });
        await expect(getCommand().func(page, { 'user-id': validId }))
            .rejects.toThrowError(/unobserved-failure.*zero follow API requests.*file a bug.*github\.com/);
    });

    it('throws CommandExecutionError for malformed evaluate payloads at each boundary', async () => {
        const page1 = makePage({ urlCheck: { not: 'a string' } });
        await expect(page1 && getCommand().func(page1, { 'user-id': validId }))
            .rejects.toThrowError(/malformed current-url payload/);

        const page2 = makePage({
            urlCheck: profileUrl,
            locate: { ok: 'yes', state: 'cta-tagged' },                  // ok not boolean
        });
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
