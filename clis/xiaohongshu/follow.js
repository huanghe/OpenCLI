/**
 * Xiaohongshu follow — clicks the follow CTA, dismisses any post-click
 * confirmation modal, then reloads the profile and verifies the relation
 * flipped from the server's perspective.
 *
 * xhs public web APIs require `x-s`/`x-t`/`x-s-common` signing that the page
 * can produce but cannot be replayed reliably from outside (a direct
 * `fetch('/api/sns/...')` inside page.evaluate gets 406), so we drive the UI.
 *
 * Live-test evolution of this adapter (see
 * ml-scout/.context/opencli-xhs-follow-bug.md for the full history):
 *
 *   • v1 used `.click()` + DOM-flip polling. Looked fine, but in real batches
 *     0/7 succeeded — the optimistic UI flip from `.click()` could happen
 *     without the framework's onClick ever firing.
 *
 *   • v2 (last commit) replaced `.click()` with a full pointer/mouse/click
 *     event sequence and switched verification to a post-reload server-truth
 *     read. Diagnostics surfaced in the failure error revealed the actual
 *     remaining issue: `dialogs_after_click=1` on every failure — xhs pops a
 *     confirmation modal after the follow click on some accounts/sessions,
 *     and follow.js wasn't dismissing it (unfollow.js already does so for its
 *     own modal).
 *
 *   • v3 (this revision) adds the modal-dismissal step between click and
 *     reload. The modal handler also detects risk-verification modals
 *     (含验证 / 扫码 / 实名 / 风险) and surfaces a specific error so callers
 *     know it's a manual-step issue, not a code bug.
 *
 * Flow:
 *   1. Navigate to https://www.xiaohongshu.com/user/profile/<userId>
 *   2. Login redirect check
 *   3. Click step: locate CTA in profile-header scope (no fallback to
 *      document — see v1→v2 notes), dispatch full event sequence.
 *   4. Modal step: if a dialog is visible, find a confirm button by label,
 *      dispatch the same event sequence on it. If the modal text looks like
 *      a risk-verification prompt, throw with that signal instead.
 *   5. Reload step: page.goto(url) so xhs refetches relation state from the
 *      server through its own signed request.
 *   6. Verify step: re-read the button label. Authoritative.
 *
 * Requires: logged into www.xiaohongshu.com in Chrome.
 */
import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError, AuthRequiredError, CliError, CommandExecutionError } from '@jackwener/opencli/errors';
import { normalizeXhsUserId } from './user-helpers.js';

const PROFILE_SETTLE_MS = 2500;
const MODAL_MOUNT_SETTLE_MS = 900;
const POST_CONFIRM_SETTLE_MS = 1000;
const RELOAD_SETTLE_MS = 2500;
const USER_ID_RE = /^[a-zA-Z0-9]{8,32}$/;

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
    return parts.length ? ` [${parts.join('; ')}]` : '';
}

/**
 * Page-context click script. Locates the follow CTA inside a profile-header
 * scope and dispatches the full event sequence.
 *
 * Returns `{ ok, state, reason?, diag? }`:
 *   ok: true,  state: 'already-following'  → no click needed
 *   ok: true,  state: 'click-dispatched'   → click sent; modal-check next
 *   ok: false, state: 'failed'             → reason + diag for surfaced error
 */
function buildClickScript() {
    return `
(() => {
  const FOLLOW_LABELS = ['关注', '+ 关注', '+关注'];
  const FOLLOWING_LABELS = ['已关注', '已互关', '互相关注'];

  const isVisible = (el) => !!el && el.offsetParent !== null;
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
  // Sometimes the CTA wraps the label in <span><span>关注</span></span> and
  // the class chain ('reds-button-new follow-button …') is the most reliable
  // way to identify it. Prefer class-match first, fall back to label-match.
  const findCtaByClass = () => {
    for (const root of scopes) {
      const candidates = root.querySelectorAll('button.follow-button, button[class*="follow-button"]');
      for (const el of candidates) {
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

  // Idempotent fast path: viewer already follows the target. Check by label
  // first so 已关注 / 已互关 wins even when the class chain is shared.
  if (findButtonByLabels(FOLLOWING_LABELS)) {
    return { ok: true, state: 'already-following' };
  }

  // CTA preference: class-match (handles span-wrapped label), then label-match.
  let followBtn = findCtaByClass();
  if (followBtn) {
    const t = textOf(followBtn);
    // If the class-matched button shows a following-state label, treat as
    // already-following (class chain is reused between states).
    if (FOLLOWING_LABELS.includes(t)) {
      return { ok: true, state: 'already-following' };
    }
    if (!FOLLOW_LABELS.includes(t) && t !== '') {
      // Class said follow-button but text isn't a known label — let label
      // matcher take over to avoid misclicking some other follow-button-style
      // element (e.g. "关注的人" / "粉丝/关注" sub-control).
      followBtn = null;
    }
  }
  if (!followBtn) followBtn = findButtonByLabels(FOLLOW_LABELS);
  if (!followBtn) {
    return {
      ok: false, state: 'failed',
      reason: 'Follow CTA not found in profile-header scope (logged out, blocked, private, or label list out of date).',
      diag: {
        url_after: location.href,
        scope_button_labels: scopeButtonLabels(),
      },
    };
  }

  // Full event sequence (see header comment for rationale).
  const rect = followBtn.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const opts = { bubbles: true, cancelable: true, view: window, button: 0,
                 clientX: cx, clientY: cy };
  try { followBtn.dispatchEvent(new PointerEvent('pointerover', opts)); } catch (_) {}
  try { followBtn.dispatchEvent(new PointerEvent('pointerdown', opts)); } catch (_) {}
  followBtn.dispatchEvent(new MouseEvent('mousedown', opts));
  try { followBtn.dispatchEvent(new PointerEvent('pointerup', opts)); } catch (_) {}
  followBtn.dispatchEvent(new MouseEvent('mouseup', opts));
  followBtn.dispatchEvent(new MouseEvent('click', opts));
  try { followBtn.click(); } catch (_) {}

  const dialogsAfter = document.querySelectorAll(
    '[role="dialog"], .modal, [class*="modal"], [class*="Modal"], .d-modal, .d-modal-footer'
  ).length;

  return {
    ok: true, state: 'click-dispatched',
    diag: {
      clicked_button_html: (followBtn.outerHTML || '').slice(0, 240),
      scope_class: closestScopeClass(followBtn),
      dialogs_after_click: dialogsAfter,
      url_after: location.href,
    },
  };
})()
`;
}

/**
 * Page-context modal handler. Runs after click; idempotent when no modal is
 * up. If a modal is visible:
 *   • Risk / verify-style modal text → return state='risk_verification'
 *   • Confirm button found by label  → dispatch event sequence, return 'confirmed'
 *   • Modal up but no recognized button → return 'no_confirm' with diag
 *
 * Returns `{ ok, state, reason?, diag? }`:
 *   ok: true,  state: 'no_modal'           → no dialog visible (skip)
 *   ok: true,  state: 'confirmed'          → confirm button clicked
 *   ok: false, state: 'risk_verification'  → captcha / 实名 / scan needed
 *   ok: false, state: 'no_confirm'         → modal up, no recognized button
 */
function buildHandleModalScript() {
    return `
(() => {
  const isVisible = (el) => !!el && el.offsetParent !== null;
  const textOf = (el) => (el.innerText || el.textContent || '').trim();

  // Broad modal-root lookup; xhs uses several widget conventions across
  // surfaces (creator center, main site, profile pages).
  const MODAL_SELECTORS = [
    '[role="dialog"]', '.modal', '[class*="modal"]', '[class*="Modal"]',
    '.d-modal', '.d-modal-content', '.d-dialog',
  ];
  const modalRoots = MODAL_SELECTORS
    .flatMap((sel) => Array.from(document.querySelectorAll(sel)))
    .filter(isVisible);
  // Pick the largest visible modal as the primary one (avoids snagging a
  // hidden offscreen modal shell).
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

  // Risk / verification heuristics — these CANNOT be auto-dismissed.
  // Surface a distinct error so the caller knows it's manual-step territory.
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

  // Find a confirm button. Order matters — most-specific first.
  // Explicitly EXCLUDE cancel-like labels (取消 / 关闭 / 拒绝 / 暂不 / 不是).
  const CONFIRM_LABELS = ['确认关注', '立即关注', '继续关注', '确定', '继续', '同意', '我知道了', '知道了', 'OK'];
  const CANCEL_LABELS = ['取消', '关闭', '拒绝', '暂不', '暂不关注', '不是', 'Cancel'];

  const buttons = Array.from(
    modal.querySelectorAll('button, [role="button"], .reds-button-new')
  ).filter(isVisible);
  const buttonLabels = buttons.map(textOf);

  let confirmBtn = null;
  // Pass 1: exact match against confirm labels in priority order.
  for (const label of CONFIRM_LABELS) {
    const hit = buttons.find((b) => textOf(b) === label);
    if (hit) { confirmBtn = hit; break; }
  }
  // Pass 2: any button whose label is NOT a cancel-like label. Last-resort
  // for when xhs uses fresh copy we haven't seen. If there's only one button
  // in the modal and it's not "取消"-shaped, click it.
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

  // Dispatch full event sequence (modal button is React too).
  const rect = confirmBtn.getBoundingClientRect();
  const opts = { bubbles: true, cancelable: true, view: window, button: 0,
                 clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
  try { confirmBtn.dispatchEvent(new PointerEvent('pointerover', opts)); } catch (_) {}
  try { confirmBtn.dispatchEvent(new PointerEvent('pointerdown', opts)); } catch (_) {}
  confirmBtn.dispatchEvent(new MouseEvent('mousedown', opts));
  try { confirmBtn.dispatchEvent(new PointerEvent('pointerup', opts)); } catch (_) {}
  confirmBtn.dispatchEvent(new MouseEvent('mouseup', opts));
  confirmBtn.dispatchEvent(new MouseEvent('click', opts));
  try { confirmBtn.click(); } catch (_) {}

  return {
    ok: true, state: 'confirmed',
    diag: { modal_state: 'confirmed', modal_button_labels: buttonLabels, clicked_button_html: (confirmBtn.outerHTML || '').slice(0, 200) },
  };
})()
`;
}

/**
 * Page-context verify script, run AFTER a reload of the profile URL.
 *
 * Returns `{ ok, state, reason?, diag? }`:
 *   ok: true,  state: 'followed'           → server confirms relation flipped
 *   ok: false, state: 'not-followed'       → server still shows 关注 (no effect)
 *   ok: false, state: 'unknown'            → scope/button missing post-reload
 */
function buildVerifyFollowScript() {
    return `
(() => {
  const FOLLOW_LABELS = ['关注', '+ 关注', '+关注'];
  const FOLLOWING_LABELS = ['已关注', '已互关', '互相关注'];

  const isVisible = (el) => !!el && el.offsetParent !== null;
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
      reason: 'After reload, server still shows 关注 — click reached the handler but server did not commit the follow (backend rejected, or modal-confirm step missed the actual confirm button).',
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
    description: '关注小红书用户 (profile UI + modal-handling + reload-verify)',
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
            // Chrome failed to load the profile (network down, TLS intercept,
            // DNS, etc.) → href is chrome-error://chromewebdata/. Surface this
            // distinctly instead of letting the click step misreport it as
            // "selectors changed".
            if (/^(chrome-error|about|data):/i.test(hrefRaw)) {
                throw new CommandExecutionError(
                    `xiaohongshu/follow: browser could not load ${url} — got ${hrefRaw} (network issue, TLS intercept proxy, or DNS failure)`,
                );
            }
            const parsedHref = new URL(hrefRaw);
            if (/\/login(?:[/?#]|$)/i.test(parsedHref.pathname)) {
                throw new AuthRequiredError('www.xiaohongshu.com');
            }

            // Step 1: locate + click.
            const clickResult = requireActionResult(
                await page.evaluate(buildClickScript()),
                'click-action',
            );
            if (!clickResult.ok) {
                throw new CommandExecutionError(
                    `xiaohongshu/follow failed: ${clickResult.reason ?? 'unknown click failure'}${formatDiagnostics(clickResult.diag)}`,
                );
            }
            if (clickResult.state === 'already-following') {
                return [{ status: 'already-following', user_id: userId, url }];
            }

            // Step 2: handle any post-click confirmation modal. xhs pops one on
            // some sessions; live diagnostics with `dialogs_after_click=1` plus
            // a server that wasn't committing the follow proved the modal was
            // intercepting the request. Idempotent — no-ops cleanly when no
            // modal is up.
            await page.wait({ time: MODAL_MOUNT_SETTLE_MS / 1000 });
            const modalResult = requireActionResult(
                await page.evaluate(buildHandleModalScript()),
                'modal-action',
            );
            if (!modalResult.ok) {
                const merged = { ...(clickResult.diag ?? {}), ...(modalResult.diag ?? {}) };
                throw new CommandExecutionError(
                    `xiaohongshu/follow ${modalResult.state}: ${modalResult.reason ?? 'modal step failed'}${formatDiagnostics(merged)}`,
                );
            }

            // Step 3: reload to force server-side relation state into the DOM,
            // then verify. Authoritative — no relying on optimistic React flip.
            await page.wait({ time: POST_CONFIRM_SETTLE_MS / 1000 });
            await page.goto(url);
            await page.wait({ time: RELOAD_SETTLE_MS / 1000 });

            const verifyResult = requireActionResult(
                await page.evaluate(buildVerifyFollowScript()),
                'verify-action',
            );
            if (!verifyResult.ok) {
                const mergedDiag = {
                    ...(clickResult.diag ?? {}),
                    ...(modalResult.diag ?? {}),
                    ...(verifyResult.diag ?? {}),
                };
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
    buildClickScript,
    buildHandleModalScript,
    buildVerifyFollowScript,
    formatDiagnostics,
};
