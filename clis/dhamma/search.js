// dhamma search — upcoming Vipassana courses from dhamma.org's public course search.
import { cli, Strategy } from '@jackwener/opencli/registry';
import { EmptyResultError } from '@jackwener/opencli/errors';
import {
  MAX_SEARCH_LIMIT,
  cleanText,
  fetchSearchMeta,
  mapCourse,
  requireCategory,
  requireLimit,
  requireSort,
  resolveCourseType,
  resolveDateRange,
  resolveLanguage,
  resolveLocation,
  searchCourses,
} from './utils.js';

export const SEARCH_COLUMNS = [
  'rank', 'id', 'start', 'end', 'courseType', 'center', 'location',
  'country', 'languages', 'status', 'enrollmentOpens', 'url',
];

/** Turn CLI args into a search query (validates everything before any course request). */
export function buildSearchQuery(args, meta, now = new Date()) {
  const state = requireCategory(args.category);
  const { from, to } = resolveDateRange(args, now);
  const sort = requireSort(args.sort);
  const terms = cleanText(args.location)
    ? String(args.location).split(',').map(cleanText).filter(Boolean)
    : [];
  const regions = [...new Set(terms.map((term) => resolveLocation(meta.locations, term).key))];
  const language = resolveLanguage(meta.languages, args.language);
  const courseType = resolveCourseType(meta.courseTypes, state, args['course-type'] ?? args.courseType);
  return {
    state,
    from,
    to,
    sort,
    regions,
    languages: language ? [language.iso] : [],
    courseTypes: courseType ? [courseType.id] : [],
    constraint: (meta.courseTypes[state] ?? []).map((ct) => ct.id),
  };
}

cli({
  site: 'dhamma',
  name: 'search',
  access: 'read',
  description: 'Search Vipassana courses on dhamma.org by place, dates, category, course type and language',
  domain: 'www.dhamma.org',
  strategy: Strategy.PUBLIC,
  browser: false,
  args: [
    { name: 'location', positional: true, type: 'string', required: false, help: 'Region / state / centre name or id (e.g. Taiwan, California, region_69); comma-separate several. Omit for worldwide' },
    { name: 'category', type: 'string', default: 'new', help: 'Student category: new | old | children | executives' },
    { name: 'course-type', type: 'string', default: '', help: 'Course type within the category, e.g. 10-Day, Satipatthana Sutta (see docs)' },
    { name: 'language', type: 'string', default: '', help: 'Instruction language: code or English name (cmn/zh = Mandarin, yue = Cantonese, en, Hindi …)' },
    { name: 'from', type: 'string', default: '', help: 'Earliest start date YYYY-MM-DD (default today)' },
    { name: 'to', type: 'string', default: '', help: 'Latest date YYYY-MM-DD (default from + 12 months)' },
    { name: 'sort', type: 'string', default: 'dates', help: 'Sort by: dates | course_type | location' },
    { name: 'limit', type: 'int', default: 20, help: `Max courses (1-${MAX_SEARCH_LIMIT}; dhamma.org serves at most ${MAX_SEARCH_LIMIT} per search)` },
  ],
  columns: SEARCH_COLUMNS,
  func: async (args) => {
    const limit = requireLimit(args.limit, { max: MAX_SEARCH_LIMIT });
    const meta = await fetchSearchMeta();
    const query = buildSearchQuery(args, meta);
    const { courses } = await searchCourses(query, limit);
    if (courses.length === 0) {
      throw new EmptyResultError('dhamma search', 'No courses match these filters. Try a wider date range or place.');
    }
    return courses.map(mapCourse);
  },
});
