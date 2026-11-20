import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import { ArgumentError, AuthRequiredError, CommandExecutionError, EmptyResultError } from '@jackwener/opencli/errors';
import { getRegistry } from '@jackwener/opencli/registry';
import {
  buildSearchBody,
  mapCourse,
  parseSearchMeta,
  resolveDateRange,
  resolveLanguage,
  resolveLocation,
  searchCourses,
} from './utils.js';
import { buildSearchQuery } from './search.js';
import { listLocations } from './locations.js';
import { extractApplicationsPayload, extractHistoryPayload, extractMessagesPayload, resolveDateSpan } from './mycourses.js';
import { mapApplications } from './applications.js';
import { buildMessagesUrl, mapMessages } from './messages.js';
import { mapHistory } from './history.js';
import './search.js';
import './applications.js';
import './messages.js';
import './history.js';

// Trimmed copy of the inline script on https://www.dhamma.org/en/courses/search
const SEARCH_PAGE_HTML = `
<script type="text/javascript">
  var viewModel = null;
  var instructionLanguages = [
  { "iso_code": "en", "description": "English" },
  { "iso_code": "cmn", "description": "Mandarin" },
  { "iso_code": "yue", "description": "Cantonese" }
];
  $(document).ready(function() {
    viewModel = new CourseSearchViewModel(opts);
    viewModel.search_regions([
      {text: "regions", children: [{"id":["region",69],"texts":["Taiwan","Taiwan","TW"],"text":"Taiwan"},{"id":["region",99],"texts":["United States","United States","US"],"text":"United States"},{"id":["region",503],"texts":["Andaman \\u0026 Nicobar Islands","x [y]","an.in"],"text":"Andaman \\u0026 Nicobar Islands"}]}
        ,
      {text: "states/provinces", children: [{"id":["state",3909],"texts":["California","California","CA"],"text":"California, United States"},{"id":["state",4001],"texts":["Georgia","Georgia","GA"],"text":"Georgia, United States"}]}
        ,
      {text: "locations", children: [{"id":["location",1520],"texts":["Dhamma Vikāsa",null,"Taiwan","vikasa"],"text":"Dhamma Vikāsa, Dhamma Vikasa, Taiwan"},{"id":["location",1496],"texts":["Dhamma Medinī",null,"Kaukapakapa"],"text":"Dhamma Medinī, Dhamma Medinī, New Zealand"},{"id":["location",1521],"texts":["Dhammodaya",null,"Taichung, Taiwan"],"text":"Dhammodaya, Taichung, Taiwan"}]}
        ,
      {text: "sublocations", children: [{"id":["sublocation",1616],"texts":["Chiayi, Taiwan"],"text":"Chiayi, Chiayi, Taiwan"},{"id":["sublocation",77],"texts":["Georgia"],"text":"Georgia, Tbilisi"}]}
    ]);
    viewModel.course_types(
      {"OldStudents":[{"id":0.5,"text":"Short","group":0.5,"css":"course_type_heading"},{"id":5,"text":"1-Day","group":1},{"id":10,"text":"Satipatthana Sutta","group":3}],"NewStudents":[{"id":3,"text":"10-Day","css":"course_type_entry"},{"id":31,"text":"9-Day","css":"course_type_entry"}],"Executives":[{"id":1,"text":"Executive Course","css":"course_type_entry"}]}
    );
  });
</script>`;

const META = parseSearchMeta(SEARCH_PAGE_HTML);

const COURSE = {
  id: 195773,
  course_start_date: '2026-12-02',
  course_end_date: '2026-12-13',
  enrollment_open_date: '2026-09-03',
  raw_course_type: '10-Day',
  course_type: '10-Day',
  course_instruction_languages: ['Mandarin'],
  status: [
    { status: 'Wait List', label: 'Women', type: 'w' },
    { status: 'Closed', label: 'Men', type: 'm' },
  ],
  location: {
    dhamma_name: 'Dhamma Vikāsa',
    city_province_country: 'Dhamma Vikasa, Taiwan',
    country_iso_code: 'TW',
    website_url: 'http://vikasa.dhamma.org',
    schedule_url: '/en/schedules/schvikasa',
  },
};

function jsonResponse(data) {
  return { ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) };
}

function dom(html, url = 'https://mycourses.dhamma.org/en/applications') {
  return new JSDOM(html, { url }).window.document;
}

const LOGGED_IN_NAV = '<nav><a href="/en/personal">Personal Info</a><a href="/en/my_user/credentials">My Account</a></nav>';

describe('dhamma search lookup tables', () => {
  it('parses embedded regions, course types and languages', () => {
    expect(META.locations.map((l) => l.key)).toEqual([
      'region_69', 'region_99', 'region_503', 'state_3909', 'state_4001',
      'location_1520', 'location_1496', 'location_1521', 'sublocation_1616', 'sublocation_77',
    ]);
    expect(META.locations.find((l) => l.key === 'region_503').name).toBe('Andaman & Nicobar Islands');
    // Group headings with fractional ids are not real course types.
    expect(META.courseTypes.OldStudents.map((c) => c.id)).toEqual([5, 10]);
    expect(META.languages.map((l) => l.iso)).toEqual(['en', 'cmn', 'yue']);
  });

  it('fails loudly when the page no longer embeds the tables', () => {
    expect(() => parseSearchMeta('<html><body>maintenance</body></html>')).toThrow(CommandExecutionError);
  });
});

describe('dhamma location / language resolution', () => {
  it('prefers raw ids, then exact names by kind priority', () => {
    expect(resolveLocation(META.locations, 'region_69').key).toBe('region_69');
    expect(resolveLocation(META.locations, 'taiwan').key).toBe('region_69');
    expect(resolveLocation(META.locations, 'CA').key).toBe('state_3909');
    // "Georgia" is both a US state and a sublocation alias: the state wins.
    expect(resolveLocation(META.locations, 'Georgia').key).toBe('state_4001');
    expect(resolveLocation(META.locations, 'medin').key).toBe('location_1496');
  });

  it('rejects unknown, unknown-id and ambiguous partial locations', () => {
    expect(() => resolveLocation(META.locations, 'atlantis')).toThrow(ArgumentError);
    expect(() => resolveLocation(META.locations, 'region_1')).toThrow(ArgumentError);
    expect(() => resolveLocation(META.locations, 'dhamma')).toThrow(/dhamma location "dhamma" matches several places/);
  });

  it('maps zh to Mandarin and accepts English names', () => {
    expect(resolveLanguage(META.languages, 'zh').iso).toBe('cmn');
    expect(resolveLanguage(META.languages, 'Cantonese').iso).toBe('yue');
    expect(resolveLanguage(META.languages, '')).toBeNull();
    expect(() => resolveLanguage(META.languages, 'klingon')).toThrow(ArgumentError);
  });

  it('lists locations filtered by kind', () => {
    expect(listLocations(META, { query: 'taiwan', limit: 20 }).map((r) => r.id)).toEqual([
      'region_69', 'location_1520', 'location_1521', 'sublocation_1616',
    ]);
    expect(listLocations(META, { query: 'taiwan', kind: 'location', limit: 1 })).toEqual([
      { kind: 'location', id: 'location_1520', name: 'Dhamma Vikāsa, Dhamma Vikasa, Taiwan' },
    ]);
    expect(() => listLocations(META, { query: 'taiwan', kind: 'city' })).toThrow(ArgumentError);
  });
});

describe('dhamma search query', () => {
  const now = new Date(2026, 10, 19);

  it('defaults to new students, today .. +12 months, and always sends the category constraint', () => {
    const query = buildSearchQuery({}, META, now);
    expect(query).toMatchObject({
      state: 'NewStudents', from: '2026-11-19', to: '2027-11-19', sort: 'dates',
      regions: [], languages: [], courseTypes: [], constraint: [3, 31],
    });
    const body = buildSearchBody({ ...query, page: 2 });
    expect(body.get('daterange')).toBe('2026-11-19 - 2027-11-19');
    expect(body.getAll('course_type_constraint[]')).toEqual(['3', '31']);
    expect(body.get('page')).toBe('2');
  });

  it('resolves several places, course type and language into API values', () => {
    const query = buildSearchQuery({
      location: 'Taiwan, location_1496', category: 'old', 'course-type': 'satipatthana', language: 'zh',
      from: '2027-01-01', to: '2027-03-31', sort: 'location',
    }, META, now);
    const body = buildSearchBody(query);
    expect(body.get('current_state')).toBe('OldStudents');
    expect(body.getAll('regions[]')).toEqual(['region_69', 'location_1496']);
    expect(body.getAll('course_types[]')).toEqual(['10']);
    expect(body.getAll('languages[]')).toEqual(['cmn']);
    expect(body.get('sort_column')).toBe('location');
  });

  it('validates arguments before any course request', () => {
    expect(() => buildSearchQuery({ category: 'monks' }, META, now)).toThrow(ArgumentError);
    expect(() => buildSearchQuery({ from: '2027-02-30' }, META, now)).toThrow(ArgumentError);
    expect(() => buildSearchQuery({ from: '2027-03-01', to: '2027-02-01' }, META, now)).toThrow(ArgumentError);
    expect(() => buildSearchQuery({ sort: 'price' }, META, now)).toThrow(ArgumentError);
    expect(() => buildSearchQuery({ 'course-type': 'Satipatthana Sutta' }, META, now)).toThrow(ArgumentError);
    expect(() => resolveDateRange({ to: '2026-01-01' }, now)).toThrow(ArgumentError);
  });

  it('rejects limits above the 100-course cap', async () => {
    const command = getRegistry().get('dhamma/search');
    await expect(command.func({ limit: 101 })).rejects.toThrow(ArgumentError);
  });
});

describe('dhamma search paging and mapping', () => {
  it('pages until the limit is reached and trims the excess', async () => {
    const pages = [
      { page: 1, pages: 10, total_rows: 300, pages_truncated: true, courses: Array.from({ length: 10 }, (_, i) => ({ ...COURSE, id: i })) },
      { page: 2, pages: 10, total_rows: 300, pages_truncated: true, courses: Array.from({ length: 10 }, (_, i) => ({ ...COURSE, id: 10 + i })) },
    ];
    const fetchImpl = vi.fn(async () => jsonResponse(pages.shift()));
    const result = await searchCourses({ state: 'NewStudents', from: '2026-11-19', to: '2027-11-19' }, 15, fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.courses.map((c) => c.id)).toEqual(Array.from({ length: 15 }, (_, i) => i));
    expect(result.truncated).toBe(true);
  });

  it('stops when the server clamps the page number instead of repeating the last page', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ page: 1, pages: 1, total_rows: 3, courses: [COURSE, COURSE, COURSE] }));
    const result = await searchCourses({ state: 'NewStudents', from: 'a', to: 'b' }, 50, fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.courses).toHaveLength(3);
  });

  it('raises on HTTP errors and unexpected payloads', async () => {
    await expect(searchCourses({}, 5, async () => ({ ok: false, status: 503 }))).rejects.toThrow(CommandExecutionError);
    await expect(searchCourses({}, 5, async () => jsonResponse({ error: 'x' }))).rejects.toThrow(CommandExecutionError);
  });

  it('maps a course with per-group status', () => {
    expect(mapCourse(COURSE, 0)).toEqual({
      rank: 1,
      id: 195773,
      start: '2026-12-02',
      end: '2026-12-13',
      courseType: '10-Day',
      center: 'Dhamma Vikāsa',
      location: 'Dhamma Vikasa, Taiwan',
      country: 'TW',
      languages: 'Mandarin',
      status: 'Women: Wait List; Men: Closed',
      enrollmentOpens: '2026-09-03',
      url: 'http://vikasa.dhamma.org',
    });
    const noSite = mapCourse({ ...COURSE, status: [{ status: 'Open', label: null }], location: { ...COURSE.location, website_url: null } }, 4);
    expect(noSite).toMatchObject({ rank: 5, status: 'Open', url: 'https://www.dhamma.org/en/schedules/schvikasa' });
  });
});

const APPLICATIONS_HTML = `${LOGGED_IN_NAV}
<div class="active-application" data-controller="messages-toggle">
  <div class="card mb-4">
    <div class="card-header"><div class="title">
      <span class="course-summary"><span>Ten Day Course</span> <span class="participation">Sitting</span></span>
      <span class="app-state">Cancelled</span>
    </div></div>
    <div class="card-body">
      <p class="card-text"><svg class="mvip-icon mvip-icon-calendar"></svg><span>Dec 9</span><span>-</span><span>Dec 20, 2026</span></p>
      <p class="card-text"><svg class="mvip-icon mvip-icon-map-pin"></svg><span>Dhamma Medinī</span></p>
      <p class="card-text"><svg class="mvip-icon mvip-icon-hash"></svg><span>A-y9Exly</span><span class="clipboard-icon-clipboard"></span></p>
      <div data-messages-toggle-target="container"><turbo-frame id="messages-2354843"></turbo-frame></div>
    </div>
  </div>
</div>`;

const MESSAGES_HTML = `${LOGGED_IN_NAV}
<form class="messages-filter"><select name="context"><option value="">All</option><option value="2354843">Dhamma Medinī - Dec 9, 26</option></select></form>
<div class="messages-list">
  <details class="message" id="message_39368175">
    <summary><div class="message-title"><span>Vipassana course cancellation - A-y9Exly</span><div class="message-subtitle">Nov 18, 26</div></div><div class="message-date">Nov 18, 26</div></summary>
    <div class="message-body"><button>Reply</button><div class="segments"><div>Dear Student,</div><div>We have received your cancellation.</div><ul><li>Item one</li></ul></div></div>
  </details>
  <details class="message" id="message_2">
    <summary><div class="message-title"><span>Confirmation</span></div><div class="message-date">Oct 1, 26</div></summary>
    <div class="message-body"><div class="segments"><p>${'Long text. '.repeat(40)}</p></div></div>
  </details>
</div>`;

const HISTORY_HTML = `${LOGGED_IN_NAV}
<div class="course-history"><table>
  <thead><tr><th>Dates</th><th>Course Type</th><th><span>Location</span></th><th><span>Teacher</span></th></tr></thead>
  <tbody>%ROWS%</tbody>
</table></div>`;

describe('dhamma myCourses extraction', () => {
  it('reads application cards and resolves the year-less start date', () => {
    const payload = extractApplicationsPayload(dom(APPLICATIONS_HTML));
    expect(mapApplications(payload.rows)).toEqual([{
      course: 'Ten Day Course',
      participation: 'Sitting',
      state: 'Cancelled',
      start: '2026-12-09',
      end: '2026-12-20',
      center: 'Dhamma Medinī',
      applicationId: 'A-y9Exly',
      contextId: '2354843',
    }]);
    expect(resolveDateSpan('Dec 28', 'Jan 8, 2027')).toEqual(['2026-12-28', '2027-01-08']);
  });

  it('reports a login page instead of empty rows', () => {
    const login = dom('<form action="/en/users/sign_in"><input type="password"></form>');
    expect(extractApplicationsPayload(login)).toEqual({ ok: false, code: 'AUTH_REQUIRED' });
    expect(extractMessagesPayload(login).code).toBe('AUTH_REQUIRED');
    expect(extractHistoryPayload(login).code).toBe('AUTH_REQUIRED');
  });

  it('reads messages from collapsed <details>, keeping line breaks and skipping buttons', () => {
    const payload = extractMessagesPayload(dom(MESSAGES_HTML));
    expect(payload.contexts).toEqual([{ id: '2354843', label: 'Dhamma Medinī - Dec 9, 26' }]);
    const [first, second] = mapMessages(payload.rows, { limit: 5, full: true });
    expect(first).toEqual({
      id: '39368175',
      date: '2026-11-18',
      title: 'Vipassana course cancellation - A-y9Exly',
      body: 'Dear Student,\nWe have received your cancellation.\nItem one',
    });
    expect(second.date).toBe('2026-10-01');
    const excerpt = mapMessages(payload.rows, { limit: 5, full: false });
    expect(excerpt[0].body).toBe('Dear Student, We have received your cancellation. Item one');
    expect(excerpt[1].body.length).toBe(201);
    expect(mapMessages(payload.rows, { limit: 1, full: false })).toHaveLength(1);
  });

  it('builds the per-application messages URL', () => {
    expect(buildMessagesUrl('')).toBe('https://mycourses.dhamma.org/en/messages');
    expect(buildMessagesUrl('2354843')).toBe('https://mycourses.dhamma.org/en/messages?context=2354843');
    expect(() => buildMessagesUrl('A-y9Exly')).toThrow(ArgumentError);
  });

  it('treats the empty-state history row as no rows and maps real rows by header', () => {
    const empty = extractHistoryPayload(dom(HISTORY_HTML.replace('%ROWS%', '<tr><td colspan="4" class="text-center">The table is empty</td></tr>')));
    expect(empty).toEqual({ ok: true, rows: [] });
    const filled = extractHistoryPayload(dom(HISTORY_HTML.replace('%ROWS%',
      '<tr><td>Dec 9 - Dec 20, 2026</td><td>10-Day</td><td>Dhamma Medinī</td><td>A. Teacher</td></tr>')));
    expect(mapHistory(filled.rows)).toEqual([
      { dates: 'Dec 9 - Dec 20, 2026', courseType: '10-Day', location: 'Dhamma Medinī', teacher: 'A. Teacher' },
    ]);
  });
});

describe('dhamma myCourses commands', () => {
  function pageReturning(payload) {
    return { goto: vi.fn().mockResolvedValue(undefined), evaluate: vi.fn().mockResolvedValue(payload) };
  }

  it('navigates to the applications page and maps rows', async () => {
    const page = pageReturning(extractApplicationsPayload(dom(APPLICATIONS_HTML)));
    const rows = await getRegistry().get('dhamma/applications').func(page, {});
    expect(page.goto).toHaveBeenCalledWith('https://mycourses.dhamma.org/en/applications', expect.any(Object));
    expect(rows[0].applicationId).toBe('A-y9Exly');
  });

  it('maps the extractor states to typed errors', async () => {
    await expect(getRegistry().get('dhamma/applications').func(pageReturning({ ok: false, code: 'AUTH_REQUIRED' }), {}))
      .rejects.toThrow(AuthRequiredError);
    await expect(getRegistry().get('dhamma/history').func(pageReturning({ ok: true, rows: [] }), {}))
      .rejects.toThrow(EmptyResultError);
    await expect(getRegistry().get('dhamma/messages').func(pageReturning({ ok: false, code: 'MALFORMED' }), { limit: 5 }))
      .rejects.toThrow(CommandExecutionError);
  });

  it('opens the filtered messages page for --application', async () => {
    const page = pageReturning(extractMessagesPayload(dom(MESSAGES_HTML)));
    const rows = await getRegistry().get('dhamma/messages').func(page, { application: '2354843', limit: 1 });
    expect(page.goto).toHaveBeenCalledWith('https://mycourses.dhamma.org/en/messages?context=2354843', expect.any(Object));
    expect(rows).toHaveLength(1);
  });
});
