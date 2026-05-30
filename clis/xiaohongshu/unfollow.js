/**
 * Xiaohongshu unfollow — clicks the 已关注 button, confirms the resulting
 * "取消关注" modal, then reloads the profile and verifies the relation flipped
 * back to 关注 on the server.
 *
 * Mirror of follow.js with the same hardening (see follow.js header for the
 * full rationale; in short: native `.click()` doesn't always reach the
 * framework's synthetic handler, and the optimistic DOM flip is unreliable as
 * a "did the server accept this" signal).
 *
 * Flow:
 *   1. Navigate to https://www.xiaohongshu.com/user/profile/<userId>
 *   2. Login redirect check
 *   3. Inside the page: locate the 已关注 CTA inside a profile-header scope.
 *      Return 'not-following' if 关注 is showing on entry. Otherwise dispatch
 *      the full pointer/mouse/click event sequence on the CTA.
 *   4. Wait for the .d-modal-footer confirm modal; dispatch the same event
 *      sequence on its 确定 / 不再关注 / 取消关注 button.
 *   5. Reload the profile URL and re-read the button state from the freshly
 *      server-rendered DOM. Authoritative.
 *   6. On failure, surface diagnostics (clicked button HTML, modal labels,
 *      post-reload scope-button labels).
 *
 * Requires: logged into www.xiaohongshu.com in Chrome.
 */
import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError, AuthRequiredError, CliError, CommandExecutionError } from '@jackwener/opencli/errors';
import { normalizeXhsUserId } from './user-helpers.js';

const PROFILE_SETTLE_MS = 2500;
const MODAL_SETTLE_MS = 1500;
const POST_CONFIRM_SETTLE_MS = 1200;
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
    if (diag.modal_button_labels) {
        parts.push(`modal_buttons=${JSON.stringify(diag.modal_button_labels.slice(0, 8))}`);
    }
    if (diag.scope_class) parts.push(`scope=${diag.scope_class}`);
    if (typeof diag.dialogs_after_click === 'number') {
        parts.push(`dialogs_after_click=${diag.dialogs_after_click}`);
    }
    if (Array.isArray(diag.scope_button_labels) && diag.scope_button_labels.length > 0) {
        parts.push(`scope_buttons=${JSON.stringify(diag.scope_button_labels.slice(0, 12))}`);
    }
    if (diag.url_after) parts.push(`url_after=${diag.url_after}`);
    return parts.length ? ` [${parts.join('; ')}]` : '';
}

/**
 * Click the 已关注 button using the full event sequence. Scope required —
 * no fallback to document (see follow.js for why).
 *
 * Returns `{ ok, state, reason?, diag? }`:
 *   ok: true,  state: 'not-following'    → 关注 visible on entry (no-op)
 *   ok: true,  state: 'click-dispatched' → click sent; confirm modal next
 *   ok: false, state: 'failed'           → scope/CTA missing
 */
function buildClickUnfollowScript() {
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
  const btn = findButtonByLabels(FOLLOWING_LABELS);
  if (!btn) {
    return {
      ok: false, state: 'failed',
      reason: 'Follow-state CTA not found in profile-header scope.',
      diag: {
        url_after: location.href,
        scope_button_labels: scopeButtonLabels(),
      },
    };
  }

  const rect = btn.getBoundingClientRect();
  const opts = { bubbles: true, cancelable: true, view: window, button: 0,
                 clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
  try { btn.dispatchEvent(new PointerEvent('pointerover', opts)); } catch (_) {}
  try { btn.dispatchEvent(new PointerEvent('pointerdown', opts)); } catch (_) {}
  btn.dispatchEvent(new MouseEvent('mousedown', opts));
  try { btn.dispatchEvent(new PointerEvent('pointerup', opts)); } catch (_) {}
  btn.dispatchEvent(new MouseEvent('mouseup', opts));
  btn.dispatchEvent(new MouseEvent('click', opts));
  try { btn.click(); } catch (_) {}

  const dialogsAfter = document.querySelectorAll(
    '[role="dialog"], .modal, [class*="modal"], [class*="Modal"]'
  ).length;

  return {
    ok: true, state: 'click-dispatched',
    diag: {
      clicked_button_html: (btn.outerHTML || '').slice(0, 240),
      scope_class: closestScopeClass(btn),
      dialogs_after_click: dialogsAfter,
      url_after: location.href,
    },
  };
})()
`;
}

/**
 * Click the 确定 / 不再关注 button in the `.d-modal-footer` confirmation
 * modal, with the same full event sequence (the modal button is React-rendered
 * too).
 *
 * Returns `{ ok, state, reason?, diag? }`:
 *   ok: true,  state: 'confirmed'  → confirm button clicked
 *   ok: false, state: 'no_modal'   → modal never appeared (likely click on
 *                                    已关注 never reached the handler)
 *   ok: false, state: 'no_confirm' → modal present but no recognized confirm
 *                                    label (xhs changed copy)
 */
function buildConfirmModalScript() {
    return `
(() => {
  const isVisible = (el) => !!el && el.offsetParent !== null;
  const footer = Array.from(document.querySelectorAll('.d-modal-footer')).find(isVisible);
  if (!footer) {
    return {
      ok: false, state: 'no_modal',
      reason: 'Confirm modal (.d-modal-footer) did not appear — 已关注 click likely missed the React handler.',
      diag: {
        url_after: location.href,
        dialogs_after_click: document.querySelectorAll('[role="dialog"], .modal, [class*="modal"], [class*="Modal"]').length,
      },
    };
  }
  const buttons = Array.from(footer.querySelectorAll('button, [role="button"]')).filter(isVisible);
  const labels = buttons.map((b) => (b.innerText || b.textContent || '').trim());
  const confirmBtn = buttons.find((b) => {
    const t = (b.innerText || b.textContent || '').trim();
    return t === '确定' || t === '不再关注' || t === '取消关注';
  });
  if (!confirmBtn) {
    return {
      ok: false, state: 'no_confirm',
      reason: 'Confirm modal present but no 确定/不再关注/取消关注 button — xhs copy may have changed.',
      diag: { modal_button_labels: labels },
    };
  }

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

  return { ok: true, state: 'confirmed' };
})()
`;
}

/**
 * Post-reload verify: 关注 visible → unfollow took effect on server.
 *
 * Returns `{ ok, state, reason?, diag? }`:
 *   ok: true,  state: 'unfollowed'   → server confirms relation cleared
 *   ok: false, state: 'still-following' → 已关注 still visible (no effect)
 *   ok: false, state: 'unknown'      → scope/button missing post-reload
 */
function buildVerifyUnfollowScript() {
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
      reason: 'After reload, server still shows 已关注 — confirm-modal click did not take effect.',
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
    description: '取消关注小红书用户 (profile UI + reload-verify)',
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
            if (/\/login(?:[/?#]|$)/i.test(new URL(hrefRaw).pathname)) {
                throw new AuthRequiredError('www.xiaohongshu.com');
            }

            // Step 1: click 已关注 (idempotent — bails if 关注 visible).
            const clickResult = requireActionResult(
                await page.evaluate(buildClickUnfollowScript()),
                'click-unfollow',
            );
            if (!clickResult.ok) {
                throw new CommandExecutionError(
                    `xiaohongshu/unfollow failed: ${clickResult.reason ?? 'unknown click failure'}${formatDiagnostics(clickResult.diag)}`,
                );
            }
            if (clickResult.state === 'not-following') {
                return [{ status: 'not-following', user_id: userId, url }];
            }

            // Step 2: confirm the modal.
            await page.wait({ time: MODAL_SETTLE_MS / 1000 });
            const confirmResult = requireActionResult(
                await page.evaluate(buildConfirmModalScript()),
                'confirm-modal',
            );
            if (!confirmResult.ok) {
                const merged = { ...(clickResult.diag ?? {}), ...(confirmResult.diag ?? {}) };
                throw new CommandExecutionError(
                    `xiaohongshu/unfollow ${confirmResult.state ?? 'modal-failed'}: ${confirmResult.reason ?? 'modal step failed'}${formatDiagnostics(merged)}`,
                );
            }

            // Step 3: reload + verify against fresh server state.
            await page.wait({ time: POST_CONFIRM_SETTLE_MS / 1000 });
            await page.goto(url);
            await page.wait({ time: RELOAD_SETTLE_MS / 1000 });

            const verifyResult = requireActionResult(
                await page.evaluate(buildVerifyUnfollowScript()),
                'verify-unfollow',
            );
            if (!verifyResult.ok) {
                const merged = { ...(clickResult.diag ?? {}), ...(verifyResult.diag ?? {}) };
                throw new CommandExecutionError(
                    `xiaohongshu/unfollow ${verifyResult.state}: ${verifyResult.reason ?? 'verification failed'}${formatDiagnostics(merged)}`,
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
    buildClickUnfollowScript,
    buildConfirmModalScript,
    buildVerifyUnfollowScript,
    formatDiagnostics,
};
