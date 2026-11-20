// dhamma applications — your active course applications on myCourses.
import { cli, Strategy } from '@jackwener/opencli/registry';
import { EmptyResultError } from '@jackwener/opencli/errors';
import { MYCOURSES_DOMAIN } from './utils.js';
import { MYCOURSES_URLS, extractApplicationsPayload, loadMyCoursesPage, resolveDateSpan } from './mycourses.js';

export const APPLICATION_COLUMNS = ['course', 'participation', 'state', 'start', 'end', 'center', 'applicationId', 'contextId'];

export function mapApplications(rows) {
  return rows.map((row) => {
    const [start, end] = resolveDateSpan(row.startText, row.endText);
    return {
      course: row.course,
      participation: row.participation,
      state: row.state,
      start,
      end,
      center: row.center,
      applicationId: row.applicationId,
      contextId: row.contextId,
    };
  });
}

cli({
  site: 'dhamma',
  name: 'applications',
  access: 'read',
  description: 'Your active Vipassana course applications on myCourses (requires login)',
  domain: MYCOURSES_DOMAIN,
  strategy: Strategy.COOKIE,
  browser: true,
  navigateBefore: false,
  args: [],
  columns: APPLICATION_COLUMNS,
  func: async (page) => {
    const { rows } = await loadMyCoursesPage(page, MYCOURSES_URLS.applications, extractApplicationsPayload, 'dhamma applications');
    if (rows.length === 0) {
      throw new EmptyResultError('dhamma applications', 'No active applications on myCourses.');
    }
    return mapApplications(rows);
  },
});
