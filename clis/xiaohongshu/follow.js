/**
 * Xiaohongshu follow — clicks the follow button on a user's profile page and
 * verifies the follow took effect by reloading the profile and re-reading the
 * server-truth button state.
 *
 * xhs public web APIs require `x-s`/`x-t`/`x-s-common` signing that the page
 * can produce but cannot be replayed reliably from outside (a direct
 * `fetch('/api/sns/...')` inside page.evaluate gets 406), so we drive the UI.
 *
 * Two failure modes the previous click-and-poll-button-text implementation hit
 * in real-world batch runs (see ml-scout/.context/opencli-xhs-follow-bug.md):
 *
 *   1. Native `.click()` does not always invoke the React/Vue framework's
 *      synthetic click handler — the button visibly clicks but no relation
 *      request fires. Mitigation: dispatch a full pointer/mouse/click event
 *      sequence (pointerdown → mousedown → pointerup → mouseup → click), then
 *      `.click()` as a final fallback.
 *
 *   2. Button text flip ⇌ DOM was unreliable as a "did follow take effect"
 *      signal — xhs's React tree sometimes re-renders late, and (more
 *      seriously) when the click silently fails the local state still toggles
 *      optimistically. Mitigation: after clicking, reload the profile page so
 *      the page re-fetches relation status from the server through its own
 *      signed request, and read the button state from that fresh render.
 *
 * Flow:
 *   1. Navigate to https://www.xiaohongshu.com/user/profile/<userId>
 *   2. Detect login redirect (xhs bounces to /login on auth failure)
 *   3. Inside the page: locate the follow CTA inside a profile-header scope
 *      (no fall-through to document — that used to misclick the "关注" tab
 *      label in the timeline tabs). Return 'already-following' if 已关注 is
 *      visible. Otherwise dispatch the full event sequence on the CTA.
 *   4. Reload the profile URL (forces xhs to refetch relation status from the
 *      server) and re-read the button state. Authoritative.
 *   5. On failure, the thrown error carries diagnostic context
 *      (clicked-button HTML, post-click dialog count, scope-button labels)
 *      so the next bug report can pinpoint the failure mode without a rerun.
 *
 * Requires: logged into www.xiaohongshu.com in Chrome.
 */
import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError, AuthRequiredError, CliError, CommandExecutionError } from '@jackwener/opencli/errors';
import { normalizeXhsUserId } from './user-helpers.js';

const PROFILE_SETTLE_MS = 2500;
const POST_CLICK_SETTLE_MS = 1200;
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
    if (Array.isArray(diag.scope_button_labels) && diag.scope_button_labels.length > 0) {
        parts.push(`scope_buttons=${JSON.stringify(diag.scope_button_labels.slice(0, 12))}`);
    }
    if (diag.url_after) parts.push(`url_after=${diag.url_after}`);
    return parts.length ? ` [${parts.join('; ')}]` : '';
}

/**
 * Page-context click script. Locates the follow CTA inside a profile-header
 * scope and dispatches the full event sequence. Does NOT verify state — that
 * happens after a reload, in buildVerifyFollowScript.
 *
 * Returns `{ ok, state, reason?, diag? }`:
 *   ok: true,  state: 'already-following'  → no click needed
 *   ok: true,  state: 'click-dispatched'   → click sent; reload + verify next
 *   ok: false, state: 'failed'             → reason + diag for surfaced error
 */
function buildClickScript() {
    return `
(() => {
  const FOLLOW_LABELS = ['关注', '+ 关注', '+关注'];
  const FOLLOWING_LABELS = ['已关注', '已互关', '互相关注'];

  const isVisible = (el) => !!el && el.offsetParent !== null;
  const textOf = (el) => (el.innerText || el.textContent || '').trim();

  // Scope is REQUIRED, not best-effort. The old code fell back to
  // document.querySelectorAll('button, [role=button]') when no .user-info /
  // [class*=profile] container was found, which on some xhs layouts picked
  // up the "笔记 / 收藏 / 关注" tab label rendered as a [role=button] before
  // the actual profile-header CTA. Refuse to click instead of guessing.
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
  const scopeButtonLabels = () => collectButtons().map(textOf).filter(Boolean);
  const closestScopeClass = (el) => {
    for (const root of scopes) {
      if (root.contains(el)) {
        return (root.className && String(root.className).slice(0, 80)) || root.tagName;
      }
    }
    return '(unscoped)';
  };

  // Idempotent fast path: viewer already follows the target.
  if (findButtonByLabels(FOLLOWING_LABELS)) {
    return { ok: true, state: 'already-following' };
  }

  const followBtn = findButtonByLabels(FOLLOW_LABELS);
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

  // Full event sequence. Plain .click() proved insufficient — some xhs
  // builds route the actual handler through pointerdown rather than click,
  // and the optimistic UI flip from .click() masks the no-op as success.
  const rect = followBtn.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const opts = { bubbles: true, cancelable: true, view: window, button: 0,
                 clientX: cx, clientY: cy };
  try {
    followBtn.dispatchEvent(new PointerEvent('pointerover', opts));
  } catch (_) { /* PointerEvent may be unavailable in some sandboxes */ }
  try {
    followBtn.dispatchEvent(new PointerEvent('pointerdown', opts));
  } catch (_) {}
  followBtn.dispatchEvent(new MouseEvent('mousedown', opts));
  try {
    followBtn.dispatchEvent(new PointerEvent('pointerup', opts));
  } catch (_) {}
  followBtn.dispatchEvent(new MouseEvent('mouseup', opts));
  followBtn.dispatchEvent(new MouseEvent('click', opts));
  // Belt and suspenders.
  try { followBtn.click(); } catch (_) {}

  const dialogsAfter = document.querySelectorAll(
    '[role="dialog"], .modal, [class*="modal"], [class*="Modal"]'
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
 * Page-context verify script, run AFTER a reload of the profile URL. Reads
 * the button state from the freshly server-rendered page. Authoritative for
 * "did follow take effect" because the page just fetched relation status
 * from the server through its own signed request.
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
      reason: 'After reload, server still shows 关注 — click did not take effect (likely React handler missed, modal blocked, or backend silently rejected).',
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
    description: '关注小红书用户 (profile UI + reload-verify)',
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
            const parsedHref = new URL(hrefRaw);
            if (/\/login(?:[/?#]|$)/i.test(parsedHref.pathname)) {
                throw new AuthRequiredError('www.xiaohongshu.com');
            }

            // Step 1: locate + click. Failure here means we never even
            // dispatched (no scope, no CTA) — surface immediately.
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

            // Step 2: reload to force server-side relation state into the DOM,
            // then verify. Authoritative — no relying on optimistic React flip.
            await page.wait({ time: POST_CLICK_SETTLE_MS / 1000 });
            await page.goto(url);
            await page.wait({ time: RELOAD_SETTLE_MS / 1000 });

            const verifyResult = requireActionResult(
                await page.evaluate(buildVerifyFollowScript()),
                'verify-action',
            );
            if (!verifyResult.ok) {
                // Stitch click-time diagnostics with verify-time diagnostics so
                // the surfaced error is debuggable in one read.
                const mergedDiag = { ...(clickResult.diag ?? {}), ...(verifyResult.diag ?? {}) };
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
    buildVerifyFollowScript,
    formatDiagnostics,
};
