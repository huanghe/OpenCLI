/**
 * YouTube comment — post a top-level comment on a video via the InnerTube
 * `comment/create_comment` API (requires SAPISIDHASH auth, same recipe as like.js).
 *
 * Flow (one page.evaluate, three authenticated InnerTube calls):
 *   1. POST /youtubei/v1/next { videoId }        → comments-section continuation token
 *   2. POST /youtubei/v1/next { continuation }   → `createCommentParams` (found by leaf key
 *      because YouTube renames the wrapping renderers often; verified 2026-09-13 on a
 *      logged-in page at onResponseReceivedEndpoints[0].reloadContinuationItemsCommand
 *      .continuationItems[0].commentsHeaderRenderer.createRenderer.commentSimpleboxRenderer
 *      .submitButton.buttonRenderer.serviceEndpoint.createCommentEndpoint.createCommentParams)
 *   3. POST /youtubei/v1/comment/create_comment { createCommentParams, commentText }
 *
 * Posting is public and non-idempotent, so:
 *   - `--execute` is required; without it the command refuses before any navigation.
 *   - the command never retries. When YouTube accepts the write (HTTP 2xx) but the
 *     response carries no comment id, the row is still reported as posted with
 *     `verified: false` and a `COMMENT_UNVERIFIED` line on stderr — callers must
 *     treat that as "sent, go check", never as a failure to retry.
 */
import { cli, Strategy } from '@jackwener/opencli/registry';
import {
    findKeyDeep,
    isYoutubeVideoId,
    parseVideoId,
    prepareYoutubeApiPage,
    readYoutubeSapisid,
    SAPISID_HASH_FN,
} from './utils.js';
import { ArgumentError, AuthRequiredError, CommandExecutionError } from '@jackwener/opencli/errors';

export const UNVERIFIED_MARKER = 'COMMENT_UNVERIFIED';

function unwrapBrowserResult(value) {
    if (value && typeof value === 'object' && !Array.isArray(value) && 'session' in value && 'data' in value) {
        return value.data;
    }
    return value;
}

export function buildCommentScript({ sapisid, videoId, text }) {
    return `
      (async () => {
        ${SAPISID_HASH_FN}
        ${findKeyDeep.toString()}

        const cfg = window.ytcfg?.data_ || {};
        const apiKey = cfg.INNERTUBE_API_KEY;
        const context = cfg.INNERTUBE_CONTEXT;
        if (!apiKey || !context) return { error: 'config', message: 'YouTube config not found' };

        const authHash = await getSapisidHash(${JSON.stringify(sapisid)}, 'https://www.youtube.com');
        if (!authHash) return { error: 'auth', message: 'Not logged in (SAPISID cookie missing)' };

        // One helper for all three calls; returns { error } on failure, { body } on success.
        async function post(path, payload) {
          const resp = await fetch('/youtubei/v1/' + path + '?key=' + apiKey + '&prettyPrint=false', {
            method: 'POST',
            credentials: 'include',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': authHash,
              'X-Origin': 'https://www.youtube.com',
            },
            body: JSON.stringify({ context, ...payload }),
          });
          if (resp.status === 401 || resp.status === 403) return { error: 'auth', message: 'Not logged in' };
          const body = await resp.json().catch(() => ({}));
          if (!resp.ok) {
            const errStatus = body?.error?.status || '';
            if (errStatus === 'UNAUTHENTICATED') return { error: 'auth', message: 'Not logged in' };
            const errMessage = body?.error?.message ? ' ' + body.error.message : '';
            return { error: 'http', message: path + ': HTTP ' + resp.status + (errStatus ? ' ' + errStatus : '') + errMessage };
          }
          return { body };
        }

        const videoId = ${JSON.stringify(videoId)};

        // Step 1: comments-section continuation token from the watch-next response.
        const next = await post('next', { videoId });
        if (next.error) return next;
        const results = next.body?.contents?.twoColumnWatchNextResults?.results?.results?.contents || [];
        const commentSection = results.find(i => i.itemSectionRenderer?.targetId === 'comments-section');
        const continuation = commentSection?.itemSectionRenderer?.contents?.[0]?.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token;
        if (!continuation) return { error: 'http', message: 'No comment section found — comments may be disabled' };

        // Step 2: createCommentParams from the comments header (createRenderer / commentSimpleboxRenderer).
        const section = await post('next', { continuation });
        if (section.error) return section;
        const createCommentParams = findKeyDeep(section.body, 'createCommentParams');
        if (typeof createCommentParams !== 'string' || !createCommentParams) {
          return { error: 'http', message: 'createCommentParams not found — comments may be disabled or the page layout changed' };
        }

        // Step 3: the write. Exactly one call, never retried.
        const created = await post('comment/create_comment', {
          createCommentParams,
          commentText: ${JSON.stringify(text)},
        });
        if (created.error) return created;
        const commentId = findKeyDeep(created.body, 'commentId');
        return { ok: true, commentId: typeof commentId === 'string' && commentId ? commentId : null };
      })()
    `;
}

cli({
    site: 'youtube',
    name: 'comment',
    access: 'write',
    description: 'Post a top-level comment on a YouTube video (requires --execute)',
    domain: 'www.youtube.com',
    strategy: Strategy.COOKIE,
    args: [
        { name: 'url', required: true, positional: true, help: 'YouTube video URL or video ID' },
        { name: 'text', required: true, positional: true, help: 'Comment text to post' },
        { name: 'execute', type: 'boolean', help: 'Actually post the comment. Without it the command refuses to write.' },
    ],
    columns: ['status', 'comment_id', 'url', 'message', 'verified'],
    func: async (page, kwargs) => {
        const text = String(kwargs.text ?? '').trim();
        if (!text) throw new ArgumentError('youtube comment text cannot be empty');
        const videoId = parseVideoId(String(kwargs.url ?? ''));
        if (!isYoutubeVideoId(videoId)) {
            throw new ArgumentError(`youtube comment target is not a video URL or 11-char video id: ${kwargs.url}`);
        }
        // Write guard: posting is public and irreversible-ish, so require an explicit opt-in.
        if (!kwargs.execute) {
            throw new ArgumentError('Refusing to post: pass --execute to actually publish this comment');
        }

        await prepareYoutubeApiPage(page);
        const sapisid = await readYoutubeSapisid(page);
        if (!sapisid) {
            throw new AuthRequiredError('www.youtube.com', 'Not logged in (SAPISID cookie missing)');
        }

        const result = unwrapBrowserResult(await page.evaluate(buildCommentScript({ sapisid, videoId, text })));
        if (result?.error === 'auth') {
            throw new AuthRequiredError('www.youtube.com');
        }
        if (result?.error) {
            throw new CommandExecutionError(result.message || 'Failed to post comment');
        }
        if (!result || result.ok !== true) {
            throw new CommandExecutionError('youtube comment: malformed result from the page script');
        }

        const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
        const commentId = typeof result.commentId === 'string' && result.commentId ? result.commentId : null;
        if (!commentId) {
            // YouTube accepted the write but the response carried no comment id.
            // Never downgrade that to a failure — a retry of a non-idempotent write is worse
            // than an unverified success. Callers key off the marker line.
            process.stderr.write(`${UNVERIFIED_MARKER}\n`);
            process.stderr.write(`YouTube accepted the comment but returned no comment id; check ${videoUrl} before posting again.\n`);
            return [{ status: 'posted-unverified', comment_id: null, url: videoUrl, message: text, verified: false }];
        }
        return [{
            status: 'success',
            comment_id: commentId,
            url: `${videoUrl}&lc=${commentId}`,
            message: text,
            verified: true,
        }];
    },
});
