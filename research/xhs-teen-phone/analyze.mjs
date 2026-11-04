#!/usr/bin/env node
/**
 * 小红书「青少年儿童手机使用」调研 · 分析脚本
 *
 * 读取 collect.mjs 落盘的 data/<run>/{selected.json,notes/,comments/}，输出：
 *   data/<run>/corpus.json  帖子 + 评论合并（评论去掉 profileUrl，userId 做哈希）
 *   data/<run>/stats.json   总量、互动分布、时间分布、作者类型、学段、主题词频、评论立场
 *   data/<run>/corpus.md    按互动量排序的可读摘要，供人工 / 模型精读做定性编码
 *
 * 词典匹配只是粗筛，报告结论以精读为准。
 *
 * 用法：node analyze.mjs [--data research/xhs-teen-phone/data/main] [--top 15]
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

// ───────────────────────── 词典（粗筛） ─────────────────────────
export const AUTHOR_TYPES = [
  // 顺序即优先级；只认作者“自我身份声明”或明确的引流话术，避免把家长叙述里的“医生说”误判为专业人士
  ['机构/营销', /私信(?:我|领取|获取)|加v|vx|微信|公众号|报名|名额|扫码|领取(?:资料|课程)|训练营|特训营|戒网瘾学校|封闭学校|咨询(?:热线|电话)|一对一(?:咨询|辅导)/i],
  ['心理/医疗专业', /(?:我是|作为|本人)(?:一名|一个|一位)?[^，。！？\n]{0,8}(?:心理咨询师|心理医生|心理老师|心理治疗师|精神科医生|家庭治疗师|心理学(?:博士|硕士|工作者))|从业\d+年|执业(?:心理|医师)|接待过\d+/],
  ['教师/教育从业者', /(?:我是|作为|本人)(?:一名|一个|一位)?[^，。！？\n]{0,8}(?:老师|教师|班主任|教育工作者|家庭教育指导师)|教龄|我的学生|我班(?:上|里)/],
  ['学生本人', /(?:我是|作为|本人)(?:一名|一个)?[^，。！？\n]{0,6}(?:学生|中生|年级)|我今年1\d岁|作为孩子|我(?:妈|爸|父母|爸妈)(?:不让|没收|收了|把我|天天骂|总是)|我就是那个孩子/],
  ['家长自述', /我(?:家|儿子|女儿|娃|孩子|闺女|大宝|二宝)|当妈|当爸|作为(?:妈妈|爸爸|母亲|父亲|家长)|老母亲|老父亲|孩子他(?:爸|妈)/],
];
export const STAGES = [
  ['学龄前', /幼儿园|学龄前|(?<!\d)[3-6]岁|三岁|四岁|五岁|六岁/],
  ['小学', /小学|一年级|二年级|三年级|四年级|五年级|六年级|(?<!\d)(?:[7-9]|1[0-2])岁|七岁|八岁|九岁|十岁|十一岁|十二岁/],
  ['初中', /初中|初一|初二|初三|七年级|八年级|九年级|中考|(?<!\d)1[3-5]岁|十三岁|十四岁|十五岁/],
  ['高中', /高中|高一|高二|高三|高考|(?<!\d)1[6-8]岁|十六岁|十七岁|十八岁/],
  ['大学及以上', /大学|大一|大二|大三|大四|研究生/],
];
export const THEMES = {
  '学习': {
    '成绩下滑': /成绩(?:下降|下滑|退步|一落千丈|越来越差|掉)|考砸|倒数|不及格/,
    '作业拖延': /作业|磨蹭|拖延|拖拉/,
    '注意力': /注意力|专注|分心|走神|专注力|上课(?:睡觉|玩)/,
    '网课/学习用途': /网课|查资料|学习软件|搜题|线上课|作业帮|小猿|用手机学习|查单词/,
    '学校政策': /学校(?:不让|禁止|没收|管)|带手机|手机管理|禁手机|校规/,
    '熬夜/睡眠': /熬夜|通宵|睡眠|晚睡|凌晨|半夜|偷偷玩|躲被窝/,
    '升学压力': /中考|高考|升学|分数|排名|压力/,
  },
  '家庭矛盾': {
    '没收/断网': /没收|收走|收手机|锁起来|断网|停网|改密码|拿走手机|收了手机/,
    '争吵': /吵架|争吵|大吵|吼|骂|对骂|冲突|顶嘴|翻脸/,
    '肢体冲突/砸': /砸|打他|打了|动手|摔|扇|揍|打孩子|挨打/,
    '冷战/关门': /冷战|不说话|不理|关门|锁门|不出房间|不搭理/,
    '极端威胁': /离家出走|跳楼|自杀|威胁|绝食|不活了|割/,
    '父母分歧': /老公|孩子他爸|孩子爸|队友|意见不一|不管孩子|丧偶式|爸爸(?:不管|只会)|妈妈(?:太|总)/,
    '祖辈': /爷爷|奶奶|外婆|外公|姥姥|姥爷|老人带|隔代/,
    '亲子关系': /亲子关系|信任|沟通|陪伴|关系(?:破裂|紧张|变差|僵)|心结|隔阂/,
  },
  '心理': {
    '焦虑': /焦虑|紧张|担心|害怕|恐慌|睡不着/,
    '抑郁': /抑郁|情绪低落|没有动力|躺平|绝望|无意义|消沉/,
    '厌学/休学': /厌学|不想上学|不去学校|休学|辍学|不肯上学|拒学/,
    '自伤': /自残|自伤|割腕|轻生|自杀|不想活/,
    '情绪失控': /情绪失控|崩溃|暴躁|易怒|发脾气|摔东西|歇斯底里|暴怒/,
    '社交回避': /社恐|不出门|不社交|封闭|不愿意出门|不跟人说话|躲在房间/,
    '成瘾表述': /成瘾|上瘾|沉迷|依赖|戒不掉|控制不住|停不下来|网瘾/,
    '就医/诊断': /医院|精神科|心理科|确诊|吃药|诊断|量表|住院/,
  },
};
export const STRATEGIES = {
  '约定/契约': /约定|契约|协议|规则|时间表|定时|每天(?:半小时|一小时|\d+分钟)|限时|规定时间/,
  '替代活动': /运动|户外|阅读|看书|兴趣|旅行|打球|跑步|露营|画画|乐器/,
  '家长示范': /以身作则|自己也(?:玩|刷)|放下手机|榜样|家长先|父母先/,
  '技术管控': /管控软件|青少年模式|屏幕使用时间|家长模式|监控|定位|儿童手表|老年机|功能机|断网/,
  '没收/强制': /没收|收走|锁起来|强制|砸了|不给买|不给手机/,
  '心理咨询/专业': /心理咨询|咨询师|心理医生|专业(?:人士|帮助)|家庭治疗|就医/,
  '放手/信任': /放手|信任|自主|尊重|不管了|让他自己|自己管理|自律/,
  '戒网瘾机构': /戒网瘾|训练营|特训|封闭学校|军事化|矫正/,
  '沟通/倾听': /沟通|倾听|聊一聊|共情|理解他|站在孩子|好好说|谈心/,
  '延迟给手机': /不给买|高中(?:再|以后)|大学(?:再|以后)|晚点给|推迟|不碰手机|不接触/,
};
export const STANCES = {
  '求助/共鸣': /我家也|同款|一样|怎么办|求(?:助|方法|支招)|也是这样|太真实|说的就是我|同感|抱抱/,
  '支招/经验': /建议|可以试试|我们家是|方法|办法|试试|我是这样|经验|后来我/,
  '归因家长': /家长的问题|父母的问题|你自己|先反思|控制欲|打压|家长(?:先|也|自己)|大人|你们(?:大人|家长)|不是孩子的错/,
  '支持严管': /惯的|打一顿|没收|不惯着|该打|狠心|不能惯|必须管|手机就是毒/,
  '孩子视角': /我是(?:学生|初中生|高中生|小学生)|作为孩子|我就是那个孩子|我(?:妈|爸|父母)(?:也|就|总是|天天)|我今年1\d岁|我们这代/,
  '专业/引流': /私信|咨询|加v|vx|微信|课程|报名|公众号|详细(?:聊|说)|可以聊聊|主页|老师/,
  '反对手机归因': /不是手机的问题|手机只是|问题不在手机|根源|替罪羊|背锅/,
};

// ───────────────────────── helpers ─────────────────────────
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const hashId = (s) => (s ? createHash('sha256').update(String(s)).digest('hex').slice(0, 8) : '');
export function parseCount(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (v == null) return 0;
  const s = String(v).trim().replace(/,/g, '');
  const m = s.match(/^(\d+(?:\.\d+)?)\s*(万|w|k|千)?/i);
  if (!m) return 0;
  const n = parseFloat(m[1]); const u = (m[2] || '').toLowerCase();
  return Math.round(u === '万' || u === 'w' ? n * 10000 : (u === 'k' || u === '千' ? n * 1000 : n));
}
const quantiles = (arr) => {
  const a = [...arr].sort((x, y) => x - y);
  if (!a.length) return { n: 0 };
  const q = (p) => a[Math.min(a.length - 1, Math.floor(p * (a.length - 1)))];
  return { n: a.length, min: a[0], p25: q(0.25), median: q(0.5), p75: q(0.75), max: a[a.length - 1], sum: a.reduce((s, x) => s + x, 0), mean: Math.round(a.reduce((s, x) => s + x, 0) / a.length) };
};
const matchLabels = (text, dict) => Object.entries(dict).filter(([, re]) => re.test(text)).map(([k]) => k);
const classifyAuthor = (text) => { for (const [label, re] of AUTHOR_TYPES) if (re.test(text)) return label; return '家长自述'; };
const inc = (obj, k, by = 1) => { obj[k] = (obj[k] || 0) + by; };
const sortedObj = (o) => Object.fromEntries(Object.entries(o).sort((a, b) => b[1] - a[1]));
const trunc = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };

// ───────────────────────── load ─────────────────────────
export function loadCorpus(root) {
  const selected = readJson(join(root, 'selected.json')).data;
  const corpus = [];
  for (const n of selected) {
    const noteFile = join(root, 'notes', `${n.id}.json`);
    const cmtFile = join(root, 'comments', `${n.id}.json`);
    const note = existsSync(noteFile) ? readJson(noteFile) : null;
    const cmts = existsSync(cmtFile) ? readJson(cmtFile) : null;
    const fields = {};
    for (const row of note?.data || []) fields[row.field] = row.value;
    const comments = (cmts?.data || []).map((c) => ({
      rank: c.rank, author: c.author || '', author_hash: hashId(c.userId || c.author), text: c.text || '', likes: parseCount(c.likes),
      time: c.time || '', is_reply: Boolean(c.is_reply), reply_to: c.reply_to || '', has_images: Array.isArray(c.images) && c.images.length > 0,
    }));
    corpus.push({
      id: n.id, url: n.url, title: fields.title || n.title || '', author: fields.author || n.author || '', author_url: n.author_url || '',
      dimensions: n.dimensions || [], keywords: [...new Set((n.hits || []).map((h) => h.keyword))], hits: n.hits || [],
      likes: fields.likes != null ? parseCount(fields.likes) : n.likes, collects: parseCount(fields.collects), comment_count: parseCount(fields.comments),
      published_at: n.published_at || '', content: fields.content || '', tags: fields.tags ? String(fields.tags).split(/,\s*/).filter(Boolean) : [],
      has_note: Boolean(note), has_comments: Boolean(cmts), comments,
    });
  }
  return corpus;
}

// ───────────────────────── stats ─────────────────────────
export function computeStats(corpus, { top = 15 } = {}) {
  const notesWithContent = corpus.filter((n) => n.has_note);
  const allComments = corpus.flatMap((n) => n.comments.map((c) => { c.note_id = n.id; return c; }));
  const stats = {
    generated_at: new Date().toISOString(),
    totals: {
      notes_selected: corpus.length, notes_with_content: notesWithContent.length, notes_with_comments: corpus.filter((n) => n.has_comments).length,
      comments_total: allComments.length, comments_top_level: allComments.filter((c) => !c.is_reply).length, comments_replies: allComments.filter((c) => c.is_reply).length,
      comment_count_declared_sum: corpus.reduce((s, n) => s + n.comment_count, 0),
    },
    engagement: { likes: quantiles(corpus.map((n) => n.likes)), collects: quantiles(notesWithContent.map((n) => n.collects)), comment_count: quantiles(notesWithContent.map((n) => n.comment_count)), comment_likes: quantiles(allComments.map((c) => c.likes)) },
    published_by_month: {}, published_by_year: {},
    dimension_notes: {}, dimension_overlap: {}, keyword_hits: {},
    author_types: {}, stages: {}, stage_by_dimension: {},
    themes_in_notes: {}, themes_in_comments: {}, strategies_in_notes: {}, strategies_in_comments: {},
    comment_stances: {}, comment_stance_share: {}, comments_with_images: allComments.filter((c) => c.has_images).length,
    marketing: { notes_marketing: 0, comments_marketing: 0 },
    top_notes_by_likes: [], top_notes_by_comments: [], top_comments_by_likes: [],
  };
  for (const n of corpus) {
    const ym = n.published_at.slice(0, 7); if (ym) { inc(stats.published_by_month, ym); inc(stats.published_by_year, ym.slice(0, 4)); }
    for (const d of n.dimensions) inc(stats.dimension_notes, d);
    inc(stats.dimension_overlap, n.dimensions.slice().sort().join('+') || '(无)');
    for (const k of n.keywords) inc(stats.keyword_hits, k);
    const text = `${n.title}\n${n.content}\n${n.tags.join(' ')}`;
    const atype = classifyAuthor(`${n.author}\n${text}`); n.author_type = atype; inc(stats.author_types, atype);
    if (atype === '机构/营销') stats.marketing.notes_marketing++;
    const stages = STAGES.filter(([, re]) => re.test(text)).map(([s]) => s); n.stages = stages.length ? stages : ['未提及'];
    for (const s of n.stages) { inc(stats.stages, s); for (const d of n.dimensions) { stats.stage_by_dimension[d] ??= {}; inc(stats.stage_by_dimension[d], s); } }
    n.themes = {};
    for (const [dim, dict] of Object.entries(THEMES)) { const hit = matchLabels(text, dict); n.themes[dim] = hit; stats.themes_in_notes[dim] ??= {}; for (const h of hit) inc(stats.themes_in_notes[dim], h); }
    n.strategies = matchLabels(text, STRATEGIES); for (const s of n.strategies) inc(stats.strategies_in_notes, s);
  }
  for (const c of allComments) {
    const t = c.text;
    for (const [dim, dict] of Object.entries(THEMES)) { stats.themes_in_comments[dim] ??= {}; for (const h of matchLabels(t, dict)) inc(stats.themes_in_comments[dim], h); }
    for (const s of matchLabels(t, STRATEGIES)) inc(stats.strategies_in_comments, s);
    const st = matchLabels(t, STANCES); c.stances = st.length ? st : ['其它/闲聊']; for (const s of c.stances) inc(stats.comment_stances, s);
    if (st.includes('专业/引流')) stats.marketing.comments_marketing++;
  }
  for (const k of Object.keys(stats.comment_stances)) stats.comment_stance_share[k] = allComments.length ? +(stats.comment_stances[k] / allComments.length * 100).toFixed(1) : 0;
  for (const k of ['published_by_month', 'dimension_notes', 'dimension_overlap', 'keyword_hits', 'author_types', 'stages', 'strategies_in_notes', 'strategies_in_comments', 'comment_stances']) stats[k] = sortedObj(stats[k]);
  for (const dim of Object.keys(THEMES)) { stats.themes_in_notes[dim] = sortedObj(stats.themes_in_notes[dim] || {}); stats.themes_in_comments[dim] = sortedObj(stats.themes_in_comments[dim] || {}); }
  const brief = (n) => ({ id: n.id, title: trunc(n.title, 40), author_type: n.author_type, likes: n.likes, collects: n.collects, comment_count: n.comment_count, published_at: n.published_at, dimensions: n.dimensions, url: n.url });
  stats.top_notes_by_likes = [...corpus].sort((a, b) => b.likes - a.likes).slice(0, top).map(brief);
  stats.top_notes_by_comments = [...corpus].sort((a, b) => b.comment_count - a.comment_count).slice(0, top).map(brief);
  stats.top_comments_by_likes = [...allComments].sort((a, b) => b.likes - a.likes).slice(0, top).map((c) => ({ note_id: c.note_id, likes: c.likes, is_reply: c.is_reply, stances: c.stances, text: trunc(c.text, 120) }));
  return stats;
}

// ───────────────────────── corpus.md ─────────────────────────
export function renderCorpusMd(corpus, stats) {
  const out = [];
  out.push(`# 语料摘要（${corpus.length} 篇，按点赞排序）`, '', `生成时间 ${stats.generated_at}。评论者以哈希代称，不含主页链接。`, '');
  const sorted = [...corpus].sort((a, b) => b.likes - a.likes);
  sorted.forEach((n, i) => {
    out.push(`## ${i + 1}. ${n.title || '(无标题)'}`, '');
    out.push(`- id \`${n.id}\` · 维度 ${n.dimensions.join('/')} · 作者类型 ${n.author_type} · 学段 ${n.stages.join('/')} · 发布 ${n.published_at || '?'}`);
    out.push(`- 赞 ${n.likes} · 收藏 ${n.collects} · 评论数 ${n.comment_count}（抓到 ${n.comments.length}）· 命中关键词 ${n.keywords.join('；')}`);
    const th = Object.entries(n.themes).filter(([, v]) => v.length).map(([d, v]) => `${d}:${v.join(',')}`).join(' | ');
    if (th) out.push(`- 主题词 ${th}`);
    if (n.strategies.length) out.push(`- 策略词 ${n.strategies.join(',')}`);
    if (n.tags.length) out.push(`- 标签 ${n.tags.join(' ')}`);
    out.push('', `> ${trunc(n.content, 700) || '(未抓到正文)'}`, '');
    const cs = [...n.comments].sort((a, b) => b.likes - a.likes).slice(0, 12);
    if (cs.length) { out.push('评论（按赞排序，前 12 条）：', ''); for (const c of cs) out.push(`- [${c.likes}赞${c.is_reply ? '·回复' : ''}] (${c.author_hash}) ${trunc(c.text, 220)}  ⟨${c.stances.join(',')}⟩`); out.push(''); }
  });
  return out.join('\n');
}

// ───────────────────────── main ─────────────────────────
function main() {
  const argv = process.argv.slice(2);
  let root = join(HERE, 'data', 'main'); let top = 15;
  for (let i = 0; i < argv.length; i++) { if (argv[i] === '--data') root = argv[++i]; else if (argv[i] === '--top') top = Number(argv[++i]); }
  root = resolve(root);
  if (!existsSync(join(root, 'selected.json'))) { console.error(`✗ 找不到 ${join(root, 'selected.json')}，先运行 collect.mjs`); process.exit(1); }
  const corpus = loadCorpus(root);
  const stats = computeStats(corpus, { top });
  writeFileSync(join(root, 'corpus.json'), JSON.stringify(corpus, null, 2));
  writeFileSync(join(root, 'stats.json'), JSON.stringify(stats, null, 2));
  writeFileSync(join(root, 'corpus.md'), renderCorpusMd(corpus, stats));
  const t = stats.totals;
  console.error(`✓ corpus.json / stats.json / corpus.md 已写到 ${root}\n  帖子 ${t.notes_selected}（有正文 ${t.notes_with_content}，有评论 ${t.notes_with_comments}）· 评论 ${t.comments_total}（一级 ${t.comments_top_level}，回复 ${t.comments_replies}）`);
  console.error(`  维度：${JSON.stringify(stats.dimension_notes)}\n  作者类型：${JSON.stringify(stats.author_types)}\n  学段：${JSON.stringify(stats.stages)}`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
