# Dhamma.org (Vipassana)

**Mode**: 🔓 Public (`search`, `locations`) · 🔐 Browser login (`applications`, `messages`, `history`)
**Domains**: `www.dhamma.org` · `mycourses.dhamma.org`

Vipassana meditation courses as taught by S.N. Goenka. Course search uses the
public dhamma.org course search (no browser needed). Account commands read
myCourses (CALM), the student portal at `mycourses.dhamma.org`, through your
logged-in Chrome session.

## Commands

| Command | Description |
|---------|-------------|
| `opencli dhamma search [location]` | Search courses by place, dates, category, course type and language |
| `opencli dhamma locations <query>` | Find region / state / centre names and ids accepted by `search` |
| `opencli dhamma applications` | Your active applications on myCourses |
| `opencli dhamma messages` | Messages from course centres (confirmations, cancellations …) |
| `opencli dhamma history` | Your course history on myCourses |

## Usage Examples

```bash
# Upcoming new-student courses in Taiwan
opencli dhamma search Taiwan

# 10-day courses in the US in Q1 2027, as JSON
opencli dhamma search "United States" --course-type 10-Day --from 2027-01-01 --to 2027-03-31 -f json

# Several places at once (names or ids, comma-separated)
opencli dhamma search "Taiwan, Hong Kong"

# Courses taught in Mandarin anywhere (zh is an alias of cmn)
opencli dhamma search --language zh

# Old-student Satipatthana courses at one centre
opencli dhamma locations vikasa
opencli dhamma search location_1520 --category old --course-type "Satipatthana Sutta"

# myCourses (log in at https://mycourses.dhamma.org in Chrome first)
opencli dhamma applications
opencli dhamma messages --limit 5
opencli dhamma messages --application 2354843 --full
opencli dhamma history
```

## `search`

| Option | Default | Notes |
|--------|---------|-------|
| `location` (positional) | worldwide | Name or id of a region / state / centre (`Taiwan`, `California`, `region_69`). Exact names win over partial matches; on ties a region beats a state, a state beats a centre. Ambiguous names fail with the candidate ids |
| `--category` | `new` | `new` · `old` · `children` · `executives` — mirrors the tabs on the website |
| `--course-type` | all types of the category | e.g. `10-Day`, `9-Day` (new); `1-Day`, `Satipatthana Sutta`, `20-Day` … (old). Unknown values list the valid ones |
| `--language` | any | Instruction language: code or English name. dhamma.org uses `cmn` (Mandarin) and `yue` (Cantonese); `zh` / `chinese` map to `cmn` |
| `--from` / `--to` | today / +12 months | `YYYY-MM-DD` |
| `--sort` | `dates` | `dates` · `course_type` · `location` |
| `--limit` | 20 | 1–100. dhamma.org serves at most 10 pages × 10 courses per search; narrow the dates or place to see more |

| Column | Notes |
|--------|-------|
| `rank` | 1-based position |
| `id` | dhamma.org course id |
| `start` / `end` | `YYYY-MM-DD` |
| `courseType` | e.g. `10-Day`, `Satipatthana Sutta`; some centres use their own label |
| `center` / `location` / `country` | Centre name, city/state/country text, ISO country code |
| `languages` | Instruction languages |
| `status` | Per applicant group, e.g. `New Women: Closed; Old Men: Long Wait List; Servers: Open` |
| `enrollmentOpens` | Date applications open |
| `url` | Centre website (falls back to the dhamma.org schedule page) |

## `locations`

`--kind region|state|location|sublocation` limits the kind; `--limit` (default 20,
max 200). Columns: `kind`, `id` (pass it to `search`), `name`.

## myCourses commands

Require a logged-in Chrome session on `mycourses.dhamma.org`; otherwise they
fail with `AUTH_REQUIRED`. They only read pages — nothing is sent or changed.

- `applications` → `course, participation, state, start, end, center, applicationId, contextId`.
  `contextId` is what `messages --application` takes.
- `messages` → `id, date, title, body`. `body` is a 200-character excerpt;
  `--full` returns the whole letter with line breaks. `--limit` defaults to 20.
- `history` → `dates, courseType, location, teacher`. An account with no
  recorded courses returns `EMPTY_RESULT`.
