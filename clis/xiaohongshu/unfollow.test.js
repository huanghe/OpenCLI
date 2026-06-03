import { describe, expect, it, vi } from 'vitest';
import { getRegistry } from '@jackwener/opencli/registry';
import { ArgumentError, AuthRequiredError, CommandExecutionError } from '@jackwener/opencli/errors';

import { __test__ } from './unfollow.js';

const validId = '5d8f88dc0000000001005d3a';
const profileUrl = `https://www.xiaohongshu.com/user/profile/${validId}`;

/**
 * Adapter flow mirror of follow.js (v5):
 *   1. goto + wait
 *   2. evaluate(location.href) → urlCheck
 *   3. installInterceptor('/')
 *   4. evaluate(locateUnfollowCtaScript) → locate
 *   5. evaluate(rect-probe) → rectProbe
 *   6. cdp(mouseMoved ×N) + cdp(mousePressed) + cdp(mouseReleased)
 *   7. evaluate(click_log) → clickLog
 *   8. evaluate(doc_click_log) → docClickLog
 *   9. wait + evaluate(locateModalConfirmScript) → modal
 *  10. page.click('[…modal-confirm]')
 *  11. wait + getInterceptedRequests
 *  12. goto reload + wait
 *  13. evaluate(location.href) → verifyHref
 *  14. evaluate(verifyUnfollowScript) → verify
 */
function makePage(slots = {}, extra = {}) {
    const sequence = [];
    const push = (key, defaultValue) => {
        if (key in slots) sequence.push(slots[key]);
        else if (defaultValue !== undefined) sequence.push(defaultValue);
    };
    push('urlCheck');
    push('locate');
    push('rectProbe', { x: 100, y: 200, w: 96, h: 40 });
    push('clickLog', []);
    push('docClickLog', []);
    push('modal', { ok: true, state: 'confirm-tagged', diag: { modal_state: 'confirm-tagged', modal_button_labels: ['不再关注', '取消'] } });
    push('verifyHref', profileUrl);
    push('verify');

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

describe('xiaohongshu unfollow', () => {
    const getCommand = () => getRegistry().get('xiaohongshu/unfollow');

    it('returns unfollowed on the happy path: locate → CDP click → modal confirm → reload → verify', async () => {
        const page = makePage({
            urlCheck: profileUrl,
            locate: { ok: true, state: 'cta-tagged', diag: { clicked_button_html: '<button>已关注</button>' } },
            clickLog: [{ kind: 'click', isTrusted: true }],
            docClickLog: [{ kind: 'click', isTrusted: true }],
            verify: { ok: true, state: 'unfollowed' },
        });
        const result = await getCommand().func(page, { 'user-id': validId });
        expect(result).toEqual([{ status: 'unfollowed', user_id: validId, url: profileUrl }]);
        expect(page.goto).toHaveBeenCalledTimes(2);
        // CDP-driven CTA click (5 moves + press + release = 7) — page.click only for modal.
        expect(page.cdp).toHaveBeenCalled();
        expect(page.cdp.mock.calls.length).toBeGreaterThanOrEqual(7);
        expect(page.click).toHaveBeenCalledTimes(1);
        expect(page.click.mock.calls[0][0]).toBe(`[data-opencli-target="${__test__.MODAL_TAG}"]`);
        expect(page.installInterceptor).toHaveBeenCalledWith('/');
    });

    it('returns not-following fast path when 关注 is already showing on entry', async () => {
        const page = makePage({
            urlCheck: profileUrl,
            locate: { ok: true, state: 'not-following' },
        });
        const result = await getCommand().func(page, { 'user-id': validId });
        expect(result[0].status).toBe('not-following');
        expect(page.cdp).not.toHaveBeenCalled();
        expect(page.click).not.toHaveBeenCalled();
        expect(page.goto).toHaveBeenCalledTimes(1);
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

    it('throws rate-limited when xhs redirects the initial nav to /website-login/captcha', async () => {
        const captchaUrl = `https://www.xiaohongshu.com/website-login/captcha?verifyType=124&verifyBiz=461`;
        const page = makePage({ urlCheck: captchaUrl });
        await expect(getCommand().func(page, { 'user-id': validId }))
            .rejects.toThrowError(/rate-limited:.*verifyBiz=461.*solve the captcha.*back off/);
        expect(page.cdp).not.toHaveBeenCalled();
    });

    it('throws a clear network error on chrome-error://chromewebdata/', async () => {
        const page = makePage({ urlCheck: 'chrome-error://chromewebdata/' });
        await expect(getCommand().func(page, { 'user-id': validId }))
            .rejects.toThrowError(/browser could not load .* chrome-error/);
    });

    it('throws still-following when the post-reload server still shows 已关注', async () => {
        const page = makePage({
            urlCheck: profileUrl,
            locate: { ok: true, state: 'cta-tagged', diag: {} },
            clickLog: [{ kind: 'click', isTrusted: true }],
            docClickLog: [],
            modal: { ok: true, state: 'confirm-tagged',
                     diag: { modal_state: 'confirm-tagged', modal_button_labels: ['不再关注'] } },
            verify: { ok: false, state: 'still-following',
              reason: 'After reload, server still shows 已关注 — unfollow confirm-modal click did not commit.',
              diag: { url_after: profileUrl, scope_button_labels: ['已关注'] } },
        });
        await expect(getCommand().func(page, { 'user-id': validId }))
            .rejects.toThrowError(/still-following.*scope_buttons=.*已关注/);
    });

    it('throws no_confirm when the modal label list does not match xhs copy', async () => {
        const page = makePage({
            urlCheck: profileUrl,
            locate: { ok: true, state: 'cta-tagged', diag: {} },
            clickLog: [{ kind: 'click', isTrusted: true }],
            docClickLog: [],
            modal: { ok: false, state: 'no_confirm',
              reason: 'xhs unfollow-confirmation modal appeared, but no recognized confirm button was found. Add to CONFIRM_LABELS in unfollow.js.',
              diag: { modal_state: 'unknown_buttons',
                      modal_text: '确定要取消关注吗?',
                      modal_button_labels: ['某新文案', '取消'] } },
        });
        await expect(getCommand().func(page, { 'user-id': validId }))
            .rejects.toThrowError(/no_confirm.*modal_buttons=\["某新文案","取消"\]/);
    });

    describe('__test__.assertUserId', () => {
        it('normalizes raw user ids and URL forms', () => {
            expect(__test__.assertUserId(validId)).toBe(validId);
            expect(__test__.assertUserId(profileUrl)).toBe(validId);
            expect(__test__.assertUserId(`${profileUrl}?xsec_token=t`)).toBe(validId);
        });
        it('rejects too-short or non-alphanumeric ids', () => {
            expect(() => __test__.assertUserId('')).toThrow(ArgumentError);
            expect(() => __test__.assertUserId('!!!')).toThrow(ArgumentError);
        });
    });

    describe('__test__ scripts', () => {
        it('buildLocateUnfollowCtaScript tags via data-opencli-target and finds 已关注 not 关注', () => {
            const src = __test__.buildLocateUnfollowCtaScript();
            expect(src).not.toMatch(/\$\{/);
            expect(src).toMatch(/data-opencli-target/);
            expect(src).toMatch(__test__.CTA_TAG);
            expect(src).toMatch(/FOLLOWING_LABELS/);
            expect(src).toMatch(/已关注/);
            expect(src).toMatch(/__opencli_doc_click_log/);
        });
        it('buildLocateModalConfirmScript uses unfollow-confirm labels and detects risk modals', () => {
            const src = __test__.buildLocateModalConfirmScript();
            expect(src).not.toMatch(/\$\{/);
            expect(src).toMatch(/data-opencli-target/);
            expect(src).toMatch(__test__.MODAL_TAG);
            // Unfollow-specific confirm labels:
            expect(src).toMatch(/不再关注/);
            // Cancel labels include unfollow-specific 保持关注 / 再想想:
            expect(src).toMatch(/保持关注/);
            expect(src).toMatch(/RISK_KEYWORDS/);
        });
    });
});
