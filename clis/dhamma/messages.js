// dhamma messages — letters from course centres on myCourses
// (confirmations, reconfirmation requests, cancellations …).
import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError, EmptyResultError } from '@jackwener/opencli/errors';
import { MYCOURSES_DOMAIN, cleanText, requireLimit } from './utils.js';
import { MYCOURSES_URLS, extractMessagesPayload, loadMyCoursesPage, normaliseDate } from './mycourses.js';

const EXCERPT_LENGTH = 200;

export function buildMessagesUrl(application) {
  const ctx = cleanText(application);
  if (!ctx) return MYCOURSES_URLS.messages;
  if (!/^\d+$/.test(ctx)) {
    throw new ArgumentError('dhamma --application must be a numeric contextId (see `opencli dhamma applications`)');
  }
  return `${MYCOURSES_URLS.messages}?context=${ctx}`;
}

export function mapMessages(rows, { limit, full }) {
  return rows.slice(0, limit).map((row) => {
    const flat = row.body.replace(/\s*\n\s*/g, ' ');
    return {
      id: row.id,
      date: normaliseDate(row.dateText),
      title: row.title,
      body: full ? row.body : (flat.length > EXCERPT_LENGTH ? `${flat.slice(0, EXCERPT_LENGTH)}…` : flat),
    };
  });
}

cli({
  site: 'dhamma',
  name: 'messages',
  access: 'read',
  description: 'Messages from course centres on myCourses, newest first (requires login)',
  domain: MYCOURSES_DOMAIN,
  strategy: Strategy.COOKIE,
  browser: true,
  navigateBefore: false,
  args: [
    { name: 'application', type: 'string', default: '', help: 'Only messages for one application (contextId from `dhamma applications`)' },
    { name: 'limit', type: 'int', default: 20, help: 'Max messages' },
    { name: 'full', type: 'boolean', default: false, help: `Return the full message body instead of a ${EXCERPT_LENGTH}-char excerpt` },
  ],
  columns: ['id', 'date', 'title', 'body'],
  func: async (page, args) => {
    const limit = requireLimit(args.limit);
    const url = buildMessagesUrl(args.application);
    const { rows } = await loadMyCoursesPage(page, url, extractMessagesPayload, 'dhamma messages');
    if (rows.length === 0) {
      throw new EmptyResultError('dhamma messages', 'No messages on myCourses for this selection.');
    }
    return mapMessages(rows, { limit, full: args.full === true });
  },
});
