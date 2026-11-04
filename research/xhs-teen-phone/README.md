# 小红书「青少年儿童手机使用」现状调研 · 采集与分析脚本

用 `opencli xiaohongshu` 批量读取与「青少年 / 儿童使用手机」相关的帖子及评论，覆盖**学习、家庭矛盾、心理问题**三个维度，产出统计与可精读的语料摘要，最终形成调研报告（见 `web-articles/小红书-青少年儿童手机使用现状调研.md`）。

## 前置条件

- 本机 Chrome 已登录小红书，并安装了 OpenCLI 的 Browser Bridge 扩展（见 `docs/guide/browser-bridge.md`）。
- `opencli` 可在终端直接运行；若用源码跑，设 `OPENCLI_BIN="node /path/to/OpenCLI/dist/src/main.js"`。
- 先看一眼命令帮助：`opencli xiaohongshu -h`、`opencli xiaohongshu search -h`、`opencli xiaohongshu comments -h`。
- 确认登录态：`opencli xiaohongshu whoami`。

## 文件

| 文件 | 作用 |
|---|---|
| `keywords.json` | 三个维度各 4 个搜索词，每个词跑 `comprehensive` 与 `most-commented` 两种排序 |
| `collect.mjs` | 采集：`whoami` 预检 → 搜索 → 按 note id 去重、按赞排序并按维度配额 → 逐篇 `note` + `comments --with-replies`；全部落盘，可断点续跑 |
| `analyze.mjs` | 合并为 `corpus.json`，输出 `stats.json`（总量 / 互动分布 / 时间分布 / 作者类型 / 学段 / 主题词频 / 评论立场）与 `corpus.md`（按互动排序的精读摘要） |
| `data/` | 原始数据，已在 `.gitignore` 里忽略，**不要提交** |

## 运行

```bash
# 1. 验证环境：1 个关键词 5 条 + 1 篇 note/评论，写到 data/dry-run/
node research/xhs-teen-phone/collect.mjs --dry-run

# 2. 正式采集（light=40 / standard=90 / deep=150 篇），写到 data/main/
node research/xhs-teen-phone/collect.mjs --scale standard

# 3. 中途被风控或中断：直接重跑同一命令会跳过已完成项；出错项加 --retry-errors
node research/xhs-teen-phone/collect.mjs --scale standard --retry-errors

# 4. 分析
node research/xhs-teen-phone/analyze.mjs --data research/xhs-teen-phone/data/main
```

标准档约 24 次搜索 + 90 篇 note + 90 次评论读取，每次之间随机停 3–6 秒，含评论区滚动，大约 40–60 分钟。期间保持 Chrome 自动化窗口可见（不要最小化），否则 `note` 可能报 `COUNTS_NOT_LOADED`。

## 风控与错误处理

- 遇到 `SECURITY_BLOCK` / 验证码 / 「访问频次异常」：脚本休眠 10 分钟后重试一次；连续两次仍被拦截则中止，请等 30 分钟以上再重跑。
- `AUTH_REQUIRED`：登录失效，运行 `opencli xiaohongshu login` 后重跑。
- `EMPTY_RESULT` / `COUNTS_NOT_LOADED` / `COMMENTS_NOT_LOADED` / 超时：记入 `<id>.err.json` 并跳过，之后用 `--retry-errors` 补抓。
- 每次调用都记在 `data/<run>/run.log`（tab 分隔：时间、阶段、命令、目标、条数、状态、耗时、备注）。

## 数据说明与局限

- `search` 的 `published_at` 是由 note id 推算的日期，`note` 不返回发布时间，`comments` 的 `time` 是页面显示的原文。
- 每篇只取前 30 条一级评论（含楼中楼），纯图片 / 表情评论会被适配器丢弃。
- `analyze.mjs` 的作者类型、学段、主题、立场都是词典粗筛，用于排序和初筛；报告结论以人工精读 `corpus.md` 为准。
- `corpus.json` 已去掉评论者主页链接、把 userId 做了哈希；报告中不出现任何用户标识。

## 常用环境变量

| 变量 | 说明 |
|---|---|
| `OPENCLI_BIN` | opencli 命令，默认 `opencli` |
| `XHS_SLEEP_SCALE` | sleep 倍率，默认 1；本地测试脚本逻辑时可设 0 |
