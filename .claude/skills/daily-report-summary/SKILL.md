---
name: daily-report-summary
description: 从 git 历史生成「今日大事早知道」开发日报，并发布到知识库（文档空间）。按「新增功能多讲 → 优化/修复次之 → 计划/遗留垫底」的固定权重分层叙事。自动 find-or-create「日报知识库」并出分享链。触发词："生成日报"、"写日报"、"今日大事"、"日报"、"daily report"、"/daily"、"今天干了啥"。
---

# Daily Report Summary — 今日大事早知道

每天从 git 历史收集当日落地的改动，按**固定权重分层**写成一篇可读日报，并发布到知识库。

> 与 `weekly-update-summary`（周报）互补：周报按 ISO 周 + PR 边界统计，落 `doc/report.YYYY-WXX.md`；日报按**单日提交日期文本**统计，落**知识库条目**（不进 `doc/`），主打「今天大事早知道」的早读体验。
>
> 行业参照（`/find-skills` 调研）：公开生态里最流行的是「standup / 站会」格式（如 `googleworkspace/cli@gws-workflow-standup-report`，16K+ 安装），三段式「昨天做了/今天做/卡点」。本技能借鉴其「卡点（blockers）前置可见」的优点，但把叙事重心放在**当日实际落地的价值**上，而非待办计划，更贴合「日报回顾」而非「站会播报」。

## 核心纪律（必须遵守）

### 纪律 1：分层权重固定 —— 新增多讲，优化/修复次之，计划/遗留垫底

报告正文章节顺序与篇幅权重**写死**，不允许按当天提交数量临时调整：

| 层级 | 内容 | 篇幅权重 | 写法要求 |
|------|------|----------|----------|
| 1. 今日大事（TL;DR） | 3-6 条一句话亮点 | 短 | 用户视角，非技术术语 |
| 2. 新增方向（feat） | 当日新功能/新能力 | **最重（每条展开 3-5 句）** | 讲清「是什么 + 解决什么 + 用户怎么用」 |
| 3. 优化（perf/refactor/style/体验） | 既有功能打磨 | 中（每条 1-2 句） | 聚类成主题，不逐条流水 |
| 4. 修复（fix） | bug/审查修复 | 中（聚类计数 + 重点点名） | 安全/数据类单独点名，UI 竞态类合并计数 |
| 5. 计划与遗留 | 未完成/已知边界/下一步 | 短，**置于最后** | 从 `debt.*` + commit 中的 TODO/遗留提取 |

> 禁止把修复写在新增前面，禁止因为「今天修的多」就让修复段落喧宾夺主。

### 纪律 2：时间边界按「提交日期文本」判断，不做时区换算

与周报技能一致：用 `%cd --date=short` 输出 `YYYY-MM-DD`，只按这个日期文本过滤当天提交。**不要**用 `--since/--until` 让 Git 按提交自带时区解析（会把跨午夜的提交卷错天）。

```bash
TODAY=${1:-$(date +%Y-%m-%d)}   # 可传入目标日期，缺省今天
git log --format="%cd%x09%H%x09%an%x09%s" --date=short | awk -F '\t' -v d="$TODAY" '$1==d'
```

### 纪律 3：默认主干为主，但合并日 ≠ 提交日时要穿透 PR

主仓库常见「feature 分支当天提交、当天/隔天 merge 到 main」。先取主干当日提交；若发现当天有 merge commit，用 `git log <merge>^1..<merge>^2 --oneline` 穿透读 PR 真实 commits，以 commit 内容（而非 merge 标题）判断主题归属。**禁止**只读 merge 标题就归类。

### 纪律 4：标题固定格式，库固定名

- 知识库名：`日报知识库`（find-or-create，缺则建，isPublic=false 私有）
- 条目标题：`日报-YYYY-MM-DD-今日大事早知道`
- 正文以 `# {标题}` H1 打头（根治分享阅读器目录 `---`）

### 纪律 5：数字必须来自 git，不估算；空日不硬凑

所有计数（提交数、各类型分布、贡献者）必须来自 git 命令输出。若当日零提交，明确写「今日主干无落地提交」并停止，不要硬凑内容。

## 触发词

"生成日报" / "写日报" / "今日大事" / "今日大事早知道" / "日报" / "daily report" / "/daily" / "今天干了啥"

---

## 执行流程

### Phase 1：确定目标日期

```bash
TODAY=${ARG_DATE:-$(date +%Y-%m-%d)}
```
用户可指定日期（如「补 5-30 的日报」）；缺省取今天。

### Phase 2：数据收集（按纪律 2/3）

```bash
# 2.1 当日全部提交（含各分支落地的，主干口径为主）
git log --format="%cd%x09%h%x09%an%x09%s" --date=short | awk -F '\t' -v d="$TODAY" '$1==d'

# 2.2 当日提交类型分布（按 Conventional Commits 前缀）
#   feat / fix / perf / refactor / style / docs / chore / test
git log --format="%cd%x09%s" --date=short | awk -F '\t' -v d="$TODAY" '$1==d{print $2}' \
  | grep -oE '^(feat|fix|perf|refactor|style|docs|chore|test)' | sort | uniq -c

# 2.3 穿透当日 merge commit（取 PR 真实 commits）
git log --merges --format="%cd%x09%H%x09%s" --date=short | awk -F '\t' -v d="$TODAY" '$1==d{print $2}' \
  | while read m; do echo "== PR merge $m =="; git log "$m^1..$m^2" --oneline 2>/dev/null; done

# 2.4 贡献者
git log --format="%cd%x09%an" --date=short | awk -F '\t' -v d="$TODAY" '$1==d{print $2}' | sort | uniq -c
```

### Phase 3：聚类与分层

1. 把当日 commit 按**主题**（不是按文件）聚成 5-10 条脉络
2. 每条脉络判定归属层级（新增/优化/修复），打上权重
3. 新增方向逐条展开（是什么+解决什么+怎么用）
4. 优化、修复按主题聚类，修复段做计数 + 安全/数据类点名
5. 从 `doc/debt.*.md` 与 commit 里的「遗留/TODO/未实现」提取「计划与遗留」

### Phase 4：生成报告正文

按 `reference/report-template.md` 模板组织（分层权重见纪律 1）。语言全中文，用户视角，禁止 emoji（CLAUDE.md 规则 0）。

### Phase 5：发布到知识库

调 `reference/publish.py` 完成 find-or-create「日报知识库」+ 建条目 + 写正文 + 出分享链：

```bash
export AI_ACCESS_KEY=...            # 已在 CDS 远端环境注入
python3 .claude/skills/daily-report-summary/reference/publish.py \
  --base https://main-prd-agent.miduo.org \
  --impersonate inernoro \
  --title "日报-${TODAY}-今日大事早知道" \
  --report-md /tmp/daily-${TODAY}.md
```

鉴权优先级（同 create-visual-test-to-kb）：
- 优先 `DAILY_DOC_STORE_KEY=sk-ak-*`（带 `document-store:write` scope 的最小权限长效 Key）→ `Authorization: Bearer`
- 回退 `AI_ACCESS_KEY` 超级密钥 + `X-AI-Impersonate: <user>`

发布成功后必须向用户回报：知识库名 + 条目标题 + 分享链（`/s/lib/{token}?entry={eid}`）+ owner 登录路径。

### Phase 6：输出

```
日报已发布：
【知识库】日报知识库（私有）
【标题】日报-2026-05-31-今日大事早知道
【分享链】https://<base>/s/lib/<token>?entry=<eid>
【Owner】登录后 知识库 → 「日报知识库」→ 本篇

今日概要：N 次提交，feat M / fix K / perf P，Top 新增：……
```

## 边界情况

| 场景 | 处理 |
|------|------|
| 当日零提交 | 写「今日主干无落地提交」，不发布空报告 |
| 预览环境 524 / 不可达 | 正文已就绪，提示稍后用同命令重跑（publish.py 自带退避重试 + 空壳兜底） |
| 「日报知识库」已存在 | 复用，不重复建；同日重复发布会生成新条目（标题相同，metadata.dailyDate 去重可选） |
| 没有 AI 密钥 / 无文档空间 | 退化为 `--local` 落 `doc/` 外的本地 md（仅自查，不算交付） |

## 注意事项

1. 报告语言全中文，价值主张从用户视角写，PR 英文标题翻译为简洁中文
2. 严格遵守分层权重（纪律 1）：新增多讲，优化/修复次之，计划/遗留垫底
3. 禁止 emoji（CLAUDE.md 规则 0）
4. 数字必须来自 git 输出（纪律 5）
5. 知识库默认私有；分享链对「拿到链接者」开放，非殿堂（isPublic=true 对所有人）
