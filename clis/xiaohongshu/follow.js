/**
 * Xiaohongshu follow — follow a user through the page's own `user` store.
 *
 * Previous approach (clicking the profile "关注" button) failed 0/7 in real
 * runs: the click is intercepted by a modal and the button text never flips.
 * xhs public web APIs require `x-s`/`x-t`/`x-s-common` signing that only the
 * page's axios instance produces correctly, so we go through the Pinia
 * `user` store, whose `toFollow({ targetUserId })` action is exactly what the
 * app calls for POST /api/sns/web/v1/user/follow.
 *
 * Flow:
 *   1. Navigate to https://www.xiaohongshu.com/user/profile/<userId>
 *   2. Detect login redirect (xhs bounces to /login on auth failure)
 *   3. Read `userPageData.extraInfo.fstatus` — 'follows' | 'both' means the
 *      viewer already follows the target → return already_following:true
 *      without issuing a write (the command is not idempotent server-side).
 *   4. Call `store.toFollow({ targetUserId })` and wait for the promise.
 *   5. Reload the profile and re-read fstatus to verify the relation flipped.
 *
 * Requires: logged into www.xiaohongshu.com in Chrome.
 */
import { cli, Strategy } from '@jackwener/opencli/registry';
import { AuthRequiredError, CliError, CommandExecutionError } from '@jackwener/opencli/errors';
import { isXiaohongshuHost, PINIA_ACCESS_JS, requireXhsUserId, xhsProfileUrl } from './pinia-helpers.js';
import { unwrapEvaluateResult } from './shared.js';

const PROFILE_SETTLE_MS = 2500;
const VERIFY_RETRIES = 4;
const VERIFY_WAIT_SECONDS = 1;
const FOLLOWING_STATES = new Set(['follows', 'both']);

function requireActionResult(payload, context) {
    const inner = unwrapEvaluateResult(payload);
    if (!inner || typeof inner !== 'object' || Array.isArray(inner) || typeof inner.ok !== 'boolean') {
        throw new CommandExecutionError(`xiaohongshu/follow: malformed ${context} payload`);
    }
    return inner;
}

function assertUserId(raw) {
    return requireXhsUserId(raw, 'xiaohongshu/follow');
}

/**
 * Browser-side: read the follow relation from the `user` store. Returns
 * `{ ok, fstatus, reason? }` where fstatus is 'none' | 'follows' | 'fans' |
 * 'both' | null (null = store not hydrated yet).
 */
function buildReadStatusScript() {
    return `
(() => {
  ${PINIA_ACCESS_JS}
  if (__xhsLoggedOut()) return { ok: false, reason: 'login_wall' };
  const store = __xhsStore('user');
  if (!store) return { ok: false, reason: 'store_unavailable' };
  const pageData = __xhsClone(store.userPageData) || {};
  const fstatus = pageData.extraInfo && typeof pageData.extraInfo.fstatus === 'string' ? pageData.extraInfo.fstatus : null;
  return { ok: true, fstatus, hydrated: Boolean(pageData.basicInfo && Object.keys(pageData.basicInfo).length) };
})()
`;
}

/**
 * Browser-side: issue the follow through the store action. Returns
 * `{ ok, state, reason?, response? }` with state 'followed' | 'failed'.
 */
function buildFollowScript(userId) {
    return `
(async () => {
  ${PINIA_ACCESS_JS}
  const targetUserId = ${JSON.stringify(userId)};
  if (__xhsLoggedOut()) return { ok: false, state: 'failed', reason: 'login_wall' };
  const store = __xhsStore('user');
  if (!store) return { ok: false, state: 'failed', reason: 'store_unavailable' };
  if (typeof store.toFollow !== 'function') return { ok: false, state: 'failed', reason: 'action_unavailable' };
  try {
    const response = await store.toFollow({ targetUserId });
    return { ok: true, state: 'followed', response: __xhsClone(response) };
  } catch (err) {
    const data = err && err.data ? __xhsClone(err.data) : null;
    const code = (data && (data.code !== undefined ? data.code : data.result && data.result.code)) ?? (err && err.code);
    const msg = (data && (data.msg || data.message)) || (err && (err.msg || err.message)) || String(err);
    return { ok: false, state: 'failed', reason: 'api_error', code: code === undefined ? null : code, message: String(msg) };
  }
})()
`;
}

async function readCurrentProfileHref(page, userId) {
    const hrefRaw = unwrapEvaluateResult(await page.evaluate('() => location.href'));
    if (typeof hrefRaw !== 'string') {
        throw new CommandExecutionError('xiaohongshu/follow: malformed current-url payload');
    }
    const parsedHref = new URL(hrefRaw);
    if (parsedHref.protocol !== 'https:' || !isXiaohongshuHost(parsedHref.hostname)) {
        throw new CommandExecutionError(`xiaohongshu/follow: expected Xiaohongshu profile host, got ${parsedHref.hostname}`);
    }
    if (/\/login(?:[/?#]|$)/i.test(parsedHref.pathname)) {
        throw new AuthRequiredError('www.xiaohongshu.com');
    }
    const currentProfile = parsedHref.pathname.match(/^\/user\/profile\/([a-zA-Z0-9]{8,32})\/?$/);
    if (currentProfile?.[1] !== userId) {
        throw new CommandExecutionError(`xiaohongshu/follow: expected profile ${userId}, got ${parsedHref.pathname}`);
    }
}

async function readFollowStatus(page, retries = VERIFY_RETRIES) {
    let result = requireActionResult(await page.evaluate(buildReadStatusScript()), 'follow-status');
    for (let i = 0; i < retries && result.ok && !result.hydrated; i += 1) {
        await page.wait({ time: VERIFY_WAIT_SECONDS });
        result = requireActionResult(await page.evaluate(buildReadStatusScript()), 'follow-status');
    }
    if (!result.ok) {
        if (result.reason === 'login_wall') {
            throw new AuthRequiredError('www.xiaohongshu.com');
        }
        const reason = typeof result.reason === 'string' && result.reason ? result.reason : 'unspecified';
        throw new CommandExecutionError(
            `xiaohongshu/follow: user store unavailable (${reason}); the site bundle may have changed.`,
            'Update opencli or report this with `opencli xiaohongshu follow <id> --verbose`.',
        );
    }
    return typeof result.fstatus === 'string' ? result.fstatus : null;
}

export function isFollowingState(fstatus) {
    return typeof fstatus === 'string' && FOLLOWING_STATES.has(fstatus);
}

cli({
    site: 'xiaohongshu',
    name: 'follow',
    access: 'write',
    description: '关注小红书用户（走页面 store 的 toFollow 接口，已关注时返回 already_following=true 而不报错）',
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
    columns: ['ok', 'user_id', 'already_following', 'status', 'url'],
    func: async (page, kwargs) => {
        if (!page) {
            throw new CommandExecutionError('Browser session required for xiaohongshu follow');
        }
        try {
            const userId = assertUserId(kwargs['user-id']);
            const url = xhsProfileUrl(userId);
            await page.goto(url);
            await page.wait({ time: PROFILE_SETTLE_MS / 1000 });
            await readCurrentProfileHref(page, userId);

            const before = await readFollowStatus(page);
            if (isFollowingState(before)) {
                return [{ ok: true, user_id: userId, already_following: true, status: 'already-following', url }];
            }

            const result = requireActionResult(await page.evaluate(buildFollowScript(userId)), 'follow-action');
            if (!result.ok) {
                if (result.reason === 'login_wall') {
                    throw new AuthRequiredError('www.xiaohongshu.com');
                }
                const detail = result.reason === 'api_error'
                    ? `${result.message ?? 'unknown API error'}${result.code !== null && result.code !== undefined ? ` (code ${result.code})` : ''}`
                    : `${result.reason ?? 'unknown reason'}`;
                throw new CommandExecutionError(`xiaohongshu/follow failed: ${detail}`);
            }

            // Verify: reload the profile and read the relation again. The
            // store's own userPageData is not updated by toFollow.
            await page.goto(url);
            await page.wait({ time: PROFILE_SETTLE_MS / 1000 });
            const after = await readFollowStatus(page);
            if (!isFollowingState(after)) {
                throw new CommandExecutionError(
                    `xiaohongshu/follow failed: follow request returned but the relation still reads ${JSON.stringify(after)} after reload`,
                    'The account may be rate-limited or the request was rejected silently; check the profile in the browser.',
                );
            }
            return [{ ok: true, user_id: userId, already_following: false, status: 'followed', url }];
        }
        catch (err) {
            if (err instanceof CliError) throw err;
            throw new CommandExecutionError(`xiaohongshu/follow failed: ${err?.message ?? String(err)}`);
        }
    },
});

export const __test__ = {
    assertUserId,
    buildFollowScript,
    buildReadStatusScript,
};
