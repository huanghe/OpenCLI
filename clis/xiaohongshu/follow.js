/**
 * Xiaohongshu follow — drives the profile UI to follow a user.
 *
 * xhs public web APIs require `x-s`/`x-t`/`x-s-common` signing that the page
 * can produce but cannot be replayed reliably from outside (a direct
 * `fetch('/api/sns/...')` inside page.evaluate gets 406), so we drive the UI.
 *
 * Live-test evolution of this adapter (see
 * ml-scout/.context/opencli-xhs-follow-bug.md for the full history):
 *
 *   • v1: `.click()` + DOM-flip polling — 0/7 succeeded in live batches.
 *
 *   • v2: full pointer/mouse/click event-sequence dispatch + reload-verify.
 *     Diagnostics surfaced dialogs_after_click=1 on every failure, and the
 *     verify step proved the server never committed the follow.
 *
 *   • v3: added a post-click modal-handler (.d-modal etc.) to dismiss
 *     confirmation modals — still 0/7. The diagnostics from that run showed
 *     modal handler returning 'no_modal', meaning dialogs_after_click was a
 *     false-positive match against a non-modal element with "modal" in its
 *     class, NOT a real confirmation modal.
 *
 *   • v4 (this revision): SWITCHED click delivery from page.evaluate
 *     `dispatchEvent` to opencli's `page.click()` which uses CDP
 *     `Input.dispatchMouseEvent` — producing `event.isTrusted=true`. xhs's
 *     Vue/reds-button-new follow handler is the textbook profile of a target
 *     that gates on `event.isTrusted` (well-known anti-automation pattern,
 *     and consistent with our v2/v3 evidence: clicks "happened" optimistically
 *     but the server never accepted them). page.evaluate now just LOCATES the
 *     CTA and tags it with `data-opencli-target`; the actual click is
 *     dispatched via CDP from JS land.
 *
 * Flow:
 *   1. Navigate to https://www.xiaohongshu.com/user/profile/<userId>
 *   2. Login redirect check (URL + chrome-error guard)
 *   3. Locate-and-tag: page.evaluate finds the CTA in profile-header scope
 *      and tags it with `data-opencli-target="xhs-follow-cta"`. Returns
 *      'already-following' early on the idempotent fast path.
 *   4. Trusted click: page.click('[data-opencli-target="xhs-follow-cta"]')
 *      → CDP dispatchMouseEvent.
 *   5. Modal step: if a confirmation modal pops up, tag the confirm button
 *      and trusted-click it too. Risk-verification modals (验证码/扫码/实名)
 *      are surfaced as a distinct error class.
 *   6. Reload-verify: page.goto(url) so xhs refetches relation state from the
 *      server, then re-read the button label.
 *
 * Requires: logged into www.xiaohongshu.com in Chrome.
 */
import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError, AuthRequiredError, CliError, CommandExecutionError } from '@jackwener/opencli/errors';
import { normalizeXhsUserId } from './user-helpers.js';

const PROFILE_SETTLE_MS = 2500;
const MODAL_MOUNT_SETTLE_MS = 900;
// Increased from 1000ms → 3000ms in v5. xhs's Vue follow handler may have a
// debounce / next-tick before issuing the /api/sns/web/v1/user/follow POST;
// reading the interceptor too early would miss it.
const POST_CONFIRM_SETTLE_MS = 3000;
const RELOAD_SETTLE_MS = 2500;
const USER_ID_RE = /^[a-zA-Z0-9]{8,32}$/;

const CTA_TAG = 'xhs-follow-cta';
const MODAL_TAG = 'xhs-follow-modal-confirm';

function unwrapEvaluateResult(payload) {
    if (payload && typeof payload === 'object' && 'session' in payload && 'data' in payload) {
        return payload.data;
    }
    return payload;
}

function requireActionResult(payload, context) {
    const inner = unwrapEvaluateResult(payload);
    if (!inner || typeof inner !== 'object' || Array.isArray(inner) || typeof inner.ok !== 'boolean') {
        throw new CommandExecutionError(`xiaohongshu/follow: malformed ${context} payload`);
    }
    return inner;
}

function assertUserId(raw) {
    const userId = normalizeXhsUserId(raw);
    if (!userId || !USER_ID_RE.test(userId)) {
        throw new ArgumentError(
            'xiaohongshu/follow: user-id must be a Xiaohongshu user ID (e.g. 5d8f88dc0000000001005d3a) or full profile URL',
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
    if (typeof diag.dialogs_after_click === 'number') {
        parts.push(`dialogs_after_click=${diag.dialogs_after_click}`);
    }
    if (diag.modal_state) parts.push(`modal_state=${diag.modal_state}`);
    if (Array.isArray(diag.modal_button_labels) && diag.modal_button_labels.length > 0) {
        parts.push(`modal_buttons=${JSON.stringify(diag.modal_button_labels.slice(0, 8))}`);
    }
    if (diag.modal_text) {
        parts.push(`modal_text=${JSON.stringify(String(diag.modal_text).slice(0, 200))}`);
    }
    if (Array.isArray(diag.scope_button_labels) && diag.scope_button_labels.length > 0) {
        parts.push(`scope_buttons=${JSON.stringify(diag.scope_button_labels.slice(0, 12))}`);
    }
    if (diag.url_after) parts.push(`url_after=${diag.url_after}`);
    if (diag.click_dispatch_error) parts.push(`click_dispatch_error=${JSON.stringify(diag.click_dispatch_error)}`);
    if (diag.click_log) parts.push(`click_log=${diag.click_log}`);
    if (diag.doc_click_log) parts.push(`doc_click_log=${diag.doc_click_log}`);
    if (Array.isArray(diag.candidates) && diag.candidates.length > 0) {
        parts.push(`candidates=${JSON.stringify(diag.candidates.map((c) => ({ idx: c.idx, text: c.text, rect: c.rect, ourTag: c.isOurTag })))}`);
    }
    if (typeof diag.intercepted_follow_count === 'number') {
        parts.push(`intercepted_follow_count=${diag.intercepted_follow_count}`);
    }
    if (diag.intercepted_follow_summary) {
        parts.push(`intercepted_follow=${JSON.stringify(String(diag.intercepted_follow_summary).slice(0, 300))}`);
    }
    if (diag.interceptor_status) parts.push(`interceptor_status=${JSON.stringify(diag.interceptor_status)}`);
    return parts.length ? ` [${parts.join('; ')}]` : '';
}

/**
 * Summarize an array of intercepted /follow request entries into a short
 * string for diagnostics. Each entry is {url, data} where data is the parsed
 * JSON response body if available.
 */
function summarizeInterceptedFollows(entries) {
    if (!Array.isArray(entries) || entries.length === 0) return null;
    const parts = [];
    for (const entry of entries.slice(0, 3)) {
        const url = entry?.url ? String(entry.url).split('?')[0].slice(-80) : '<no-url>';
        const data = entry?.data;
        const success = data?.success;
        const code = data?.code;
        const msg = data?.msg;
        parts.push(`${url}: success=${JSON.stringify(success)} code=${JSON.stringify(code)} msg=${JSON.stringify(msg)}`);
    }
    return parts.join(' | ');
}

/**
 * Page-context locate-and-tag for the follow CTA. Does NOT click — the actual
 * click is sent via opencli's `page.click()` (CDP trusted) from JS land. The
 * tag attribute (`data-opencli-target`) is unique enough to survive a few
 * milliseconds; we sweep stale tags on every locate call.
 *
 * Returns `{ ok, state, reason?, diag? }`:
 *   ok: true,  state: 'already-following'  → no click needed
 *   ok: true,  state: 'cta-tagged'         → CTA tagged; caller should
 *                                            page.click('[data-opencli-target=xhs-follow-cta]')
 *   ok: false, state: 'failed'             → reason + diag
 */
function buildLocateCtaScript() {
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

  // Sweep stale tags from any prior run (defensive — adapter normally resets
  // via reload between iterations, but be belt-and-suspenders).
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
      reason: 'No profile-header scope found on page — xhs layout may have changed; update SCOPE_SELECTORS in follow.js.',
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

  // Idempotent fast path.
  if (findButtonByLabels(FOLLOWING_LABELS)) {
    return { ok: true, state: 'already-following' };
  }

  let cta = findCtaByClass();
  if (cta) {
    const t = textOf(cta);
    if (FOLLOWING_LABELS.includes(t)) return { ok: true, state: 'already-following' };
    if (!FOLLOW_LABELS.includes(t) && t !== '') cta = null;
  }
  if (!cta) cta = findButtonByLabels(FOLLOW_LABELS);
  if (!cta) {
    return {
      ok: false, state: 'failed',
      reason: 'Follow CTA not found in profile-header scope (logged out, blocked, private, or label list out of date).',
      diag: {
        url_after: location.href,
        scope_button_labels: scopeButtonLabels(),
      },
    };
  }

  // Dump all candidate buttons so we can spot WHICH one we picked vs the
  // duplicate that's confusing the scope walker.
  const allCandidates = collectButtons()
    .filter((b) => FOLLOW_LABELS.includes(textOf(b)) || FOLLOWING_LABELS.includes(textOf(b)))
    .map((b, idx) => ({
      idx, text: textOf(b),
      html: (b.outerHTML || '').slice(0, 160),
      rect: (() => { const r = b.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }; })(),
      isOurTag: b === cta,
    }));

  cta.setAttribute(TAG_ATTR, TAG_VALUE);
  // Scroll into view so the CDP click coordinate sits inside the viewport.
  try { cta.scrollIntoView({ block: 'center', behavior: 'instant' }); } catch (_) {
    try { cta.scrollIntoView(); } catch (_) {}
  }

  // Wire up event listeners so we can prove whether the click actually
  // reaches this element (and at what trust level).
  try { delete window.__opencli_click_log; } catch (_) {}
  Object.defineProperty(window, '__opencli_click_log', {
    value: [], writable: true, enumerable: false, configurable: true,
  });
  // Also document-level capture, so we observe clicks landing anywhere on
  // the page (even if not on the tagged element). Critical for diagnosing
  // 'clicked-the-wrong-element'.
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
      candidates: allCandidates,
    },
  };
})()
`;
}

/**
 * Page-context modal handler — locates the post-click confirmation modal (if
 * any), tags its confirm button, and reports back. The trusted click is again
 * sent from JS land via page.click().
 *
 * Returns `{ ok, state, reason?, diag? }`:
 *   ok: true,  state: 'no_modal'              → no dialog visible (skip)
 *   ok: true,  state: 'confirm-tagged'        → confirm button tagged
 *   ok: false, state: 'risk_verification'     → captcha / 实名 / scan
 *   ok: false, state: 'no_confirm'            → modal up, no recognized button
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

  // Sweep prior modal tag.
  for (const el of document.querySelectorAll('[' + TAG_ATTR + '="' + TAG_VALUE + '"]')) {
    el.removeAttribute(TAG_ATTR);
  }

  // Modal lookup — broader than before to handle xhs's multiple widget
  // conventions. We filter to visibly-mounted ones with non-zero area.
  const MODAL_SELECTORS = [
    '[role="dialog"]', '.modal', '[class*="modal"]', '[class*="Modal"]',
    '.d-modal', '.d-modal-content', '.d-dialog', '.reds-modal', '[class*="reds-modal"]',
  ];
  const modalRoots = MODAL_SELECTORS
    .flatMap((sel) => Array.from(document.querySelectorAll(sel)))
    .filter(isVisible);
  // Largest visible first — primary modal.
  modalRoots.sort((a, b) => {
    const ra = a.getBoundingClientRect();
    const rb = b.getBoundingClientRect();
    return (rb.width * rb.height) - (ra.width * ra.height);
  });
  const modal = modalRoots[0];
  if (!modal) {
    return { ok: true, state: 'no_modal' };
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

  const CONFIRM_LABELS = ['确认关注', '立即关注', '继续关注', '确定', '继续', '同意', '我知道了', '知道了', 'OK'];
  const CANCEL_LABELS = ['取消', '关闭', '拒绝', '暂不', '暂不关注', '不是', 'Cancel'];

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
      reason: 'xhs follow-confirmation modal appeared, but no recognized confirm button was found. Add the modal label list to CONFIRM_LABELS in follow.js.',
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
 * Page-context verify script, run AFTER a reload. Reads the post-reload
 * button state from the freshly server-rendered page.
 *
 * Returns `{ ok, state, reason?, diag? }`:
 *   ok: true,  state: 'followed'           → server confirms relation flipped
 *   ok: false, state: 'not-followed'       → server still shows 关注
 *   ok: false, state: 'unknown'            → scope/button missing post-reload
 */
function buildVerifyFollowScript() {
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
      reason: 'Post-reload: no profile-header scope on page (login bounce? rate limit?).',
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

  if (buttons.some((b) => FOLLOWING_LABELS.includes(textOf(b)))) {
    return { ok: true, state: 'followed' };
  }
  if (buttons.some((b) => FOLLOW_LABELS.includes(textOf(b)))) {
    return {
      ok: false, state: 'not-followed',
      reason: 'After reload, server still shows 关注 — trusted click delivered but server rejected the follow (rate-limited, abnormal-account flag, or target not followable from this account).',
      diag: { url_after: location.href, scope_button_labels: labels },
    };
  }
  return {
    ok: false, state: 'unknown',
    reason: 'After reload, neither 关注 nor 已关注 button visible in profile scope.',
    diag: { url_after: location.href, scope_button_labels: labels },
  };
})()
`;
}

cli({
    site: 'xiaohongshu',
    name: 'follow',
    access: 'write',
    description: '关注小红书用户 (profile UI + CDP-trusted click + reload-verify)',
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
            throw new CommandExecutionError('Browser session required for xiaohongshu follow');
        }
        try {
            const userId = assertUserId(kwargs['user-id']);
            const url = `https://www.xiaohongshu.com/user/profile/${userId}`;
            await page.goto(url);
            await page.wait({ time: PROFILE_SETTLE_MS / 1000 });

            const hrefRaw = unwrapEvaluateResult(await page.evaluate('() => location.href'));
            if (typeof hrefRaw !== 'string') {
                throw new CommandExecutionError('xiaohongshu/follow: malformed current-url payload');
            }
            if (/^(chrome-error|about|data):/i.test(hrefRaw)) {
                throw new CommandExecutionError(
                    `xiaohongshu/follow: browser could not load ${url} — got ${hrefRaw} (network issue, TLS intercept proxy, or DNS failure)`,
                );
            }
            const parsedHref = new URL(hrefRaw);
            // xhs's frequent-operation challenge redirects to
            // /website-login/captcha?…&verifyBiz=461 (or similar). This is
            // distinct from a login redirect: cookies are still valid, but
            // the user has to solve a captcha in their main browser before
            // any further follow attempts will succeed. We detect this
            // upfront so batch callers can back off rather than slamming
            // into a wall.
            if (/\/website-login\/captcha(?:[/?#]|$)/i.test(parsedHref.pathname)) {
                const verifyBiz = parsedHref.searchParams.get('verifyBiz') || '?';
                throw new CommandExecutionError(
                    `xiaohongshu/follow rate-limited: xhs redirected to captcha verification (verifyBiz=${verifyBiz}). ` +
                    `Open https://www.xiaohongshu.com in your normal browser, solve the captcha that appears, then back off subsequent follows by ≥30s. UID ${userId}.`,
                );
            }
            if (/\/login(?:[/?#]|$)/i.test(parsedHref.pathname)) {
                throw new AuthRequiredError('www.xiaohongshu.com');
            }

            // Install a capture-everything interceptor. Pattern '/' matches
            // ANY URL containing a forward slash — i.e. every fetch/XHR. We
            // narrow afterwards by URL substring in the summarizer. This is
            // critical: an earlier '/api/sns' pattern would miss endpoints
            // hosted on other subdomains (e.g. edith.xiaohongshu.com) or
            // hosted under different paths.
            let interceptorReady = false;
            let interceptorInstallError = null;
            try {
                await page.installInterceptor('/');
                interceptorReady = true;
            } catch (err) {
                interceptorInstallError = String(err?.message ?? err);
            }

            // Step 1: locate + tag the CTA in page context.
            const locateResult = requireActionResult(
                await page.evaluate(buildLocateCtaScript()),
                'locate-action',
            );
            if (!locateResult.ok) {
                throw new CommandExecutionError(
                    `xiaohongshu/follow failed: ${locateResult.reason ?? 'unknown locate failure'}${formatDiagnostics(locateResult.diag)}`,
                );
            }
            if (locateResult.state === 'already-following') {
                return [{ status: 'already-following', user_id: userId, url }];
            }

            // Step 2: hover preamble + trusted CTA click.
            //
            // Hover preamble: anti-bot systems often track whether a mouse
            // moved over an element before the click. CDP page.click only
            // dispatches mouseMoved at the click coordinate (single point).
            // We add a multi-step mouse path from a far position → button to
            // mimic real user cursor movement. Each step has a short
            // sub-100ms gap to look natural.
            //
            // Bypasses page.click resolution so we have control over the
            // sequence. We already tagged the element, so we just need its
            // current rect via a quick getBoundingClientRect probe.
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

                // Hover preamble: 5-step path from (40, 40) to (cx, cy).
                if (typeof page.cdp === 'function') {
                    const startX = 40, startY = 40;
                    const steps = 5;
                    for (let i = 1; i <= steps; i++) {
                        const t = i / steps;
                        const px = Math.round(startX + (cx - startX) * t);
                        const py = Math.round(startY + (cy - startY) * t);
                        await page.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: px, y: py });
                        // Short gap between moves — too long looks scripted,
                        // too short and antibot may detect the burst.
                        await new Promise((r) => setTimeout(r, 40));
                    }
                    // Settle on the button briefly before pressing — gives
                    // any hover-state CSS / @mouseenter handlers time to
                    // fire (some Vue components arm the click handler only
                    // after :hover transitions complete).
                    await new Promise((r) => setTimeout(r, 150));
                    await page.cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: cx, y: cy, button: 'left', clickCount: 1 });
                    await new Promise((r) => setTimeout(r, 35));
                    await page.cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cx, y: cy, button: 'left', clickCount: 1 });
                } else {
                    // Bridge doesn't expose page.cdp — fall back to plain
                    // page.click (still CDP-trusted via tryNativeClick).
                    await page.click(`[data-opencli-target="${CTA_TAG}"]`);
                }
            } catch (err) {
                clickDispatchError = String(err?.message ?? err);
            }

            // Pull the click event logs — both element-level (did click reach
            // tagged element?) and document-level (did click happen anywhere?).
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
                : `${docClickLog.length} events; first=${docClickLog[0]?.kind}@(${docClickLog[0]?.clientX},${docClickLog[0]?.clientY}) trusted=${docClickLog[0]?.isTrusted} target=${JSON.stringify(docClickLog[0]?.targetHtml ?? '')}`;

            if (clickDispatchError) {
                throw new CommandExecutionError(
                    `xiaohongshu/follow: trusted CTA click failed: ${clickDispatchError}${formatDiagnostics({ ...locateResult.diag, click_dispatch_error: clickDispatchError, click_log: clickLogSummary })}`,
                );
            }

            // Step 3: handle any post-click confirmation modal.
            await page.wait({ time: MODAL_MOUNT_SETTLE_MS / 1000 });
            const modalResult = requireActionResult(
                await page.evaluate(buildLocateModalConfirmScript()),
                'modal-action',
            );
            if (!modalResult.ok) {
                const merged = { ...(locateResult.diag ?? {}), ...(modalResult.diag ?? {}) };
                throw new CommandExecutionError(
                    `xiaohongshu/follow ${modalResult.state}: ${modalResult.reason ?? 'modal step failed'}${formatDiagnostics(merged)}`,
                );
            }
            if (modalResult.state === 'confirm-tagged') {
                try {
                    await page.click(`[data-opencli-target="${MODAL_TAG}"]`);
                } catch (err) {
                    const merged = {
                        ...(locateResult.diag ?? {}),
                        ...(modalResult.diag ?? {}),
                        click_dispatch_error: String(err?.message ?? err),
                    };
                    throw new CommandExecutionError(
                        `xiaohongshu/follow: trusted modal-confirm click failed: ${err?.message ?? String(err)}${formatDiagnostics(merged)}`,
                    );
                }
            }

            // Step 4: pull intercepted /api/sns requests BEFORE the reload.
            // installInterceptor patches the current document's XHR/fetch and
            // stores hits on window.__opencli_xhr — both are wiped by a
            // navigation. Pulling here captures everything the click flow
            // generated.
            await page.wait({ time: POST_CONFIRM_SETTLE_MS / 1000 });
            let allIntercepted = [];
            let interceptedFollows = [];
            if (interceptorReady) {
                try {
                    const raw = await page.getInterceptedRequests();
                    allIntercepted = Array.isArray(raw) ? raw : [];
                    interceptedFollows = allIntercepted.filter((e) => {
                        const u = String(e?.url ?? '');
                        return u.includes('/follow') || u.includes('/relation');
                    });
                } catch (_) { /* swallow — diagnostic-only */ }
            }
            // Build summary of ALL intercepted URLs (not just follows). When
            // 0 follow requests are caught but other API calls are, that's a
            // very different signal from 0 calls at all.
            const interceptedSummary = allIntercepted.length > 0
                ? allIntercepted
                    .slice(0, 12)
                    .map((e) => {
                        const u = String(e?.url ?? '');
                        return u.split('?')[0].slice(-90);
                    })
                    .join(' | ')
                : null;
            const interceptDiag = {
                intercepted_follow_count: interceptedFollows.length,
                intercepted_follow_summary: summarizeInterceptedFollows(interceptedFollows)
                    ?? (interceptedSummary
                        ? `no-follow-match among ${allIntercepted.length} captures; sample: ${interceptedSummary}`
                        : undefined),
                interceptor_status: interceptorReady
                    ? `ready (captured ${allIntercepted.length} total)`
                    : `install-failed: ${interceptorInstallError ?? 'unknown'}`,
            };

            // Step 5: reload + verify against fresh server state.
            await page.goto(url);
            await page.wait({ time: RELOAD_SETTLE_MS / 1000 });

            // Reload may also land on the captcha challenge if xhs's
            // rate-limit flips during the click flow. Check before verify.
            const verifyHrefRaw = unwrapEvaluateResult(await page.evaluate('() => location.href'));
            if (typeof verifyHrefRaw === 'string'
                && /\/website-login\/captcha(?:[/?#]|$)/i.test(new URL(verifyHrefRaw).pathname || '')) {
                throw new CommandExecutionError(
                    `xiaohongshu/follow rate-limited at verify: xhs redirected the post-click reload to captcha. ` +
                    `The follow click may have committed server-side — re-check this UID after solving the captcha in your browser. UID ${userId}.`,
                );
            }

            const verifyResult = requireActionResult(
                await page.evaluate(buildVerifyFollowScript()),
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

                // Antibot fingerprint: trusted click DID reach the CTA, BUT
                // no /api/sns/follow request fired, AND server still shows 关注
                // post-reload. This is the textbook signature of xhs's Vue
                // handler refusing to act on clicks from an instrumented
                // (chrome.debugger-attached) Chrome session — the click is
                // visibly trusted but the handler bails before making the
                // network call. Not a fixable bug in this layer; surface a
                // distinct, actionable error.
                // Trusted click reached the page (doc-level listener is the
                // reliable signal because Vue sometimes re-mounts the CTA
                // between locate and click, orphaning element-level
                // listeners).
                const sawTrustedClick = docClickLog.some((e) => e.kind === 'click' && e.isTrusted === true)
                    || clickLog.some((e) => e.kind === 'click' && e.isTrusted === true);
                if (
                    verifyResult.state === 'not-followed'
                    && interceptorReady
                    && interceptedFollows.length === 0
                    && sawTrustedClick
                ) {
                    throw new CommandExecutionError(
                        `xiaohongshu/follow blocked: trusted click reached the follow CTA, but xhs's frontend made no /api/sns follow request — almost certainly anti-automation detection on this Chrome profile (chrome.debugger attached / extension-driven). Follow this user manually in the xhs app or browser. UID ${userId}.${formatDiagnostics(mergedDiag)}`,
                    );
                }

                throw new CommandExecutionError(
                    `xiaohongshu/follow ${verifyResult.state}: ${verifyResult.reason ?? 'verification failed'}${formatDiagnostics(mergedDiag)}`,
                );
            }
            return [{ status: verifyResult.state, user_id: userId, url }];
        } catch (err) {
            if (err instanceof CliError) throw err;
            throw new CommandExecutionError(
                `xiaohongshu/follow failed: ${err?.message ?? String(err)}`,
            );
        }
    },
});

export const __test__ = {
    assertUserId,
    buildLocateCtaScript,
    buildLocateModalConfirmScript,
    buildVerifyFollowScript,
    formatDiagnostics,
    CTA_TAG,
    MODAL_TAG,
};
