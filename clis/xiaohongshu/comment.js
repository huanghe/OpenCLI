/**
 * Xiaohongshu comment — post a top-level comment on a note through the page's
 * own signed request layer.
 *
 * Why not a plain fetch: xhs web APIs need `x-s` / `x-t` / `x-s-common`
 * headers that only the app's axios instance produces (see pinia-helpers.js).
 * Why not a Pinia action, the way `follow` does it: there is none. Probing a
 * logged-in note page (2026-09-13) dumped every store in `$pinia._s` — `note`
 * carries only comment *view* state (`commentTarget`, `topCommentId`,
 * `forceScrollToComment`), and the sole comment-writing action anywhere,
 * `notification.replyComment`, belongs to the notifications page. The note
 * page's comment box calls a bundled API module directly, so this command
 * reaches that module through webpack's runtime and calls the function that
 * posts to /api/sns/web/v1/comment/post — the same wrapper the UI uses
 * (`postApiSnsWebV1CommentPost(body, opts)`), so every signature header is
 * attached for us. The function is located by matching the endpoint in its
 * source rather than by its minified export name, which changes on every xhs
 * build.
 *
 * Why not click the send button: the same lesson `follow` / `unfollow`
 * learned — modals and overlays intercept clicks on this SPA, and a click that
 * silently does nothing is indistinguishable from one that posted.
 *
 * Flow:
 *   1. Refuse without --execute, before any navigation or request.
 *   2. Navigate to the note through `readXhsDetailPage`, which paces the load
 *      and retries once through a cooldown when risk control soft-blocks it.
 *   3. Post exactly once. Never retry: a retried comment is a duplicate
 *      comment, and xhs offers the caller no undo.
 *
 * When xhs accepts the write but the response carries no comment id, the row
 * is still reported as posted with `verified: false` plus a
 * `COMMENT_UNVERIFIED` line on stderr — callers must read that as "sent, go
 * check", never as a failure to retry. The create API answers with the comment
 * it just made, so that response *is* the read-back; scraping the comment list
 * instead would risk reporting a landed write as a failure (the trap `follow`
 * fell into with the SPA's cached profile).
 *
 * Requires: logged into www.xiaohongshu.com in Chrome.
 */
import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError, AuthRequiredError, CliError, CommandExecutionError, EmptyResultError } from '@jackwener/opencli/errors';
import { buildNoteUrl, parseNoteId, XHS_SIGNED_URL_HINT } from './note-helpers.js';
import { isXiaohongshuHost, PINIA_ACCESS_JS } from './pinia-helpers.js';
import { readXhsDetailPage } from './risk-control.js';
import { unwrapEvaluateResult } from './shared.js';

const COMMAND_LABEL = 'xiaohongshu/comment';
const COMMENT_POST_PATH = '/api/sns/web/v1/comment/post';
/** Bare note ids are 24 hex chars (e.g. 6aa65245000000002603bb74). */
const NOTE_ID_RE = /^[a-f0-9]{24}$/i;
export const UNVERIFIED_MARKER = 'COMMENT_UNVERIFIED';

/**
 * Resolve the target into `{ noteId, noteUrl }`.
 *
 * A full signed URL is the reliable input — bare ids frequently fail to open
 * because the note page wants an `xsec_token` — but a bare id is still
 * accepted, since a caller that only kept the id has nothing better to pass.
 */
export function resolveCommentTarget(raw) {
    const input = String(raw ?? '').trim();
    if (!input) {
        throw new ArgumentError(`${COMMAND_LABEL}: note target cannot be empty`, XHS_SIGNED_URL_HINT);
    }
    if (/^https?:\/\//i.test(input)) {
        // Rejects anything that is not an https xiaohongshu note URL carrying
        // an xsec_token, with the shared "needs a signed URL" hint.
        const noteUrl = buildNoteUrl(input, { commandName: 'xiaohongshu comment' });
        const noteId = parseNoteId(input);
        if (!NOTE_ID_RE.test(noteId)) {
            throw new ArgumentError(`${COMMAND_LABEL}: cannot read a note id out of ${input}`, XHS_SIGNED_URL_HINT);
        }
        return { noteId, noteUrl };
    }
    if (!NOTE_ID_RE.test(input)) {
        throw new ArgumentError(`${COMMAND_LABEL}: note target must be a full note URL with xsec_token, or a 24-character hex note id`, XHS_SIGNED_URL_HINT);
    }
    return { noteId: input, noteUrl: `https://www.xiaohongshu.com/explore/${input}` };
}

/** Browser-side: is the note page usable, or blocked / walled / gone? */
export const COMMENT_PREFLIGHT_JS = `
      (() => {
        const bodyText = document.body?.innerText || ''
        const loginWall = /登录后查看|请登录/.test(bodyText)
        const notFound = /页面不见了|笔记不存在|无法浏览/.test(bodyText)
        const securityBlock = /安全限制|访问链接异常/.test(bodyText)
          || /website-login\\/error|error_code=300017|error_code=300031/.test(location.href)
        return { pageUrl: location.href, securityBlock, loginWall, notFound }
      })()
`;

/**
 * Browser-side prelude defining `__xhsFindCommentPost()`, which digs the
 * signed `comment/post` wrapper out of the webpack module graph.
 */
const FIND_COMMENT_API_JS = `
  const __xhsFindCommentPost = () => {
    const chunk = window.webpackChunkxhs_pc_web;
    if (!Array.isArray(chunk)) return null;
    // Pushing a chunk whose module map is empty hands our callback the
    // runtime's own __webpack_require__ and loads nothing.
    let req = null;
    try { chunk.push([['__opencli_comment__'], {}, (r) => { req = r; }]); } catch { return null; }
    if (typeof req !== 'function') return null;
    const NEEDLE = ${JSON.stringify(COMMENT_POST_PATH)};
    // The wrapper reads: fn(body, opts) { opts.summary = '…'; return axios.post(NEEDLE, body, opts) }
    const pick = (mod) => {
      if (!mod || (typeof mod !== 'object' && typeof mod !== 'function')) return null;
      let keys = [];
      try { keys = Object.keys(mod); } catch { return null; }
      for (const k of keys) {
        let fn = null;
        try { fn = mod[k]; } catch { continue; }
        if (typeof fn !== 'function') continue;
        let src = '';
        try { src = String(fn); } catch { continue; }
        if (src.indexOf(NEEDLE) !== -1 && src.indexOf('.post(') !== -1) return fn;
      }
      return null;
    };
    // Prefer modules webpack has already instantiated: evaluating one the page
    // never loaded can have side effects we have no business triggering.
    const cache = req.c || {};
    for (const id of Object.keys(cache)) {
      const hit = pick(cache[id] && cache[id].exports);
      if (hit) return hit;
    }
    const factories = req.m || {};
    for (const id of Object.keys(factories)) {
      let src = '';
      try { src = String(factories[id]); } catch { continue; }
      if (src.indexOf(NEEDLE) === -1) continue;
      let mod = null;
      try { mod = req(id); } catch { continue; }
      const hit = pick(mod);
      if (hit) return hit;
    }
    return null;
  };
`;

/**
 * Browser-side: post the comment. Returns `{ ok, comment_id, reason?, code?,
 * message? }`. Exactly one request — no retry lives in here or above it.
 */
export function buildCommentScript({ noteId, content }) {
    return `
(async () => {
  ${PINIA_ACCESS_JS}
  ${FIND_COMMENT_API_JS}
  if (__xhsLoggedOut()) return { ok: false, reason: 'login_wall' };
  const postComment = __xhsFindCommentPost();
  if (!postComment) return { ok: false, reason: 'api_unavailable' };
  try {
    const response = __xhsClone(await postComment({
      note_id: ${JSON.stringify(noteId)},
      content: ${JSON.stringify(content)},
      at_users: [],
    }));
    // Depending on the axios interceptor the body arrives unwrapped or still
    // nested under a data property, so read both shapes (as follow.js does).
    const payload = response && typeof response === 'object' ? response : {};
    const inner = payload.data && typeof payload.data === 'object' ? payload.data : {};
    const code = payload.code !== undefined ? payload.code : inner.code;
    const success = payload.success !== undefined ? payload.success : inner.success;
    const msg = payload.msg || payload.message || inner.msg || inner.message || '';
    // A 2xx carrying a non-zero code is a rejected write, not a posted comment.
    if ((code !== undefined && code !== null && code !== 0) || success === false) {
      return { ok: false, reason: 'api_error', code: code === undefined ? null : code, message: String(msg || 'comment rejected') };
    }
    const comment = (payload.comment && typeof payload.comment === 'object' ? payload.comment : null)
      || (inner.comment && typeof inner.comment === 'object' ? inner.comment : null)
      || {};
    const id = typeof comment.id === 'string' && comment.id ? comment.id : null;
    return { ok: true, comment_id: id };
  } catch (err) {
    const data = err && err.data ? __xhsClone(err.data) : null;
    const code = (data && (data.code !== undefined ? data.code : data.result && data.result.code)) ?? (err && err.code);
    const message = (data && (data.msg || data.message)) || (err && (err.msg || err.message)) || String(err);
    return { ok: false, reason: 'api_error', code: code === undefined ? null : code, message: String(message) };
  }
})()
`;
}

function requireActionResult(payload, context) {
    const inner = unwrapEvaluateResult(payload);
    if (!inner || typeof inner !== 'object' || Array.isArray(inner) || typeof inner.ok !== 'boolean') {
        throw new CommandExecutionError(`${COMMAND_LABEL}: malformed ${context} payload`);
    }
    return inner;
}

cli({
    site: 'xiaohongshu',
    name: 'comment',
    access: 'write',
    description: '在小红书笔记下发表评论（走页面自带的已签名请求层，需 --execute 才会真的发出）',
    domain: 'www.xiaohongshu.com',
    strategy: Strategy.COOKIE,
    navigateBefore: false,
    browser: true,
    args: [
        { name: 'note', required: true, positional: true, help: 'Full note URL with xsec_token (preferred), or a 24-char hex note ID' },
        { name: 'text', required: true, positional: true, help: 'Comment text to post' },
        { name: 'execute', type: 'boolean', help: 'Actually post the comment. Without it the command refuses to write.' },
    ],
    columns: ['status', 'comment_id', 'url', 'message', 'verified'],
    func: async (page, kwargs) => {
        if (!page) {
            throw new CommandExecutionError('Browser session required for xiaohongshu comment');
        }
        const content = String(kwargs.text ?? '').trim();
        if (!content) {
            throw new ArgumentError(`${COMMAND_LABEL}: comment text cannot be empty`);
        }
        const { noteId, noteUrl } = resolveCommentTarget(kwargs.note);
        // Write guard: posting is public and irreversible-ish, so require an
        // explicit opt-in — before anything touches the network.
        if (!kwargs.execute) {
            throw new ArgumentError('Refusing to post: pass --execute to actually publish this comment');
        }

        try {
            // Paces the navigation and retries once through a cooldown when
            // risk control soft-blocks the page (throws SECURITY_BLOCK when it
            // is still blocked after that single retry).
            const preflight = unwrapEvaluateResult(await readXhsDetailPage(page, {
                url: noteUrl,
                extractJs: COMMENT_PREFLIGHT_JS,
                securityHelp: 'The note page is temporarily restricted. Wait a few minutes and try again — do not re-run in a loop.',
            }));
            if (!preflight || typeof preflight !== 'object') {
                throw new CommandExecutionError(`${COMMAND_LABEL}: malformed preflight payload`);
            }
            if (preflight.loginWall) {
                throw new AuthRequiredError('www.xiaohongshu.com', 'Posting a comment requires login');
            }
            if (preflight.notFound) {
                throw new EmptyResultError(COMMAND_LABEL, `Note ${noteId} not found or unavailable — it may have been deleted or restricted`);
            }
            // Never run the write against a page that is not the note we were
            // asked for — a redirect must not silently retarget the comment.
            const pageUrl = typeof preflight.pageUrl === 'string' ? preflight.pageUrl : '';
            let parsed;
            try {
                parsed = new URL(pageUrl);
            }
            catch {
                throw new CommandExecutionError(`${COMMAND_LABEL}: malformed preflight payload`);
            }
            if (parsed.protocol !== 'https:' || !isXiaohongshuHost(parsed.hostname)) {
                throw new CommandExecutionError(`${COMMAND_LABEL}: expected a Xiaohongshu note page, got ${parsed.hostname}`);
            }
            if (/\/login(?:[/?#]|$)/i.test(parsed.pathname)) {
                throw new AuthRequiredError('www.xiaohongshu.com');
            }
            if (parseNoteId(pageUrl) !== noteId) {
                throw new CommandExecutionError(`${COMMAND_LABEL}: expected note ${noteId}, got ${parsed.pathname}`);
            }

            const result = requireActionResult(await page.evaluate(buildCommentScript({ noteId, content })), 'comment-action');
            if (!result.ok) {
                if (result.reason === 'login_wall') {
                    throw new AuthRequiredError('www.xiaohongshu.com');
                }
                if (result.reason === 'api_unavailable') {
                    throw new CommandExecutionError(
                        `${COMMAND_LABEL}: the page's comment API is unreachable; the site bundle may have changed.`,
                        'Update opencli or report this with `opencli xiaohongshu comment <url> <text> --execute --verbose`.',
                    );
                }
                const detail = result.reason === 'api_error'
                    ? `${result.message ?? 'unknown API error'}${result.code !== null && result.code !== undefined ? ` (code ${result.code})` : ''}`
                    : `${result.reason ?? 'unknown reason'}`;
                throw new CommandExecutionError(`${COMMAND_LABEL} failed: ${detail}`);
            }

            const commentId = typeof result.comment_id === 'string' && result.comment_id ? result.comment_id : null;
            if (!commentId) {
                // xhs accepted the write; only the id is missing. Never
                // downgrade that to a failure — a retry of a non-idempotent
                // write is worse than an unverified success.
                process.stderr.write(`${UNVERIFIED_MARKER}\n`);
                process.stderr.write(`${COMMAND_LABEL}: the comment was accepted but no comment id came back; check ${noteUrl} before posting again.\n`);
                return [{ status: 'posted-unverified', comment_id: null, url: noteUrl, message: content, verified: false }];
            }
            return [{
                status: 'success',
                comment_id: commentId,
                url: `${noteUrl}#comment-${commentId}`,
                message: content,
                verified: true,
            }];
        }
        catch (err) {
            if (err instanceof CliError) throw err;
            throw new CommandExecutionError(`${COMMAND_LABEL} failed: ${err?.message ?? String(err)}`);
        }
    },
});

export const __test__ = {
    buildCommentScript,
    resolveCommentTarget,
    COMMENT_PREFLIGHT_JS,
};
