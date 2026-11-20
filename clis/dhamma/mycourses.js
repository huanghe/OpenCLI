// myCourses (mycourses.dhamma.org) DOM extractors + normalisers.
//
// The `extract*Payload` functions run inside the browser via
// `page.evaluate(\`(${fn})()\`)`, so each one must be fully self-contained (no
// imports, no outer helpers). They take an optional `doc` so unit tests can
// pass a jsdom document.
import { AuthRequiredError, CommandExecutionError } from '@jackwener/opencli/errors';
import { MYCOURSES_DOMAIN, MYCOURSES_ORIGIN, unwrapEvaluateResult } from './utils.js';

export const MYCOURSES_URLS = {
  applications: `${MYCOURSES_ORIGIN}/en/applications`,
  messages: `${MYCOURSES_ORIGIN}/en/messages`,
  history: `${MYCOURSES_ORIGIN}/en/course-history`,
};

export function extractApplicationsPayload(doc = document) {
  const clean = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
  const loggedIn = Boolean(doc.querySelector('a[href*="/my_user/credentials"], a[href$="/personal"]'));
  if (!loggedIn) return { ok: false, code: 'AUTH_REQUIRED' };
  const cards = Array.from(doc.querySelectorAll('.active-application .card'));
  const rows = cards.map((card) => {
    const lineByIcon = (icon) => Array.from(card.querySelectorAll('.card-body p.card-text'))
      .find((p) => (p.querySelector('svg')?.getAttribute('class') || '').includes(icon));
    const dateSpans = Array.from(lineByIcon('mvip-icon-calendar')?.querySelectorAll('span') ?? [])
      .map((s) => clean(s.textContent)).filter((t) => t && t !== '-');
    const frameId = card.querySelector('turbo-frame[id^="messages-"]')?.id ?? '';
    const summary = card.querySelector('.course-summary');
    const participation = clean(summary?.querySelector('.participation')?.textContent);
    const courseSpan = summary ? Array.from(summary.querySelectorAll('span')).find((s) => !s.classList.contains('participation')) : null;
    return {
      course: clean(courseSpan?.textContent),
      participation,
      state: clean(card.querySelector('.app-state')?.textContent),
      startText: dateSpans[0] ?? '',
      endText: dateSpans[1] ?? dateSpans[0] ?? '',
      center: clean(lineByIcon('mvip-icon-map-pin')?.textContent),
      applicationId: clean(Array.from(lineByIcon('mvip-icon-hash')?.querySelectorAll('span') ?? [])
        .map((s) => s.textContent).find((t) => clean(t))),
      contextId: frameId.replace(/^messages-/, ''),
    };
  });
  return { ok: true, rows };
}

export function extractMessagesPayload(doc = document) {
  const clean = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
  const loggedIn = Boolean(doc.querySelector('a[href*="/my_user/credentials"], a[href$="/personal"]'));
  if (!loggedIn) return { ok: false, code: 'AUTH_REQUIRED' };
  // innerText is empty inside a collapsed <details>, so walk the DOM ourselves
  // and break lines at block-level elements.
  const BLOCK = /^(P|DIV|BR|LI|UL|OL|H[1-6]|TR|TABLE|SECTION|BLOCKQUOTE|HR)$/;
  const walk = (node, out) => {
    if (node.nodeType === 3) {
      out.push(node.nodeValue);
      return;
    }
    if (node.nodeType !== 1) return;
    // Skip scripts and UI controls such as the "Reply" button / reply form.
    if (/^(SCRIPT|STYLE|BUTTON|FORM|TEMPLATE)$/.test(node.tagName)) return;
    if (node.classList?.contains('btn')) return;
    const block = BLOCK.test(node.tagName);
    if (block) out.push('\n');
    for (const child of Array.from(node.childNodes)) walk(child, out);
    if (block) out.push('\n');
  };
  const blockText = (el) => {
    if (!el) return '';
    const parts = [];
    walk(el, parts);
    return parts.join('')
      .split('\n')
      .map((line) => line.replace(/[ \t ]+/g, ' ').trim())
      .filter(Boolean)
      .join('\n');
  };
  const contexts = Array.from(doc.querySelectorAll('select[name="context"] option'))
    .filter((o) => o.value)
    .map((o) => ({ id: o.value, label: clean(o.textContent) }));
  const rows = Array.from(doc.querySelectorAll('details.message')).map((msg) => ({
    id: String(msg.id || '').replace(/^message_/, ''),
    title: clean(msg.querySelector('summary .message-title > span')?.textContent),
    dateText: clean(msg.querySelector('summary .message-date')?.textContent
      || msg.querySelector('summary .message-subtitle')?.textContent),
    body: blockText(msg.querySelector('.message-body')),
  }));
  return { ok: true, rows, contexts };
}

export function extractHistoryPayload(doc = document) {
  const clean = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
  const loggedIn = Boolean(doc.querySelector('a[href*="/my_user/credentials"], a[href$="/personal"]'));
  if (!loggedIn) return { ok: false, code: 'AUTH_REQUIRED' };
  const table = doc.querySelector('.course-history table') || doc.querySelector('table');
  if (!table) return { ok: false, code: 'MALFORMED', message: 'course history table not found' };
  const headers = Array.from(table.querySelectorAll('thead th')).map((th) => clean(th.textContent).toLowerCase());
  const rows = [];
  for (const tr of Array.from(table.querySelectorAll('tbody tr'))) {
    const cells = Array.from(tr.querySelectorAll('td')).map((td) => clean(td.textContent));
    // The empty-state row is a single colspan cell ("The table is empty").
    if (cells.length < 2) continue;
    rows.push({ headers, cells });
  }
  return { ok: true, rows };
}

// ── Node-side helpers ──────────────────────────────────────────────────────

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

function pad(n) {
  return String(n).padStart(2, '0');
}

/** Parse "Dec 9", "Dec 20, 2026" or "Nov 18, 26" → { year|null, month, day }. */
export function parseMonthDay(text) {
  const m = String(text ?? '').trim().match(/^([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2})(?:,\s*(\d{2}|\d{4}))?$/);
  if (!m) return null;
  const month = MONTHS[m[1].toLowerCase()];
  if (!month) return null;
  let year = m[3] ? Number(m[3]) : null;
  if (year != null && year < 100) year += 2000;
  return { year, month, day: Number(m[2]) };
}

function toIso(parts) {
  return parts && parts.year ? `${parts.year}-${pad(parts.month)}-${pad(parts.day)}` : '';
}

/** "Dec 9" + "Dec 20, 2026" → ["2026-12-09", "2026-12-20"]; start inherits the end's year. */
export function resolveDateSpan(startText, endText) {
  const end = parseMonthDay(endText);
  const start = parseMonthDay(startText);
  if (start && !start.year && end?.year) {
    start.year = start.month > end.month ? end.year - 1 : end.year;
  }
  return [toIso(start) || String(startText ?? ''), toIso(end) || String(endText ?? '')];
}

export function normaliseDate(text) {
  return toIso(parseMonthDay(text)) || String(text ?? '');
}

export function requirePayload(result, command) {
  const payload = unwrapEvaluateResult(result);
  if (payload?.ok === true && Array.isArray(payload.rows)) return payload;
  if (payload?.code === 'AUTH_REQUIRED') {
    throw new AuthRequiredError(MYCOURSES_DOMAIN, 'Not logged in to myCourses (mycourses.dhamma.org)');
  }
  throw new CommandExecutionError(
    `${command} could not read the myCourses page`,
    payload?.message || 'The myCourses page markup may have changed.',
  );
}

export async function loadMyCoursesPage(page, url, extractor, command) {
  await page.goto(url, { settleMs: 1500 });
  const result = await page.evaluate(`(${extractor.toString()})()`);
  return requirePayload(result, command);
}

