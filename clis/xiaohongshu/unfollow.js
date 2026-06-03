/**
 * Xiaohongshu unfollow — locate the 已关注 CTA, deliver a CDP-trusted click
 * with hover preamble, dismiss the resulting "取消关注" confirmation modal,
 * then reload the profile and verify the relation flipped back to 关注 on
 * the server.
 *
 * Full v5 treatment matching follow.js (see that file's header for the
 * detailed evolution). Same rationale applies:
 *
 *   • Native `.click()` is not enough — xhs's Vue handler arms after
 *     hover transitions in some cases, and page.evaluate-dispatched
 *     synthetic events have isTrusted=false which any anti-bot layer
 *     can gate on. We drive CDP `Input.dispatchMouseEvent` directly,
 *     with a 5-step mouseMoved path from (40,40) → button → press →
 *     release, mimicking a real cursor.
 *
 *   • DOM-flip polling is unreliable as a "server committed" signal.
 *     After dismissing the confirm modal we reload the profile URL so
 *     xhs refetches relation state from the server through its own
 *     signed request, and read the button label from that fresh render.
 *
 *   • xhs's frequent-operation challenge redirects to
 *     /website-login/captcha?…&verifyBiz=461 — both upfront and after
 *     the post-click reload. Detect explicitly so the caller gets a
 *     "rate-limited, solve captcha, back off ≥30s" message instead of
 *     a misleading "selectors changed" surface.
 *
 *   • Network interceptor on '/' captures every fetch/XHR. Surfaces in
 *     diagnostics so an unexpected failure mode is debuggable in one
 *     read.
 *
 * Flow:
 *   1. Navigate to https://www.xiaohongshu.com/user/profile/<userId>
 *   2. URL check (chrome-error, captcha redirect, /login bounce)
 *   3. Install capture-all interceptor
 *   4. Locate-and-tag 已关注 CTA. Fast-path: if 关注 is showing on entry,
 *      return 'not-following' (idempotent).
 *   5. Hover preamble + CDP click via page.cdp(Input.dispatchMouseEvent).
 *   6. Confirm modal: locate the 确定 / 不再关注 / 取消关注 button via
 *      page.evaluate, trusted-click it via page.click().
 *   7. Pull intercepted requests BEFORE reload (installInterceptor's
 *      patches don't survive navigation).
 *   8. Reload + URL check (captcha redirect could happen here too).
 *   9. Read fresh button state — 关注 visible → unfollowed; 已关注 still
 *      visible → still-following; otherwise unknown.
 *
 * Requires: logged into www.xiaohongshu.com in Chrome.
 */
import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError, AuthRequiredError, CliError, CommandExecutionError } from '@jackwener/opencli/errors';
import { normalizeXhsUserId } from './user-helpers.js';

const PROFILE_SETTLE_MS = 2500;
const MODAL_MOUNT_SETTLE_MS = 1500;
const POST_CONFIRM_SETTLE_MS = 3000;
const RELOAD_SETTLE_MS = 2500;
const USER_ID_RE = /^[a-zA-Z0-9]{8,32}$/;

const CTA_TAG = 'xhs-unfollow-cta';
const MODAL_TAG = 'xhs-unfollow-modal-confirm';

function unwrapEvaluateResult(payload) {
    if (payload && typeof payload === 'object' && 'session' in payload && 'data' in payload) {
        return payload.data;
    }
    return payload;
}

function requireActionResult(payload, context) {
    const inner = unwrapEvaluateResult(payload);
    if (!inner || typeof inner !== 'object' || Array.isArray(inner) || typeof inner.ok !== 'boolean') {
        throw new CommandExecutionError(`xiaohongshu/unfollow: malformed ${context} payload`);
    }
    return inner;
}

function assertUserId(raw) {
    const userId = normalizeXhsUserId(raw);
    if (!userId || !USER_ID_RE.test(userId)) {
        throw new ArgumentError(
            'xiaohongshu/unfollow: user-id must be a Xiaohongshu user ID (e.g. 5d8f88dc0000000001005d3a) or full profile URL',
        );
    }
    return userId;
}

function formatDiagnostics(diag) {
    if (!diag || typeof diag !== 'object') return '';
    const parts = [];
    if (diag.clicked_button_html) {
        parts.push(`clicked_button_html=${JSON.stringify(diag.clicked_button_html)}`);
    }
    if (diag.scope_class) parts.push(`scope=${diag.scope_class}`);
    if (diag.modal_state) parts.push(`modal_state=${diag.modal_state}`);
    if (Array.isArray(diag.modal_button_labels) && diag.modal_button_labels.length > 0) {
        parts.push(`modal_buttons=${JSON.stringify(diag.modal_button_labels.slice(0, 8))}`);
    }
    if (diag.modal_text) {
        parts.push(`modal_text=${JSON.stringify(String(diag.modal_text).slice(0, 200))}`);
    }
    if (diag.click_log) parts.push(`click_log=${diag.click_log}`);
    if (diag.doc_click_log) parts.push(`doc_click_log=${diag.doc_click_log}`);
    if (diag.click_dispatch_error) parts.push(`click_dispatch_error=${JSON.stringify(diag.click_dispatch_error)}`);
    if (Array.isArray(diag.scope_button_labels) && diag.scope_button_labels.length > 0) {
        parts.push(`scope_buttons=${JSON.stringify(diag.scope_button_labels.slice(0, 12))}`);
    }
    if (typeof diag.intercepted_count === 'number') {
        parts.push(`intercepted_count=${diag.intercepted_count}`);
    }
    if (diag.interceptor_status) parts.push(`interceptor_status=${JSON.stringify(diag.interceptor_status)}`);
    if (diag.url_after) parts.push(`url_after=${diag.url_after}`);
    return parts.length ? ` [${parts.join('; ')}]` : '';
}

/**
 * Page-context locate-and-tag for the 已关注 CTA. Does NOT click — the actual
 * click is sent via CDP from JS land. Also wires up element-level and
 * document-level click listeners for diagnostics.
 *
 * Returns `{ ok, state, reason?, diag? }`:
 *   ok: true,  state: 'not-following'      → 关注 visible (no-op fast path)
 *   ok: true,  state: 'cta-tagged'         → caller drives the click via CDP
 *   ok: false, state: 'failed'             → reason + diag
 */
function buildLocateUnfollowCtaScript() {
    return `
(() => {
  const TAG_ATTR = 'data-opencli-target';
  const TAG_VALUE = '${CTA_TAG}';
  const FOLLOW_LABELS = ['关注', '+ 关注', '+关注'];
  const FOLLOWING_LABELS = ['已关注', '已互关', '互相关注'];

  const isVisible = (el) => {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    return true;
  };
  const textOf = (el) => (el.innerText || el.textContent || '').trim();

  for (const el of document.querySelectorAll('[' + TAG_ATTR + ']')) {
    el.removeAttribute(TAG_ATTR);
  }

  const SCOPE_SELECTORS = [
    '.user-info', '.profile-info', '.user-detail', '.profile-page',
    '[class*="user-info"]', '[class*="profile"]',
  ];
  const scopes = SCOPE_SELECTORS
    .flatMap((sel) => Array.from(document.querySelectorAll(sel)))
    .filter(isVisible);
  if (scopes.length === 0) {
    return {
      ok: false, state: 'failed',
      reason: 'No profile-header scope found on page — xhs layout may have changed; update SCOPE_SELECTORS in unfollow.js.',
      diag: { url_after: location.href },
    };
  }

  const collectButtons = () => {
    const out = new Set();
    for (const root of scopes) {
      for (const el of root.querySelectorAll('button, [role="button"]')) {
        if (isVisible(el)) out.add(el);
      }
    }
    return Array.from(out);
  };
  const findButtonByLabels = (labels) => {
    for (const btn of collectButtons()) {
      if (labels.includes(textOf(btn))) return btn;
    }
    return null;
  };
  const findCtaByClass = () => {
    for (const root of scopes) {
      for (const el of root.querySelectorAll('button.follow-button, button[class*="follow-button"]')) {
        if (isVisible(el)) return el;
      }
    }
    return null;
  };
  const scopeButtonLabels = () => collectButtons().map(textOf).filter(Boolean);
  const closestScopeClass = (el) => {
    for (const root of scopes) {
      if (root.contains(el)) {
        return (root.className && String(root.className).slice(0, 80)) || root.tagName;
      }
    }
    return '(unscoped)';
  };

  // Idempotent fast path: viewer is not following the target.
  if (findButtonByLabels(FOLLOW_LABELS)) {
    return { ok: true, state: 'not-following' };
  }

  // Find the 已关注 CTA. Class-match preferred (handles span-wrapped label),
  // label fallback otherwise.
  let cta = findCtaByClass();
  if (cta) {
    const t = textOf(cta);
    if (FOLLOW_LABELS.includes(t)) return { ok: true, state: 'not-following' };
    if (!FOLLOWING_LABELS.includes(t) && t !== '') cta = null;
  }
  if (!cta) cta = findButtonByLabels(FOLLOWING_LABELS);
  if (!cta) {
    return {
      ok: false, state: 'failed',
      reason: 'Follow-state CTA (已关注 / 已互关) not found in profile-header scope.',
      diag: {
        url_after: location.href,
        scope_button_labels: scopeButtonLabels(),
      },
    };
  }

  cta.setAttribute(TAG_ATTR, TAG_VALUE);
  try { cta.scrollIntoView({ block: 'center', behavior: 'instant' }); } catch (_) {
    try { cta.scrollIntoView(); } catch (_) {}
  }

  // Diagnostic click listeners (both element-level and document-level).
  try { delete window.__opencli_click_log; } catch (_) {}
  Object.defineProperty(window, '__opencli_click_log', {
    value: [], writable: true, enumerable: false, configurable: true,
  });
  try { delete window.__opencli_doc_click_log; } catch (_) {}
  Object.defineProperty(window, '__opencli_doc_click_log', {
    value: [], writable: true, enumerable: false, configurable: true,
  });
  const _logEvent = (kind, sink) => (e) => {
    try {
      window[sink].push({
        kind, isTrusted: e.isTrusted,
        clientX: e.clientX, clientY: e.clientY,
        targetHtml: (e.target && e.target.outerHTML ? e.target.outerHTML.slice(0, 120) : ''),
      });
    } catch (_) {}
  };
  for (const evt of ['pointerdown', 'mousedown', 'mouseup', 'click']) {
    cta.addEventListener(evt, _logEvent(evt, '__opencli_click_log'), { capture: true });
    document.addEventListener(evt, _logEvent(evt, '__opencli_doc_click_log'), { capture: true });
  }

  return {
    ok: true, state: 'cta-tagged',
    diag: {
      clicked_button_html: (cta.outerHTML || '').slice(0, 240),
      scope_class: closestScopeClass(cta),
      url_after: location.href,
    },
  };
})()
`;
}

/**
 * Page-context locate-and-tag for the confirm modal's button. Same modal
 * lookup as follow.js but the label list reflects unfollow copy
 * (确定 / 不再关注 / 取消关注 are the "yes, unfollow" labels here).
 *
 * Returns `{ ok, state, reason?, diag? }`:
 *   ok: true,  state: 'confirm-tagged'     → caller drives the click
 *   ok: false, state: 'no_modal'           → modal never appeared
 *   ok: false, state: 'no_confirm'         → modal up, no recognized button
 *   ok: false, state: 'risk_verification'  → captcha / 实名 / scan modal
 */
function buildLocateModalConfirmScript() {
    return `
(() => {
  const TAG_ATTR = 'data-opencli-target';
  const TAG_VALUE = '${MODAL_TAG}';

  const isVisible = (el) => {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    return true;
  };
  const textOf = (el) => (el.innerText || el.textContent || '').trim();

  for (const el of document.querySelectorAll('[' + TAG_ATTR + '="' + TAG_VALUE + '"]')) {
    el.removeAttribute(TAG_ATTR);
  }

  // d-modal-footer is the dialog's footer container xhs uses for confirms
  // (same widget as delete-note). Broader fallback selectors first.
  const MODAL_SELECTORS = [
    '.d-modal-footer', '[role="dialog"]', '.modal', '[class*="modal"]', '[class*="Modal"]',
    '.d-modal', '.d-modal-content', '.d-dialog', '.reds-modal', '[class*="reds-modal"]',
  ];
  const modalRoots = MODAL_SELECTORS
    .flatMap((sel) => Array.from(document.querySelectorAll(sel)))
    .filter(isVisible);
  // .d-modal-footer is the most-specific xhs unfollow confirm — prefer it
  // when present; otherwise pick the largest visible matched element.
  let modal = modalRoots.find((el) => el.matches('.d-modal-footer'));
  if (!modal) {
    modalRoots.sort((a, b) => {
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      return (rb.width * rb.height) - (ra.width * ra.height);
    });
    modal = modalRoots[0];
  }
  if (!modal) {
    return {
      ok: false, state: 'no_modal',
      reason: 'Confirm modal did not appear after 已关注 click — click likely missed the handler.',
      diag: { url_after: location.href },
    };
  }

  const modalText = textOf(modal).slice(0, 300);

  const RISK_KEYWORDS = ['验证码', '滑动验证', '安全验证', '扫码', '实名认证', '风险', '人机验证', '请验证'];
  for (const kw of RISK_KEYWORDS) {
    if (modalText.includes(kw)) {
      return {
        ok: false, state: 'risk_verification',
        reason: 'xhs returned a risk-verification modal (' + kw + ') — needs manual action in the browser before retrying.',
        diag: { modal_state: 'risk', modal_text: modalText, url_after: location.href },
      };
    }
  }

  // Unfollow confirm labels — different from follow's confirm labels. xhs
  // uses 「不再关注」or 「确定」for the affirmative button.
  const CONFIRM_LABELS = ['不再关注', '取消关注', '确定', '确认', '继续'];
  const CANCEL_LABELS = ['取消', '关闭', '再想想', '保持关注', 'Cancel'];

  const buttons = Array.from(modal.querySelectorAll('button, [role="button"], .reds-button-new'))
    .filter(isVisible);
  const buttonLabels = buttons.map(textOf);

  let confirmBtn = null;
  for (const label of CONFIRM_LABELS) {
    const hit = buttons.find((b) => textOf(b) === label);
    if (hit) { confirmBtn = hit; break; }
  }
  if (!confirmBtn && buttons.length === 1) {
    const t = textOf(buttons[0]);
    if (!CANCEL_LABELS.includes(t)) confirmBtn = buttons[0];
  }
  if (!confirmBtn) {
    return {
      ok: false, state: 'no_confirm',
      reason: 'xhs unfollow-confirmation modal appeared, but no recognized confirm button was found. Add to CONFIRM_LABELS in unfollow.js.',
      diag: {
        modal_state: 'unknown_buttons',
        modal_text: modalText,
        modal_button_labels: buttonLabels,
        url_after: location.href,
      },
    };
  }

  confirmBtn.setAttribute(TAG_ATTR, TAG_VALUE);

  return {
    ok: true, state: 'confirm-tagged',
    diag: {
      modal_state: 'confirm-tagged',
      modal_button_labels: buttonLabels,
      clicked_button_html: (confirmBtn.outerHTML || '').slice(0, 200),
    },
  };
})()
`;
}

/**
 * Page-context verify script, run AFTER a reload of the profile URL. Reads
 * the post-reload button state from the freshly server-rendered page —
 * authoritative for "did unfollow take effect".
 *
 * Returns `{ ok, state, reason?, diag? }`:
 *   ok: true,  state: 'unfollowed'         → server confirms 关注 (relation cleared)
 *   ok: false, state: 'still-following'    → 已关注 still visible
 *   ok: false, state: 'unknown'            → scope/button missing
 */
function buildVerifyUnfollowScript() {
    return `
(() => {
  const FOLLOW_LABELS = ['关注', '+ 关注', '+关注'];
  const FOLLOWING_LABELS = ['已关注', '已互关', '互相关注'];

  const isVisible = (el) => {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    return true;
  };
  const textOf = (el) => (el.innerText || el.textContent || '').trim();

  const SCOPE_SELECTORS = [
    '.user-info', '.profile-info', '.user-detail', '.profile-page',
    '[class*="user-info"]', '[class*="profile"]',
  ];
  const scopes = SCOPE_SELECTORS
    .flatMap((sel) => Array.from(document.querySelectorAll(sel)))
    .filter(isVisible);
  if (scopes.length === 0) {
    return {
      ok: false, state: 'unknown',
      reason: 'Post-reload: no profile-header scope on page.',
      diag: { url_after: location.href },
    };
  }

  const buttons = [];
  for (const root of scopes) {
    for (const el of root.querySelectorAll('button, [role="button"]')) {
      if (isVisible(el)) buttons.push(el);
    }
  }
  const labels = buttons.map(textOf).filter(Boolean);

  if (buttons.some((b) => FOLLOW_LABELS.includes(textOf(b)))) {
    return { ok: true, state: 'unfollowed' };
  }
  if (buttons.some((b) => FOLLOWING_LABELS.includes(textOf(b)))) {
    return {
      ok: false, state: 'still-following',
      reason: 'After reload, server still shows 已关注 — unfollow confirm-modal click did not commit.',
      diag: { url_after: location.href, scope_button_labels: labels },
    };
  }
  return {
    ok: false, state: 'unknown',
    reason: 'After reload, neither 关注 nor 已关注 button visible.',
    diag: { url_after: location.href, scope_button_labels: labels },
  };
})()
`;
}

cli({
    site: 'xiaohongshu',
    name: 'unfollow',
    access: 'write',
    description: '取消关注小红书用户 (CDP-trusted click + modal-handling + reload-verify)',
    domain: 'www.xiaohongshu.com',
    strategy: Strategy.COOKIE,
    navigateBefore: false,
    browser: true,
    args: [
        {
            name: 'user-id',
            required: true,
            positional: true,
            help: 'User ID (e.g. 5d8f88dc0000000001005d3a) or profile URL',
        },
    ],
    columns: ['status', 'user_id', 'url'],
    func: async (page, kwargs) => {
        if (!page) {
            throw new CommandExecutionError('Browser session required for xiaohongshu unfollow');
        }
        try {
            const userId = assertUserId(kwargs['user-id']);
            const url = `https://www.xiaohongshu.com/user/profile/${userId}`;
            await page.goto(url);
            await page.wait({ time: PROFILE_SETTLE_MS / 1000 });

            const hrefRaw = unwrapEvaluateResult(await page.evaluate('() => location.href'));
            if (typeof hrefRaw !== 'string') {
                throw new CommandExecutionError('xiaohongshu/unfollow: malformed current-url payload');
            }
            if (/^(chrome-error|about|data):/i.test(hrefRaw)) {
                throw new CommandExecutionError(
                    `xiaohongshu/unfollow: browser could not load ${url} — got ${hrefRaw} (network issue, TLS intercept proxy, or DNS failure)`,
                );
            }
            const parsedHref = new URL(hrefRaw);
            if (/\/website-login\/captcha(?:[/?#]|$)/i.test(parsedHref.pathname)) {
                const verifyBiz = parsedHref.searchParams.get('verifyBiz') || '?';
                throw new CommandExecutionError(
                    `xiaohongshu/unfollow rate-limited: xhs redirected to captcha verification (verifyBiz=${verifyBiz}). ` +
                    `Open https://www.xiaohongshu.com in your normal browser, solve the captcha that appears, then back off subsequent unfollows by ≥30s. UID ${userId}.`,
                );
            }
            if (/\/login(?:[/?#]|$)/i.test(parsedHref.pathname)) {
                throw new AuthRequiredError('www.xiaohongshu.com');
            }

            // Capture-all interceptor for diagnostics.
            let interceptorReady = false;
            let interceptorInstallError = null;
            try {
                await page.installInterceptor('/');
                interceptorReady = true;
            } catch (err) {
                interceptorInstallError = String(err?.message ?? err);
            }

            // Step 1: locate + tag 已关注 CTA.
            const locateResult = requireActionResult(
                await page.evaluate(buildLocateUnfollowCtaScript()),
                'locate-action',
            );
            if (!locateResult.ok) {
                throw new CommandExecutionError(
                    `xiaohongshu/unfollow failed: ${locateResult.reason ?? 'unknown locate failure'}${formatDiagnostics(locateResult.diag)}`,
                );
            }
            if (locateResult.state === 'not-following') {
                return [{ status: 'not-following', user_id: userId, url }];
            }

            // Step 2: hover preamble + CDP-trusted click on 已关注.
            let clickDispatchError = null;
            try {
                const rectRaw = unwrapEvaluateResult(await page.evaluate(`
                    () => {
                      const el = document.querySelector('[data-opencli-target="${CTA_TAG}"]');
                      if (!el) return null;
                      try { el.scrollIntoView({ block: 'center', behavior: 'instant' }); } catch (_) {}
                      const r = el.getBoundingClientRect();
                      return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
                    }
                `));
                if (!rectRaw || typeof rectRaw !== 'object') {
                    throw new Error('CTA rect probe returned null — element vanished between tag and click');
                }
                const cx = Math.round(rectRaw.x);
                const cy = Math.round(rectRaw.y);

                if (typeof page.cdp === 'function') {
                    const startX = 40, startY = 40;
                    const steps = 5;
                    for (let i = 1; i <= steps; i++) {
                        const t = i / steps;
                        const px = Math.round(startX + (cx - startX) * t);
                        const py = Math.round(startY + (cy - startY) * t);
                        await page.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: px, y: py });
                        await new Promise((r) => setTimeout(r, 40));
                    }
                    await new Promise((r) => setTimeout(r, 150));
                    await page.cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: cx, y: cy, button: 'left', clickCount: 1 });
                    await new Promise((r) => setTimeout(r, 35));
                    await page.cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cx, y: cy, button: 'left', clickCount: 1 });
                } else {
                    await page.click(`[data-opencli-target="${CTA_TAG}"]`);
                }
            } catch (err) {
                clickDispatchError = String(err?.message ?? err);
            }

            // Pull click logs.
            let clickLog = [];
            let docClickLog = [];
            try {
                const rawLog = unwrapEvaluateResult(await page.evaluate('() => window.__opencli_click_log || []'));
                if (Array.isArray(rawLog)) clickLog = rawLog;
                const rawDoc = unwrapEvaluateResult(await page.evaluate('() => window.__opencli_doc_click_log || []'));
                if (Array.isArray(rawDoc)) docClickLog = rawDoc;
            } catch (_) {}
            const clickLogSummary = clickLog.length === 0
                ? 'no-events-on-cta'
                : clickLog.map((e) => `${e.kind}(trusted=${e.isTrusted})`).join(',');
            const docClickLogSummary = docClickLog.length === 0
                ? 'no-events-anywhere'
                : `${docClickLog.length} events; first=${docClickLog[0]?.kind}@(${docClickLog[0]?.clientX},${docClickLog[0]?.clientY}) trusted=${docClickLog[0]?.isTrusted}`;

            if (clickDispatchError) {
                throw new CommandExecutionError(
                    `xiaohongshu/unfollow: trusted CTA click failed: ${clickDispatchError}${formatDiagnostics({ ...locateResult.diag, click_dispatch_error: clickDispatchError, click_log: clickLogSummary, doc_click_log: docClickLogSummary })}`,
                );
            }

            // Step 3: locate + tag the modal confirm button.
            await page.wait({ time: MODAL_MOUNT_SETTLE_MS / 1000 });
            const modalResult = requireActionResult(
                await page.evaluate(buildLocateModalConfirmScript()),
                'modal-action',
            );
            if (!modalResult.ok) {
                const merged = { ...(locateResult.diag ?? {}), ...(modalResult.diag ?? {}), click_log: clickLogSummary, doc_click_log: docClickLogSummary };
                throw new CommandExecutionError(
                    `xiaohongshu/unfollow ${modalResult.state}: ${modalResult.reason ?? 'modal step failed'}${formatDiagnostics(merged)}`,
                );
            }

            // Step 4: trusted click on confirm button.
            try {
                await page.click(`[data-opencli-target="${MODAL_TAG}"]`);
            } catch (err) {
                const merged = {
                    ...(locateResult.diag ?? {}),
                    ...(modalResult.diag ?? {}),
                    click_dispatch_error: String(err?.message ?? err),
                    click_log: clickLogSummary,
                    doc_click_log: docClickLogSummary,
                };
                throw new CommandExecutionError(
                    `xiaohongshu/unfollow: trusted modal-confirm click failed: ${err?.message ?? String(err)}${formatDiagnostics(merged)}`,
                );
            }

            // Step 5: pull intercepted requests BEFORE reload (installInterceptor
            // patches don't survive a navigation).
            await page.wait({ time: POST_CONFIRM_SETTLE_MS / 1000 });
            let allIntercepted = [];
            if (interceptorReady) {
                try {
                    const raw = await page.getInterceptedRequests();
                    allIntercepted = Array.isArray(raw) ? raw : [];
                } catch (_) {}
            }
            const interceptDiag = {
                intercepted_count: allIntercepted.length,
                interceptor_status: interceptorReady
                    ? `ready (captured ${allIntercepted.length} total)`
                    : `install-failed: ${interceptorInstallError ?? 'unknown'}`,
            };

            // Step 6: reload + verify against fresh server state.
            await page.goto(url);
            await page.wait({ time: RELOAD_SETTLE_MS / 1000 });

            // Reload may also land on the captcha challenge.
            const verifyHrefRaw = unwrapEvaluateResult(await page.evaluate('() => location.href'));
            if (typeof verifyHrefRaw === 'string'
                && /\/website-login\/captcha(?:[/?#]|$)/i.test(new URL(verifyHrefRaw).pathname || '')) {
                throw new CommandExecutionError(
                    `xiaohongshu/unfollow rate-limited at verify: xhs redirected the post-click reload to captcha. ` +
                    `The unfollow click may have committed server-side — re-check this UID after solving the captcha in your browser. UID ${userId}.`,
                );
            }

            const verifyResult = requireActionResult(
                await page.evaluate(buildVerifyUnfollowScript()),
                'verify-action',
            );
            if (!verifyResult.ok) {
                const mergedDiag = {
                    ...(locateResult.diag ?? {}),
                    ...(modalResult.diag ?? {}),
                    ...interceptDiag,
                    click_log: clickLogSummary,
                    doc_click_log: docClickLogSummary,
                    ...(verifyResult.diag ?? {}),
                };
                throw new CommandExecutionError(
                    `xiaohongshu/unfollow ${verifyResult.state}: ${verifyResult.reason ?? 'verification failed'}${formatDiagnostics(mergedDiag)}`,
                );
            }
            return [{ status: verifyResult.state, user_id: userId, url }];
        } catch (err) {
            if (err instanceof CliError) throw err;
            throw new CommandExecutionError(
                `xiaohongshu/unfollow failed: ${err?.message ?? String(err)}`,
            );
        }
    },
});

export const __test__ = {
    assertUserId,
    buildLocateUnfollowCtaScript,
    buildLocateModalConfirmScript,
    buildVerifyUnfollowScript,
    formatDiagnostics,
    CTA_TAG,
    MODAL_TAG,
};
