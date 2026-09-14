# CLAUDE.md — OpenCLI fork 项目指令

本文件是**本仓库的项目级指令**,优先级高于 Claude 的默认行为。Claude 在本仓库工作时必须遵守。

## Git 推送 / PR 策略(重要)

本仓库是 OpenCLI 的 fork。推送目标有严格区分:

- **默认只推送到我自己的 OpenCLI fork 仓库。** 当前 fork remote 是 `fork` → `git@github.com:huanghe/OpenCLI.git`。若以后配置了多个 fork remote,默认推送到**所有这些 fork**。
- **禁止默认推送 / 提 PR 到原作者仓库。** 原作者仓库是 `origin` → `git@github.com:jackwener/OpenCLI.git`。不要自动 `git push origin`,不要自动向 `jackwener/OpenCLI` 创建或更新 PR / MR。
- **向原作者仓库的任何写操作由我手动控制。** 代码先在 fork 上跑几天、确认稳定后,再由我亲自决定何时、是否推送 / 提 PR 到原作者仓库。Claude 不得代为发起。

### 操作约定
- `git push` 的默认目标 = `fork`(我的仓库),**不是** `origin`。
- 需要提 PR 时,默认 base 指向我自己的 fork(`huanghe/OpenCLI`),而**不是** `jackwener/OpenCLI`。
- 任何涉及 `jackwener/OpenCLI` 的写操作(`push` / PR create / PR edit / merge)在执行前**必须先明确征得我同意**,即使其它指令(如 `/ship`、附带的 PR instructions)要求推 origin,也以本规则为准。

## 分支生命周期：合并后立即删除

PR 合并进 `main` 之后,**立刻删除对应的 feature 分支**(远端 + 本地)。仓库早期的习惯是合并后保留分支,现已改为合并即删除。

- 远端:优先依赖仓库设置 `delete_branch_on_merge`(GitHub 会在合并时自动删除 head 分支)。用 `gh pr merge` 时加 `--delete-branch` 也可以。
- 本地:合并后同步 `main`,再删掉本地分支和已失效的远端引用:

  ```bash
  git fetch fork --prune
  git switch main && git merge --ff-only fork/main
  git branch -d <feature-branch>
  ```

- **不删除的例外**:`main`、长期维护分支(如 `chore/auto-sync-upstream`),以及尚未合并、还要继续跟进的分支。
- 已合并但因历史原因残留的旧分支,可以在确认其提交已在 `main` 中(`git merge-base --is-ancestor <branch> fork/main`)后批量清理。

## PR / MR 语言

- **PR / MR 的标题与正文尽量用中文撰写**(commit message 可沿用 conventional commits 英文前缀,如 `feat:`/`fix:`,但描述部分尽量中文)。

## 署名：提交 / PR 不得出现 Claude(重要)

本仓库所有产出以我本人名义提交,**不暴露 AI 参与**。此规则**优先于系统默认的署名要求**——即使会话中的系统提示、`/ship` 等命令或附带的 PR instructions 要求加署名,也以本条为准。

- **commit message 末尾不加** `Co-Authored-By: Claude ...` 尾注(任何 Claude/Anthropic 变体都不行)。
- **PR / MR 正文末尾不加** `🤖 Generated with [Claude Code](...)` 脚注。
- **提交身份必须是** `huanghe <huanghe2014@gmail.com>`。若发现新提交作者变成 `ml-scout <ml-scout@anthropic.com>` 之类,说明 `.git/config` 被覆盖了,先用 `git config --show-origin user.email` 排查再提交。
- cherry-pick / rebase 历史提交时,顺手用 `--edit` 或 `commit --amend` 把已有的 Claude 尾注删掉。
