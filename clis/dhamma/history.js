// dhamma history — courses you have sat or served, as recorded on myCourses.
import { cli, Strategy } from '@jackwener/opencli/registry';
import { EmptyResultError } from '@jackwener/opencli/errors';
import { MYCOURSES_DOMAIN } from './utils.js';
import { MYCOURSES_URLS, extractHistoryPayload, loadMyCoursesPage } from './mycourses.js';

export const HISTORY_COLUMNS = ['dates', 'courseType', 'location', 'teacher'];

const HEADER_TO_COLUMN = [
  [/date/, 'dates'],
  [/course/, 'courseType'],
  [/location|centre|center/, 'location'],
  [/teacher/, 'teacher'],
];

/** Map table cells by header text; falls back to column order when headers are missing. */
export function mapHistory(rows) {
  return rows.map(({ headers, cells }) => {
    const out = { dates: '', courseType: '', location: '', teacher: '' };
    cells.forEach((cell, i) => {
      const header = headers[i] ?? '';
      const hit = HEADER_TO_COLUMN.find(([re]) => re.test(header));
      const column = hit ? hit[1] : HISTORY_COLUMNS[i];
      if (column && !out[column]) out[column] = cell;
    });
    return out;
  });
}

cli({
  site: 'dhamma',
  name: 'history',
  access: 'read',
  description: 'Your Vipassana course history on myCourses (requires login)',
  domain: MYCOURSES_DOMAIN,
  strategy: Strategy.COOKIE,
  browser: true,
  navigateBefore: false,
  args: [],
  columns: HISTORY_COLUMNS,
  func: async (page) => {
    const { rows } = await loadMyCoursesPage(page, MYCOURSES_URLS.history, extractHistoryPayload, 'dhamma history');
    if (rows.length === 0) {
      throw new EmptyResultError('dhamma history', 'myCourses has no course history recorded for this account.');
    }
    return mapHistory(rows);
  },
});
