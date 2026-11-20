// Shared helpers for dhamma.org (Vipassana courses as taught by S.N. Goenka).
//
// Course search is public: the search page embeds the region / course-type /
// language lookup tables in inline <script>, and results come from a JSON
// endpoint (`POST /en/courses/do_search`) that needs no cookies.
//
// myCourses (mycourses.dhamma.org) is the logged-in student portal (CALM). It
// is server-rendered HTML, so account commands read the DOM through the
// browser session.
import { ArgumentError, CommandExecutionError } from '@jackwener/opencli/errors';

export const DHAMMA_ORIGIN = 'https://www.dhamma.org';
export const SEARCH_PAGE_URL = `${DHAMMA_ORIGIN}/en/courses/search`;
export const SEARCH_API_URL = `${DHAMMA_ORIGIN}/en/courses/do_search`;
export const MYCOURSES_DOMAIN = 'mycourses.dhamma.org';
export const MYCOURSES_ORIGIN = `https://${MYCOURSES_DOMAIN}`;

/** dhamma.org returns 10 courses per page and never more than 10 pages. */
export const PAGE_SIZE = 10;
export const MAX_PAGES = 10;
export const MAX_SEARCH_LIMIT = PAGE_SIZE * MAX_PAGES;

export const CATEGORIES = {
  new: 'NewStudents',
  old: 'OldStudents',
  children: 'Children',
  executives: 'Executives',
};

export const SORT_COLUMNS = ['dates', 'course_type', 'location'];

/** Region groups in the embedded table, in match-priority order. */
export const LOCATION_KINDS = ['region', 'state', 'location', 'sublocation'];

export function cleanText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

export function requireLimit(value, { defaultValue = 20, max, label = 'limit' } = {}) {
  const raw = value ?? defaultValue;
  const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
  if (!Number.isInteger(n) || n <= 0) {
    throw new ArgumentError(`dhamma ${label} must be a positive integer`);
  }
  if (typeof max === 'number' && n > max) {
    throw new ArgumentError(`dhamma ${label} must be <= ${max}`);
  }
  return n;
}

function parseYmd(value) {
  const match = cleanText(value).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return null;
  }
  return date;
}

function formatYmd(date) {
  return date.toISOString().slice(0, 10);
}

function localToday(now) {
  return new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
}

/**
 * Resolve the search window. Defaults mirror the website: today .. today + 12 months.
 * Returns `{ from, to }` as YYYY-MM-DD strings.
 */
export function resolveDateRange(args = {}, now = new Date()) {
  const fromText = cleanText(args.from);
  const toText = cleanText(args.to);
  const fromDate = fromText ? parseYmd(fromText) : localToday(now);
  if (!fromDate) throw new ArgumentError('dhamma --from must be a valid YYYY-MM-DD date');
  let toDate;
  if (toText) {
    toDate = parseYmd(toText);
    if (!toDate) throw new ArgumentError('dhamma --to must be a valid YYYY-MM-DD date');
  } else {
    toDate = new Date(fromDate);
    toDate.setUTCFullYear(toDate.getUTCFullYear() + 1);
  }
  if (toDate < fromDate) throw new ArgumentError('dhamma --from must be <= --to');
  return { from: formatYmd(fromDate), to: formatYmd(toDate) };
}

export function requireCategory(value) {
  const key = cleanText(value || 'new').toLowerCase();
  const state = CATEGORIES[key];
  if (!state) {
    throw new ArgumentError(`dhamma --category must be one of: ${Object.keys(CATEGORIES).join(', ')}`);
  }
  return state;
}

export function requireSort(value) {
  const sort = cleanText(value || 'dates').toLowerCase();
  if (!SORT_COLUMNS.includes(sort)) {
    throw new ArgumentError(`dhamma --sort must be one of: ${SORT_COLUMNS.join(', ')}`);
  }
  return sort;
}

// ── Embedded lookup tables on the search page ──────────────────────────────

/** Return the JSON array/object literal that starts at `start` (a `[` or `{`). */
function sliceJsonLiteral(text, start) {
  const open = text[start];
  const close = open === '[' ? ']' : '}';
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i += 1;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '[' || ch === '{') depth += 1;
    else if (ch === ']' || ch === '}') {
      depth -= 1;
      if (depth === 0) {
        if (ch !== close) break;
        return text.slice(start, i + 1);
      }
    }
  }
  return null;
}

function parseLiteralAfter(html, marker, opener) {
  const at = html.indexOf(marker);
  if (at < 0) return null;
  const start = html.indexOf(opener, at + marker.length);
  if (start < 0) return null;
  const literal = sliceJsonLiteral(html, start);
  if (!literal) return null;
  try {
    return JSON.parse(literal);
  } catch {
    return null;
  }
}

/**
 * Parse the lookup tables embedded in /en/courses/search.
 * Returns `{ locations, courseTypes, languages }` where
 * - locations: [{ kind, id, key: 'region_69', name, texts }]
 * - courseTypes: { NewStudents: [{ id, text }], ... } (group headings removed)
 * - languages: [{ iso, name }]
 */
export function parseSearchMeta(html) {
  const text = String(html ?? '');
  const locations = [];
  const regionsAt = text.indexOf('viewModel.search_regions(');
  const regionsEnd = regionsAt >= 0 ? text.indexOf('viewModel.course_types(', regionsAt) : -1;
  if (regionsAt >= 0) {
    const block = text.slice(regionsAt, regionsEnd > regionsAt ? regionsEnd : undefined);
    const groupRe = /children:\s*\[/g;
    let match;
    while ((match = groupRe.exec(block))) {
      const literal = sliceJsonLiteral(block, match.index + match[0].length - 1);
      if (!literal) continue;
      let entries;
      try {
        entries = JSON.parse(literal);
      } catch {
        continue;
      }
      for (const entry of entries) {
        const [kind, id] = Array.isArray(entry?.id) ? entry.id : [];
        if (!LOCATION_KINDS.includes(kind) || id == null) continue;
        locations.push({
          kind,
          id: Number(id),
          key: `${kind}_${id}`,
          name: cleanText(entry.text),
          texts: (Array.isArray(entry.texts) ? entry.texts : []).filter((t) => t != null).map((t) => cleanText(t)),
        });
      }
      groupRe.lastIndex = match.index + match[0].length + literal.length;
    }
  }

  const rawCourseTypes = parseLiteralAfter(text, 'viewModel.course_types(', '{') ?? {};
  const courseTypes = {};
  for (const [state, list] of Object.entries(rawCourseTypes)) {
    if (!Array.isArray(list)) continue;
    // Old-student lists include group headings with fractional ids (0.5, 1.5 …).
    courseTypes[state] = list
      .filter((item) => Number.isInteger(item?.id))
      .map((item) => ({ id: item.id, text: cleanText(item.text) }));
  }

  const rawLanguages = parseLiteralAfter(text, 'var instructionLanguages', '[') ?? [];
  const languages = rawLanguages
    .filter((item) => item?.iso_code)
    .map((item) => ({ iso: String(item.iso_code), name: cleanText(item.description) }));

  if (locations.length === 0 || Object.keys(courseTypes).length === 0) {
    throw new CommandExecutionError(
      'dhamma.org course search page did not contain the expected lookup tables',
      'The search page markup may have changed (viewModel.search_regions / viewModel.course_types).',
    );
  }
  return { locations, courseTypes, languages };
}

export async function fetchSearchMeta(fetchImpl = fetch) {
  const res = await fetchImpl(SEARCH_PAGE_URL, { headers: { Accept: 'text/html' } });
  if (!res.ok) {
    throw new CommandExecutionError(`dhamma.org search page returned HTTP ${res.status}`);
  }
  return parseSearchMeta(await res.text());
}

// ── Lookup resolution ─────────────────────────────────────────────────────

function kindRank(kind) {
  return LOCATION_KINDS.indexOf(kind);
}

export function findLocations(locations, query, { kind } = {}) {
  const q = cleanText(query).toLowerCase();
  if (!q) return [];
  const pool = kind ? locations.filter((loc) => loc.kind === kind) : locations;
  const scored = [];
  for (const loc of pool) {
    const haystack = [loc.name, ...loc.texts].map((t) => t.toLowerCase());
    let score;
    if (loc.key === q) score = 0;
    else if (haystack.some((t) => t === q)) score = 1;
    else if (haystack.some((t) => t.startsWith(q))) score = 2;
    else if (haystack.some((t) => t.includes(q))) score = 3;
    else continue;
    scored.push({ loc, score });
  }
  scored.sort((a, b) => a.score - b.score || kindRank(a.loc.kind) - kindRank(b.loc.kind) || a.loc.name.localeCompare(b.loc.name));
  return scored.map((s) => ({ ...s.loc, score: s.score }));
}

function describeCandidates(list) {
  return list.slice(0, 8).map((loc) => `${loc.key} (${loc.name})`).join(', ');
}

/**
 * Resolve one location term to an API key such as `region_69`.
 * Priority: raw key → exact name/alias (region > state > location > sublocation) →
 * a single partial match. Anything else is ambiguous and must be narrowed.
 */
export function resolveLocation(locations, term) {
  const q = cleanText(term);
  if (!q) throw new ArgumentError('dhamma location must not be empty');
  const keyMatch = q.toLowerCase().match(/^(region|state|location|sublocation)_(\d+)$/);
  if (keyMatch) {
    const hit = locations.find((loc) => loc.key === keyMatch[0]);
    if (!hit) throw new ArgumentError(`dhamma location id ${q} is not known to dhamma.org`);
    return hit;
  }
  const matches = findLocations(locations, q);
  if (matches.length === 0) {
    throw new ArgumentError(
      `dhamma location "${q}" did not match any region, state or centre`,
      'Run `opencli dhamma locations <keyword>` to list valid names.',
    );
  }
  const exact = matches.filter((m) => m.score <= 1);
  if (exact.length > 0) {
    const bestKind = exact[0].kind;
    const sameKind = exact.filter((m) => m.kind === bestKind);
    if (sameKind.length === 1) return sameKind[0];
    throw new ArgumentError(
      `dhamma location "${q}" is ambiguous: ${describeCandidates(sameKind)}`,
      'Pass one of the ids above instead (e.g. region_69).',
    );
  }
  if (matches.length === 1) return matches[0];
  throw new ArgumentError(
    `dhamma location "${q}" matches several places: ${describeCandidates(matches)}`,
    'Use a more specific name or pass one of the ids above.',
  );
}

export function resolveCourseType(courseTypes, state, term) {
  const list = courseTypes[state] ?? [];
  const q = cleanText(term).toLowerCase();
  if (!q) return null;
  const exact = list.filter((ct) => ct.text.toLowerCase() === q || String(ct.id) === q);
  if (exact.length === 1) return exact[0];
  const partial = list.filter((ct) => ct.text.toLowerCase().includes(q));
  if (exact.length === 0 && partial.length === 1) return partial[0];
  const options = list.map((ct) => ct.text).join(', ');
  throw new ArgumentError(
    `dhamma --course-type "${term}" ${exact.length + partial.length === 0 ? 'is not available' : 'is ambiguous'} for this category`,
    `Valid course types: ${options}`,
  );
}

/** dhamma.org uses ISO 639-3 for Chinese; accept the common shorthands too. */
const LANGUAGE_ALIASES = {
  zh: 'cmn',
  'zh-cn': 'cmn',
  'zh-tw': 'cmn',
  chinese: 'cmn',
  'zh-hk': 'yue',
};

export function resolveLanguage(languages, term) {
  const raw = cleanText(term).toLowerCase();
  if (!raw) return null;
  const q = LANGUAGE_ALIASES[raw] ?? raw;
  const hit = languages.find((lang) => lang.iso.toLowerCase() === q)
    ?? languages.find((lang) => lang.name.toLowerCase() === q);
  if (!hit) {
    throw new ArgumentError(
      `dhamma --language "${term}" is not a known course language`,
      'Use a code (cmn, yue, en, hi …) or an English name (Mandarin, Cantonese, English …); zh is an alias of cmn.',
    );
  }
  return hit;
}

// ── Search API ─────────────────────────────────────────────────────────────

/**
 * Build the form body the website's jQuery client sends (arrays as `key[]`).
 */
export function buildSearchBody(query) {
  const params = new URLSearchParams();
  params.append('current_state', query.state);
  params.append('daterange', `${query.from} - ${query.to}`);
  for (const key of query.regions ?? []) params.append('regions[]', key);
  for (const iso of query.languages ?? []) params.append('languages[]', iso);
  for (const id of query.courseTypes ?? []) params.append('course_types[]', String(id));
  // Without the constraint the server ignores current_state and mixes in
  // old-student courses, so always send the category's full type list.
  for (const id of query.constraint ?? []) params.append('course_type_constraint[]', String(id));
  params.append('page', String(query.page ?? 1));
  params.append('sort_column', query.sort ?? 'dates');
  params.append('sort_direction', 'up');
  params.append('date_format', 'YYYY-MM-DD');
  return params;
}

export async function postSearch(query, fetchImpl = fetch) {
  const res = await fetchImpl(SEARCH_API_URL, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
    },
    body: buildSearchBody(query).toString(),
  });
  if (!res.ok) {
    throw new CommandExecutionError(`dhamma.org course search returned HTTP ${res.status}`);
  }
  let data;
  try {
    data = await res.json();
  } catch {
    throw new CommandExecutionError('dhamma.org course search returned non-JSON data');
  }
  if (!data || !Array.isArray(data.courses)) {
    throw new CommandExecutionError('dhamma.org course search returned an unexpected payload (no courses array)');
  }
  return data;
}

/** Page through results until `limit` courses are collected or pages run out. */
export async function searchCourses(query, limit, fetchImpl = fetch) {
  const courses = [];
  let total = 0;
  let truncated = false;
  for (let page = 1; page <= MAX_PAGES && courses.length < limit; page += 1) {
    const data = await postSearch({ ...query, page }, fetchImpl);
    total = Number(data.total_rows) || 0;
    truncated = Boolean(data.pages_truncated);
    courses.push(...data.courses);
    const pages = Number(data.pages) || 1;
    // The server clamps out-of-range pages to the last one; stop instead of repeating it.
    if (Number(data.page) !== page || page >= pages || data.courses.length === 0) break;
  }
  return { courses: courses.slice(0, limit), total, truncated };
}

function absoluteUrl(path) {
  const p = cleanText(path);
  if (!p) return '';
  if (/^https?:\/\//i.test(p)) return p;
  return `${DHAMMA_ORIGIN}${p.startsWith('/') ? '' : '/'}${p}`;
}

export function mapCourse(course, index) {
  const loc = course?.location ?? {};
  // One status per applicant group, e.g. "New Women: Closed; Old Men: Long Wait List".
  const statuses = [];
  for (const s of Array.isArray(course?.status) ? course.status : []) {
    const value = cleanText(s?.status);
    if (!value) continue;
    const group = cleanText(s?.label);
    const entry = group ? `${group}: ${value}` : value;
    if (!statuses.includes(entry)) statuses.push(entry);
  }
  return {
    rank: index + 1,
    id: course?.id ?? null,
    start: course?.course_start_date ?? '',
    end: course?.course_end_date ?? '',
    courseType: cleanText(course?.course_type || course?.raw_course_type),
    center: cleanText(loc.dhamma_name),
    location: cleanText(loc.city_province_country),
    country: cleanText(loc.country_iso_code),
    languages: (Array.isArray(course?.course_instruction_languages) ? course.course_instruction_languages : [])
      .map(cleanText).filter(Boolean).join(', '),
    status: statuses.join('; '),
    enrollmentOpens: course?.enrollment_open_date ?? '',
    url: absoluteUrl(loc.website_url) || absoluteUrl(loc.schedule_url),
  };
}

// ── myCourses helpers ──────────────────────────────────────────────────────

export function unwrapEvaluateResult(payload) {
  if (payload && !Array.isArray(payload) && typeof payload === 'object' && 'session' in payload && 'data' in payload) {
    return payload.data;
  }
  return payload;
}

