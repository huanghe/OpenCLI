#!/usr/bin/env node
/**
 * 小红书「青少年儿童手机使用」调研 · 采集脚本
 *
 * 流程：whoami 预检 → 逐关键词 search（两种排序）→ 按 note id 去重、按赞排序、
 * 维度配额 → 逐条 note + comments（--with-replies）→ data/ 下落盘，可断点续跑。
 *
 * 前置：本机 Chrome 已登录小红书、已装 Browser Bridge 扩展、opencli 可用。
 *
 * 用法：
 *   node collect.mjs --dry-run                 # 1 个关键词 5 条 + 1 篇 note/评论，验证环境
 *   node collect.mjs --scale standard          # light=40 / standard=90 / deep=150 篇
 *   node collect.mjs --scale standard --retry-errors   # 重试上次出错的 note/comments
 * 环境变量：
 *   OPENCLI_BIN      opencli 可执行命令（默认 "opencli"；可写 "node /path/dist/src/main.js"）
 *   XHS_SLEEP_SCALE  sleep 倍率（默认 1；测试时设 0）
 */
import { spawn } from 'node:child_process';
import { mkdirSync, existsSync, readFileSync, writeFileSync, appendFileSync, readdirSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCALES = { light: 40, standard: 90, deep: 150 };
const DETAIL_TIMEOUT_MS = 300_000;   // comments 会滚动最多 60 轮，留足时间
const SEARCH_TIMEOUT_MS = 180_000;
const BLOCK_COOLDOWN_S = 600;        // 触发风控后休眠 10 分钟
const BLOCK_CODES = new Set(['SECURITY_BLOCK']);
const BLOCK_TEXT = /安全限制|访问频次|请求太频繁|访问链接异常|captcha|error_code=3000/i;
const SKIP_CODES = new Set(['EMPTY_RESULT', 'COUNTS_NOT_LOADED', 'COMMENTS_NOT_LOADED', 'TIMEOUT', 'COMMAND_EXEC']);

// ───────────────────────── args ─────────────────────────
function parseArgs(argv) {
  const out = { scale: 'standard', dryRun: false, retryErrors: false, data: null, keywords: null, searchLimit: 30, commentLimit: 30 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--retry-errors') out.retryErrors = true;
    else if (a === '--scale') out.scale = next();
    else if (a === '--data') out.data = next();
    else if (a === '--keywords') out.keywords = next();
    else if (a === '--search-limit') out.searchLimit = Number(next());
    else if (a === '--comment-limit') out.commentLimit = Number(next());
    else if (a === '-h' || a === '--help') { console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0]); process.exit(0); }
    else throw new Error(`未知参数 ${a}`);
  }
  if (!SCALES[out.scale]) throw new Error(`--scale 只能是 ${Object.keys(SCALES).join('|')}`);
  if (!(out.searchLimit >= 1 && out.searchLimit <= 100)) throw new Error('--search-limit 需在 1–100');
  if (!(out.commentLimit >= 1 && out.commentLimit <= 50)) throw new Error('--comment-limit 需在 1–50');
  return out;
}

// ───────────────────────── helpers ─────────────────────────
const SLEEP_SCALE = Number(process.env.XHS_SLEEP_SCALE ?? '1');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function pause(minS, maxS, why = '') {
  const s = (minS + Math.random() * (maxS - minS)) * SLEEP_SCALE;
  if (s > 0) { if (why) process.stderr.write(`    … sleep ${s.toFixed(1)}s ${why}\n`); await sleep(s * 1000); }
}
const nowIso = () => new Date().toISOString();
const slug = (s) => s.replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 60);

/** "1.2万" → 12000, "3456" → 3456, "赞" → 0, "10+" → 10 */
export function parseCount(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (v == null) return 0;
  const s = String(v).trim().replace(/,/g, '');
  const m = s.match(/^(\d+(?:\.\d+)?)\s*(万|w|k|千)?/i);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  const unit = (m[2] || '').toLowerCase();
  if (unit === '万' || unit === 'w') return Math.round(n * 10000);
  if (unit === 'k' || unit === '千') return Math.round(n * 1000);
  return Math.round(n);
}

export function parseNoteId(url) {
  const m = String(url).match(/\/(?:explore|note|search_result|discovery\/item)\/([a-f0-9]+)|\/user\/profile\/[^/?#]+\/([a-f0-9]+)/i);
  return m ? (m[1] || m[2]) : null;
}

function readJson(p, fallback = null) {
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return fallback; }
}
function writeJson(p, obj) { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, JSON.stringify(obj, null, 2) + '\n'); }

// ───────────────────────── opencli runner ─────────────────────────
function opencliArgv() {
  const bin = (process.env.OPENCLI_BIN || 'opencli').trim();
  const parts = bin.match(/(?:[^\s"]+|"[^"]*")+/g).map((p) => p.replace(/^"|"$/g, ''));
  return { cmd: parts[0], pre: parts.slice(1) };
}

/** 运行 opencli，返回 { ok, data | error, raw, elapsedMs }。无论退出码，都解析 stdout 最后一行 JSON。 */
function runOpencli(args, { timeoutMs }) {
  const { cmd, pre } = opencliArgv();
  const full = [...pre, ...args];
  const t0 = Date.now();
  return new Promise((resolveP) => {
    const child = spawn(cmd, full, { shell: process.platform === 'win32', env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      const elapsedMs = Date.now() - t0;
      const lines = out.split('\n').map((l) => l.trim()).filter(Boolean);
      let parsed = null;
      for (let i = lines.length - 1; i >= 0; i--) {
        if (lines[i].startsWith('{')) { try { parsed = JSON.parse(lines[i]); break; } catch {} }
      }
      if (!parsed) {
        parsed = { ok: false, error: { code: code === null ? 'TIMEOUT' : 'NO_JSON', message: (err || out).trim().slice(-500) || `exit ${code}` } };
      }
      resolveP({ ...parsed, raw: { exitCode: code, stderr: err.trim().slice(-1000) }, elapsedMs });
    });
    child.on('error', (e) => { clearTimeout(timer); resolveP({ ok: false, error: { code: 'SPAWN', message: e.message }, elapsedMs: Date.now() - t0 }); });
  });
}

const xhs = (sub, ...rest) => ['xiaohongshu', sub, ...rest, '-f', 'json'];

// ───────────────────────── run log ─────────────────────────
let LOG_PATH = null;
function log(phase, command, target, count, status, elapsedMs, note = '') {
  const line = [nowIso(), phase, command, target, count ?? '', status, elapsedMs ?? '', String(note).replace(/\s+/g, ' ').slice(0, 200)].join('\t');
  process.stderr.write(line + '\n');
  if (LOG_PATH) appendFileSync(LOG_PATH, line + '\n');
}

function classify(res) {
  if (res.ok) return 'ok';
  const code = res.error?.code || '';
  const msg = `${res.error?.message || ''} ${res.error?.hint || ''}`;
  if (code === 'AUTH_REQUIRED' || code === 'LOGIN_WALL') return 'auth';
  if (BLOCK_CODES.has(code) || BLOCK_TEXT.test(msg)) return 'block';
  if (SKIP_CODES.has(code)) return 'skip';
  if (code === 'BROWSER_CONNECT' || code === 'SPAWN' || code === 'NO_JSON') return 'fatal';
  return 'skip';
}

// ───────────────────────── phases ─────────────────────────
async function preflight() {
  const res = await runOpencli(xhs('whoami'), { timeoutMs: 120_000 });
  const who = Array.isArray(res.data) ? res.data[0] : res.data;
  log('preflight', 'whoami', '-', who ? 1 : 0, res.ok ? 'ok' : (res.error?.code || 'error'), res.elapsedMs, res.ok ? `user=${who?.username ?? ''}` : res.error?.message);
  if (!res.ok) {
    const kind = classify(res);
    console.error(`\n✗ 预检失败 [${res.error?.code}] ${res.error?.message}`);
    if (kind === 'auth') console.error('  → 先在 Chrome 登录小红书，或运行：opencli xiaohongshu login');
    else if (res.error?.hint) console.error(`  → ${res.error.hint}`);
    process.exit(2);
  }
  return who;
}

async function searchPhase(cfg, keywords, dirs) {
  const jobs = [];
  for (const [dimension, kws] of Object.entries(keywords.dimensions)) {
    for (const keyword of kws) for (const sort of keywords.sorts) jobs.push({ dimension, keyword, sort });
  }
  let blockStreak = 0;
  for (const job of jobs) {
    const file = join(dirs.search, `${slug(job.keyword)}__${job.sort}.json`);
    if (existsSync(file)) { log('search', 'search', `${job.keyword}|${job.sort}`, readJson(file)?.data?.length ?? 0, 'cached', 0); continue; }
    const res = await runOpencli(xhs('search', job.keyword, '--limit', String(cfg.searchLimit), '--sort', job.sort), { timeoutMs: SEARCH_TIMEOUT_MS });
    const kind = classify(res);
    log('search', 'search', `${job.keyword}|${job.sort}`, res.ok ? res.data.length : 0, res.ok ? 'ok' : res.error?.code, res.elapsedMs, res.ok ? '' : res.error?.message);
    if (kind === 'auth') abort(res, 'search');
    if (kind === 'fatal') abort(res, 'search');
    if (kind === 'block') {
      if (++blockStreak >= 2) abort(res, 'search', '连续两次触发风控。请等 30 分钟以上再重跑（已完成的搜索会跳过）。');
      await pause(BLOCK_COOLDOWN_S, BLOCK_COOLDOWN_S * 1.3, '(风控冷却)');
      const retry = await runOpencli(xhs('search', job.keyword, '--limit', String(cfg.searchLimit), '--sort', job.sort), { timeoutMs: SEARCH_TIMEOUT_MS });
      log('search', 'search-retry', `${job.keyword}|${job.sort}`, retry.ok ? retry.data.length : 0, retry.ok ? 'ok' : retry.error?.code, retry.elapsedMs, retry.ok ? '' : retry.error?.message);
      if (retry.ok) { writeJson(file, { meta: { ...job, fetched_at: nowIso(), limit: cfg.searchLimit }, data: retry.data }); blockStreak = 0; }
      await pause(4, 8);
      continue;
    }
    if (res.ok) { blockStreak = 0; writeJson(file, { meta: { ...job, fetched_at: nowIso(), limit: cfg.searchLimit }, data: res.data }); }
    await pause(2.5, 5);
  }
}

export function mergeSearch(searchDir, keywords, targetN) {
  const byId = new Map();
  for (const f of readdirSync(searchDir).filter((f) => f.endsWith('.json'))) {
    const doc = readJson(join(searchDir, f));
    if (!doc?.data) continue;
    for (const row of doc.data) {
      const id = parseNoteId(row.url);
      if (!id) continue;
      const hit = { dimension: doc.meta.dimension, keyword: doc.meta.keyword, sort: doc.meta.sort, rank: row.rank };
      const likes = parseCount(row.likes);
      const cur = byId.get(id);
      if (cur) { cur.hits.push(hit); cur.likes = Math.max(cur.likes, likes); if (!cur.url.includes('xsec_token') && row.url.includes('xsec_token')) cur.url = row.url; }
      else byId.set(id, { id, url: row.url, title: row.title || '', author: row.author || '', author_url: row.author_url || '', likes, published_at: row.published_at || '', hits: [hit] });
    }
  }
  const all = [...byId.values()];
  for (const n of all) n.dimensions = [...new Set(n.hits.map((h) => h.dimension))];
  const score = (n) => n.likes * 1 + n.hits.length * 50;   // 多关键词命中略加分
  all.sort((a, b) => score(b) - score(a));
  const dims = Object.keys(keywords.dimensions);
  const quota = Math.floor((targetN / dims.length) * 0.7);
  const chosen = new Set();
  for (const d of dims) {
    let k = 0;
    for (const n of all) { if (k >= quota) break; if (!chosen.has(n.id) && n.dimensions.includes(d)) { chosen.add(n.id); k++; } }
  }
  for (const n of all) { if (chosen.size >= targetN) break; chosen.add(n.id); }
  const selected = all.filter((n) => chosen.has(n.id)).sort((a, b) => score(b) - score(a)).slice(0, targetN);
  return { selected, totalUnique: all.length };
}

function abort(res, phase, extra = '') {
  console.error(`\n✗ 在 ${phase} 阶段中止 [${res.error?.code}] ${res.error?.message}`);
  if (res.error?.hint) console.error(`  → ${res.error.hint}`);
  if (extra) console.error(`  → ${extra}`);
  console.error('  已落盘的数据不会丢，直接重跑同一命令即可续跑。');
  process.exit(3);
}

async function detailPhase(cfg, selected, dirs) {
  let blockStreak = 0;
  let done = 0;
  for (const [i, n] of selected.entries()) {
    for (const kind of ['note', 'comments']) {
      const dir = kind === 'note' ? dirs.notes : dirs.comments;
      const okFile = join(dir, `${n.id}.json`);
      const errFile = join(dir, `${n.id}.err.json`);
      if (existsSync(okFile)) { log('detail', kind, n.id, '', 'cached', 0); continue; }
      if (existsSync(errFile) && !cfg.retryErrors) { log('detail', kind, n.id, '', 'skip-err', 0, '上次出错，--retry-errors 可重试'); continue; }
      const args = kind === 'note' ? xhs('note', n.url) : xhs('comments', n.url, '--limit', String(cfg.commentLimit), '--with-replies');
      let res = await runOpencli(args, { timeoutMs: DETAIL_TIMEOUT_MS });
      let cls = classify(res);
      if (cls === 'block') {
        if (++blockStreak >= 2) abort(res, 'detail', `连续两次触发风控，已完成 ${done}/${selected.length} 篇。请等 30 分钟以上再重跑。`);
        log('detail', kind, n.id, 0, 'block', res.elapsedMs, res.error?.message);
        await pause(BLOCK_COOLDOWN_S, BLOCK_COOLDOWN_S * 1.3, '(风控冷却)');
        res = await runOpencli(args, { timeoutMs: DETAIL_TIMEOUT_MS });
        cls = classify(res);
      }
      const count = res.ok ? (Array.isArray(res.data) ? res.data.length : 1) : 0;
      log('detail', kind, n.id, count, res.ok ? 'ok' : res.error?.code, res.elapsedMs, res.ok ? `#${i + 1} ${n.title.slice(0, 30)}` : res.error?.message);
      if (cls === 'auth' || cls === 'fatal') abort(res, 'detail');
      if (cls === 'block') abort(res, 'detail', '冷却后仍被风控，请稍后重跑。');
      if (res.ok) {
        blockStreak = 0;
        writeJson(okFile, { meta: { id: n.id, url: n.url, kind, fetched_at: nowIso(), limit: kind === 'comments' ? cfg.commentLimit : undefined }, data: res.data });
        if (existsSync(errFile)) unlinkSync(errFile);
      } else {
        writeJson(errFile, { meta: { id: n.id, url: n.url, kind, failed_at: nowIso() }, error: res.error });
      }
      await pause(3, 6);
    }
    done++;
    if (done % 10 === 0) process.stderr.write(`\n── 进度 ${done}/${selected.length} ──\n\n`);
  }
}

function summarize(dirs, selected) {
  const notesOk = existsSync(dirs.notes) ? readdirSync(dirs.notes).filter((f) => /^[a-f0-9]+\.json$/.test(f)).length : 0;
  const commentsOk = existsSync(dirs.comments) ? readdirSync(dirs.comments).filter((f) => /^[a-f0-9]+\.json$/.test(f)).length : 0;
  const notesErr = existsSync(dirs.notes) ? readdirSync(dirs.notes).filter((f) => f.endsWith('.err.json')).length : 0;
  const commentsErr = existsSync(dirs.comments) ? readdirSync(dirs.comments).filter((f) => f.endsWith('.err.json')).length : 0;
  console.error(`\n═══ 采集汇总 ═══\n  选中帖子 ${selected.length}\n  note 成功 ${notesOk}，出错 ${notesErr}\n  comments 成功 ${commentsOk}，出错 ${commentsErr}\n  数据目录 ${dirs.root}\n  日志 ${LOG_PATH}`);
  if (notesErr + commentsErr) console.error('  出错项可用 --retry-errors 重试。');
}

// ───────────────────────── main ─────────────────────────
async function main() {
  const cfg = parseArgs(process.argv.slice(2));
  const keywordsPath = resolve(cfg.keywords || join(HERE, 'keywords.json'));
  let keywords = readJson(keywordsPath);
  if (!keywords?.dimensions) throw new Error(`读取关键词失败：${keywordsPath}`);
  const root = resolve(cfg.data || join(HERE, 'data', cfg.dryRun ? 'dry-run' : 'main'));
  const dirs = { root, search: join(root, 'search'), notes: join(root, 'notes'), comments: join(root, 'comments') };
  for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
  LOG_PATH = join(root, 'run.log');
  if (!existsSync(LOG_PATH)) writeFileSync(LOG_PATH, ['ts', 'phase', 'command', 'target', 'count', 'status', 'elapsed_ms', 'note'].join('\t') + '\n');

  let targetN = SCALES[cfg.scale];
  if (cfg.dryRun) {
    const [dim, kws] = Object.entries(keywords.dimensions)[0];
    keywords = { sorts: [keywords.sorts[0]], dimensions: { [dim]: [kws[0]] } };
    cfg.searchLimit = 5; targetN = 1;
    console.error('※ dry-run：1 个关键词 × 5 条，1 篇 note + 评论，数据写到 data/dry-run/');
  }
  console.error(`▶ 采集开始 ${nowIso()}  scale=${cfg.scale} (目标 ${targetN} 篇)  data=${root}`);

  const who = await preflight();
  console.error(`✓ 已登录：${who?.username ?? '(未知用户名)'}`);

  await searchPhase(cfg, keywords, dirs);
  const { selected, totalUnique } = mergeSearch(dirs.search, keywords, targetN);
  writeJson(join(root, 'selected.json'), { meta: { generated_at: nowIso(), scale: cfg.scale, target: targetN, total_unique: totalUnique }, data: selected });
  console.error(`✓ 搜索去重后 ${totalUnique} 篇，选中 ${selected.length} 篇`);

  await detailPhase(cfg, selected, dirs);
  summarize(dirs, selected);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(`✗ ${e.message}`); process.exit(1); });
}
