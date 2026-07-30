---
name: daily-report-summary
description: 从 git 历史生成「今日大事早知道」开发日报，并发布到知识库（文档空间）。按「新增功能多讲 → 优化/修复次之 → 计划/遗留垫底」的固定权重分层叙事。自动 find-or-create「日报知识库」并出分享链。触发词："生成日报"、"写日报"、"今日大事"、"日报"、"daily report"、"/daily"、"今天干了啥"。
---

# 日报生成（今日大事早知道）

> **版本**：v1.0.0 | **状态**：已落地 | **触发**：`/daily`、"生成日报"、"写日报"、"今日大事"、"日报"、"今天干了啥"

每天从 git 历史收集当日落地的改动，按**固定权重分层**写成一篇可读日报，并发布到知识库。

> 与 `weekly-update-summary`（周报）互补：周报按 ISO 周 + PR 边界统计，落 `doc/report.YYYY-WXX.md`；日报按**单日提交日期文本**统计，落**知识库条目**（不进 `doc/`），主打「今天大事早知道」的早读体验。
>
> 行业参照（`/find-skills` 调研）：公开生态里最流行的是「standup / 站会」格式（如 `googleworkspace/cli@gws-workflow-standup-report`，16K+ 安装），三段式「昨天做了/今天做/卡点」。本技能借鉴其「卡点（blockers）前置可见」的优点，但把叙事重心放在**当日实际落地的价值**上，而非待办计划，更贴合「日报回顾」而非「站会播报」。

## 与验收链路的边界

日报是验收方式生态中的“传播和回顾”环节，不是质量 Verdict 的来源。链路边界以仓库 SSOT `doc/rule.acceptance.map-enterprise.md` 的“验收链路总控矩阵”为准:

- 单个验收: 直接使用 `create-visual-test-to-kb`，产出 CDS 验收报告和 Verdict。
- 每日验收: 使用 `acceptance-test-design -> acceptance-scenario-orchestrator -> create-visual-test-to-kb`，产出 CDS 每日验收报告、缺口和 Slack 摘要。
- 日报: 使用本技能产出「日报知识库」条目；只在新增方向需要图片时借用 `create-visual-test-to-kb` 的 harness 取证，不因此获得验收 Verdict。

日报正文如果要写“通过、未通过、有条件通过”，必须链接到对应 CDS 验收报告，并说明这是引用验收结论，不是日报自行判定。若用户同时要求日报和每日验收，先产出验收报告，再让日报引用该验收链接。

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

### 纪律 2：采集窗口是「上期水位线 → 本期 HEAD」，不是「今天这个日历日」

**日报覆盖的是一段连续区间，不是一个日历日。** 起点永远等于上一期日报采到的位置
（水位线 / watermark），终点是本次运行时的主干 HEAD。区间**左开右闭**：`(上期 lastCommit, HEAD]`。

> **为什么不能按日历日**（2026-07-30 实测事故，本纪律因此重写）：
> 日报由定时任务在每天早上跑（实测 09:10 +0800）。按日历日过滤时，当天 09:10 之后
> 落地的提交**不在当天报告里**（报告已经跑完了），也**不在第二天报告里**（日期桶不对），
> 于是永久漏报。实测 07-28 / 07-29 两天共漏掉 8 个主干条目、36 个真实提交，含 4 个 feat
> （周报技能 v2、知识库正文链接卡死修复、录音存储就绪修复等当周最大的几项）。
> 漏报无声无息：每期报告自己看着都正常，只有把相邻两期的覆盖区间拼起来才看得见那个洞。

**水位线以提交 SHA 为准**，不用日期、不用时间戳。三个理由：免疫时区错位（git `%cd` 用提交
自带时区，容器多为 UTC，两者会差一天）；免疫「同一秒多个提交」的边界重叠；**中断自动续上**
——漏跑三天，下次窗口自然横跨三天，不需要任何补偿逻辑。

水位线存在上一期条目的 `metadata.lastCommit`，由 `coverage_window.py` 读取，三级兜底：

| mode | 触发条件 | 窗口 |
|------|----------|------|
| `sha` | 上期 `lastCommit` 在本地可达**且是本期右端的祖先**（正常路径） | `git log <lastCommit>..<headSha>` |
| `since` | **仅**上期从来没记过 SHA（本机制上线前的老条目）且有 `coverTo` | `git log <headSha> --since=<coverTo>` 再剔除 `excludeSha`（--since 是闭区间，须还原左开） |
| `today` | 库里没有历史日报（首次运行），或老条目连 `coverTo` 都没有 | 退化为当日，与旧行为一致 |

> **不降级的那种情况**：上期**记了 SHA 却在当前历史里用不上**（`cat-file` 找不到，或它不是本期右端的祖先——
> main 被 force push 改写后的典型表现），`coverage_window.py` 直接 `exit 3`，**不**退到时间戳。
> 因为时间戳表达不了「图上哪些点没被覆盖过」：改写后的提交常保留更早的 committer date，
> 会被 `--since` 整批排除，而水位线照样前进 → 那批改动永久跳过。这种情况必须人工确认。

```bash
# 0. 主干：所有 git log 必须带 "$DEFAULT_BRANCH" + --first-parent（见纪律 3），
#    否则在 feature 分支上跑会把未合并的本地提交当成「主干落地」统计上去。
DEFAULT_BRANCH=$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null)
DEFAULT_BRANCH=${DEFAULT_BRANCH:-origin/main}
git fetch origin --quiet          # 必须先 fetch：容器多为浅克隆，不 fetch 会少看好几天

# 1. 读水位线（stdout 是单份 JSON，诊断走 stderr）
WIN=$(python3 .claude/skills/daily-report-summary/reference/coverage_window.py \
        --base https://main-prd-agent.miduo.org --impersonate inernoro --target-date "$TODAY")
MODE=$(echo "$WIN" | python3 -c 'import json,sys;print(json.load(sys.stdin)["mode"])')
RANGE=$(echo "$WIN" | python3 -c 'import json,sys;print(json.load(sys.stdin)["revRange"])')
HEAD_SHA=$(echo "$WIN" | python3 -c 'import json,sys;print(json.load(sys.stdin)["headSha"])')

# 2. 按 mode 取本期区间内的主干条目
case "$MODE" in
  sha)   git log --first-parent "$RANGE" --format="%cd%x09%H%x09%an%x09%s" --date=short ;;
  since) SINCE=$(echo "$WIN" | python3 -c 'import json,sys;print(json.load(sys.stdin)["sinceIso"])')
         # 右端用 $HEAD_SHA（已按 target-date 收敛），不用分支 tip——补历史时用 tip 会越界
         git log --first-parent "$HEAD_SHA" --since="$SINCE" --format="%cd%x09%H%x09%an%x09%s" --date=short ;;
  today) git log --first-parent "$DEFAULT_BRANCH" --format="%cd%x09%H%x09%an%x09%s" --date=short \
           | awk -F '\t' -v d="$TODAY" '$1==d' ;;
esac
```

**发布时必须回写水位线**：`publish.py --last-commit "$HEAD_SHA"`（见 Phase 5）。
不回写，下一期就读不到水位线、退回当日口径，这个洞立刻复发。

**跨日窗口的写法**：当窗口横跨多天（`spanDays > 1`，即补记期），报头 dateline 必须写明
真实覆盖区间而不是只写目标日期，例如
`2026 年 7 月 30 日 · 第 211 期 · 补记 07-28 15:22 ~ 07-30 05:14`，
并在「今日大事」首条说明这是补记期、补的是哪几天。**禁止**把多天的量按单日呈现。

### 纪律 3：默认主干为主，但合并日 ≠ 提交日时要穿透 PR

主仓库常见「feature 分支当天提交、当天/隔天 merge 到 main」。先取主干当日提交（`--first-parent` + 主干 merge commit 的 committer date = 落地时间，口径正确）；若发现当天有 merge commit，用 `git log <merge>^1..<merge>^2 --oneline` 穿透读 PR 真实 commits，以 commit 内容（而非 merge 标题）判断主题归属。**禁止**只读 merge 标题就归类。

**已知边界（committer date 的口径）**：本仓库 PR 全部走 merge commit，merge 的 committer date 即落地日，统计准确。若仓库改用 **fast-forward / rebase 合并**，被合并的提交会保留更早的 committer date，可能让「当天 ff 落地」的提交按更早日期归档（当天显示零活动而实际已发版）。遇到 ff/rebase 流程，需改用 PR 元数据的落地 SHA 日期（参照 `weekly-update-summary` 纪律 3）。本边界已记入 `doc/debt.report-agent.daily.md`。

### 纪律 4：标题固定格式，库固定名

- 知识库名：`日报知识库`（find-or-create，缺则建，isPublic=false 私有）
- 条目标题：`日报-YYYY-MM-DD-今日大事早知道`
- 正文以 `# {标题}` H1 打头（根治分享阅读器目录 `---`）

### 纪律 5：数字必须来自 git，不估算；空日不硬凑

所有计数（提交数、各类型分布、贡献者）必须来自 git 命令输出。若当日零提交，明确写「今日主干无落地提交」并停止，不要硬凑内容。

### 纪律 6：格式二选项 —— html 报纸版（默认）/ md 朴素版

日报正文有两种格式，发布时**恰好选一种**（publish.py 的 `--report-html` / `--report-md` 二选一）：

| 格式 | 模板 | contentType | 渲染路径 | 何时用 |
|------|------|-------------|----------|--------|
| **html 报纸版（默认）** | `reference/report-template-html.html` | `text/html` | 知识库 FilePreview 的 srcDoc 沙箱 iframe 真渲染（分享链同链路） | 日常日报一律用这个（用户 2026-07-04 指定：不喜欢 md 版式） |
| md 朴素版 | `reference/report-template.md` | `text/markdown` | MarkdownViewer | 用户明确要 md、或需要被双链/全文索引深度消费时 |

html 报纸版硬约束（publish.py 发布前校验，违者拒发）：
- **自包含**：内联 CSS，无外部 http 资源；图片仅允许知识库 upload 返回的站内 URL
- **禁 `<script>`**：知识库沙箱 iframe 不给 allow-scripts，动效一律纯 CSS
- **必带 `<meta viewport>`**：否则移动端按 980px 桌面视口缩放、整页变小
- 版式即「米多智能体日报」报纸风（报头 + 期号 dateline + 今日大事 + 头条展开 + 双栏优化/修复 + 数据版 + 计划与遗留 + 数据页脚）；期号 = 当年第几天（`date +%j`）
- 内容分层权重与纪律 1 完全一致，格式只改皮不改骨
- **报纸必须有图**（用户 2026-07-04 反馈「缺少一些图」后固化）：
  1. 头条必配图——首选 Phase 4.5 真实 UI 截图；取证不可用时兜底为**版画风内联 SVG 示意图**（双色 + hatch 纹理，模板有样例），并在「取证说明」注明待补原因
  2. 「数据版」栏目每期必做，两图从 git 真实数据生成：今日战场（TOP6 模块文件变更横条图）+ N 格铅字（每格一个提交的瀑布格，按类型着色）
  3. 引语大字（.pull）从头条提炼一句，制造版面节奏
  4. 禁 `data:image`（后端防破图守卫拒存），插图一律内联 `<svg>` 标签、图表一律纯 CSS

## 触发词

"生成日报" / "写日报" / "今日大事" / "今日大事早知道" / "日报" / "daily report" / "/daily" / "今天干了啥"

## 最简触发提示词（用户每天只需发这一句）

逻辑全在本技能里，提示词保持极简、**不用每次改**；要调流程就改技能：

```
/daily
```

或自然语：

```
生成今天的开发日报，发到「日报知识库」，重要新增功能配截图验证。
```

补历史某天：

```
补 2026-05-30 的日报
```

> 设计意图（用户 2026-05-31 明确）：提示词尽量精简、固定不变；可变逻辑（分层权重、取证选择、发布目标）沉淀进技能，改技能即可，不动提示词。

---

## 执行流程

### Phase 1：确定目标日期 + 解析采集窗口

```bash
# 全流程唯一日期变量：TODAY —— 它只决定**标题和归档日期**，不再决定采集范围（纪律 2）。
# 后续 Phase 5 的 --title/--daily-date 一律复用它，禁止引入 ARG_DATE 等别名。
TODAY=${1:-$(date +%Y-%m-%d)}

# 采集范围由水位线决定，与 TODAY 解耦。必须先 fetch：容器多为浅克隆，不 fetch 会少看好几天。
DEFAULT_BRANCH=$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null)
DEFAULT_BRANCH=${DEFAULT_BRANCH:-origin/main}
git fetch origin --quiet
# 浅克隆必须**真的**补全：失败不能吞。浅克隆下 merge 的父提交不可达（.git/shallow 的
# graft 会让边界提交看起来根本没有父），Phase 2 的穿透判据会把每个 merge 误判成「直接提交」，
# 于是只统计到一行 merge 标题、PR 里的真实提交全部丢失——而 Phase 5 照样把水位线推到 HEAD，
# 那些提交**永久**不会再被任何一期采到。这正是本 PR 要根治的漏报，必须当场中止。
if [ "$(git rev-parse --is-shallow-repository)" = true ]; then
  git fetch origin --unshallow --quiet || git fetch origin --deepen=2000 --quiet || true
  if [ "$(git rev-parse --is-shallow-repository)" = true ]; then
    echo "[致命] 仓库仍是浅克隆，merge 无法穿透：统计会静默丢失 PR 内提交，而水位线仍会前进。" >&2
    echo "       请先手动跑通 git fetch origin --unshallow 再生成日报。" >&2
    exit 3
  fi
fi

WIN=$(python3 .claude/skills/daily-report-summary/reference/coverage_window.py \
        --base https://main-prd-agent.miduo.org --impersonate inernoro --target-date "$TODAY")
echo "$WIN"    # {mode, baseSha, sinceIso, headSha, revRange, spanDays, prevDate, gap}

# 窗口三变量在此**一次性**解出，Phase 2 与 Phase 5 只引用、不重复解析——
# 重复解析是上一轮的真实事故：Phase 2 只解了 MODE/RANGE 却引用 $HEAD_SHA，
# since 模式下它是空串，git log 直接 exit 128，降级路径整条跑不起来。
MODE=$(echo "$WIN"  | python3 -c 'import json,sys;print(json.load(sys.stdin)["mode"])')
RANGE=$(echo "$WIN" | python3 -c 'import json,sys;print(json.load(sys.stdin)["revRange"])')
HEAD_SHA=$(echo "$WIN" | python3 -c 'import json,sys;print(json.load(sys.stdin)["headSha"])')
SINCE=$(echo "$WIN" | python3 -c 'import json,sys;print(json.load(sys.stdin)["sinceIso"])')
EXCLUDE_SHA=$(echo "$WIN" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("excludeSha",""))')
# 空值即刻报错，不要留到 git log 才以 exit 128 的形式暴露
: "${MODE:?窗口解析失败：MODE 为空}" "${HEAD_SHA:?窗口解析失败：headSha 为空}"
```

用户可指定日期（如「补 2026-05-30 的日报」时 `TODAY=2026-05-30`）；缺省取今天。
`--target-date` 会让水位线查询**排除目标日当天已发布的那篇**，避免重跑当天时窗口塌成空集。

若 `gap=true` 或 `spanDays>1`，本期是**补记期**：dateline 与「今日大事」首条必须说明补的是哪几天（纪律 2）。

### Phase 2：数据收集（按纪律 2/3）

```bash
# 0. 把 Phase 1 解出的窗口落成一个可复用的 first-parent 列表 /tmp/win_fp.tsv：<date>\t<sha>\t<author>\t<subject>
#    以下所有统计都从这个列表派生，保证「报头数字」与「正文叙事」同源，不会各算各的。
#    MODE / RANGE / HEAD_SHA / SINCE 均来自 Phase 1，此处不重新解析（重解就会漏解）。
case "$MODE" in
  sha)   git log --first-parent "$RANGE" --format="%cd%x09%H%x09%an%x09%s" --date=short ;;
  since) # 右端用 $HEAD_SHA（已按 target-date 收敛），不用分支 tip——补历史时用 tip 会越界。
         # git 的 --since 是闭区间（实测 git 2.43：喂某提交的 %cI 会把该提交自身返回），
         # 而 $SINCE 正是上期最后一个提交的 %cI，故必须按 SHA 把它剔掉还原「左开」，
         # 否则上期末条被重复统计；它若是 merge，Phase 2 还会穿透它把上个 PR 整个重算。
         git log --first-parent "$HEAD_SHA" --since="$SINCE" --format="%cd%x09%H%x09%an%x09%s" --date=short \
           | awk -F '\t' -v x="$EXCLUDE_SHA" 'x=="" || $2!=x' ;;
  today) git log --first-parent "$DEFAULT_BRANCH" --format="%cd%x09%H%x09%an%x09%s" --date=short \
           | awk -F '\t' -v d="$TODAY" '$1==d' ;;
esac > /tmp/win_fp.tsv

# 2.1 本期落地主干的 first-parent 条目——看"这期落了哪些 PR/直接提交"
cat /tmp/win_fp.tsv

# 2.2 收集"本期落地的真实提交"——类型分布/贡献者/新增展开的【权威来源】。
#   关键：first-parent 多为 "Merge pull request…"，直接 grep 会把 feat/fix 统计成 0、
#   贡献者只剩 merge 作者。所以真实提交 = (a) 直接落主干的非 merge 提交
#   + (b) 每个 merge 内部穿透出来的真实提交。产出 /tmp/today_real.tsv：<author>\t<subject>
: > /tmp/today_real.tsv
while IFS=$'\t' read -r d sha an s; do
  # 是不是 merge 必须看**提交对象本身**的 parent 行数（git cat-file -p），不能用
  # `rev-parse ^2 是否可解` 来推断：浅克隆的 .git/shallow graft 会让边界提交
  # 「看起来没有父」，于是 merge 被误判成直接提交、PR 内提交全部丢失且不报错。
  # 实测：浅克隆下同一个 merge，cat-file 显示 2 个 parent，而 rev-list --parents 显示 0 个。
  nparent=$(git cat-file -p "$sha" | grep -c '^parent')
  if [ "$nparent" -ge 2 ]; then                                    # 是 merge
    if ! git rev-parse -q --verify "$sha^2" >/dev/null 2>&1; then  # 但父不可达 → 不能静默降级
      echo "[致命] merge $sha 的父提交不可达（浅克隆/部分克隆未补全），穿透会静默丢失该 PR 的全部提交" >&2
      exit 3
    fi
    git log "$sha^1..$sha^2" --no-merges --format="%an%x09%s" >> /tmp/today_real.tsv
  else                                                             # 直接提交：自己算一条
    printf '%s\t%s\n' "$an" "$s" >> /tmp/today_real.tsv
  fi
done < /tmp/win_fp.tsv

# 类型分布（权威：从真实提交主题统计，不是 merge 标题）
cut -f2 /tmp/today_real.tsv | grep -oE '^(feat|fix|perf|refactor|style|docs|chore|test|ci)' | sort | uniq -c | sort -rn
# 提交总数（报告头 N 用这个：真实落地提交数，不含 merge 壳）
wc -l < /tmp/today_real.tsv

# 2.3 穿透本期 merge commit（人读，判断主题归属；与 2.2(b) 同源）
cut -f2 /tmp/win_fp.tsv \
  | while read m; do echo "== PR merge $m =="; git log "$m^1..$m^2" --no-merges --oneline 2>/dev/null; done

# 2.4 贡献者（权威：真实提交作者，含 PR 内作者，不是按 merge 作者；与 2.2 同源）
cut -f1 /tmp/today_real.tsv | sort | uniq -c | sort -rn
```

> 报告头的 `feat M / fix K / 贡献者 C / 提交 N` 一律取 2.2/2.4 的【真实提交】口径，**不要**用 2.1 的 first-parent 行数（合并日会把 N 缩成 PR 个数、把 feat/fix 显示成 0、贡献者只剩按 merge 的人），否则与正文「新增/修复」叙述自相矛盾。

### Phase 3：聚类与分层

1. 把当日 commit 按**主题**（不是按文件）聚成 5-10 条脉络
2. 每条脉络判定归属层级（新增/优化/修复），打上权重
3. 新增方向逐条展开（是什么+解决什么+怎么用）
4. 优化、修复按主题聚类，修复段做计数 + 安全/数据类点名
5. 从 `doc/debt.*.md` 与 commit 里的「遗留/TODO/未实现」提取「计划与遗留」

### Phase 4：生成报告正文

按纪律 6 选格式：**默认 html 报纸版**（`reference/report-template-html.html`，整页复制后替换日期/期号/统计与正文），用户明确要 md 时用 `reference/report-template.md`。分层权重见纪律 1。语言全中文，用户视角，禁止 emoji（CLAUDE.md 规则 0）。

> **零提交硬闸（纪律 5）**：判据用 Phase 2.2 的**真实提交数**（`wc -l < /tmp/today_real.tsv`），**不是** 2.1 的 first-parent 行数——否则一条孤立的 merge 壳会被误当"有活动"，跳过硬闸却发出 header 显示 0 提交的报告。真实提交数为 0 即**到此为止**：写一句「{date} 主干无落地提交」回报用户，**不进入 Phase 4.5 / Phase 5**，绝不发布空壳条目。

### Phase 4.5：视觉验收取证（新增方向必做，与 create-visual-test-to-kb 联动）

日报的「新增方向」必须配**带标注的截图**，让读者一眼看到「今天上线的东西长什么样、验证了什么」。本阶段调用 `create-visual-test-to-kb`（`/验收`）的取证 harness 取图，再把图嵌进报告的对应新功能段。

**取证选择原则（重要）**：
- **宽选重要的**：从当天「新增方向」里挑 **2-4 个最重要**的功能取证（不是每个 feat 都截，也不是只截一个）。优先选「用户能直接看到的页面级变化」，跳过纯后端/纯配置类。
- **每张截图必须标注「验证了什么」**：caption 写成「{功能}：{这张图证明了什么}」，例如「AI 大事双栏布局：feed 居左 + 右侧栏填充，宽屏无大片留白」。**禁止**只写功能名不写验证点——读者不能靠猜。
- 走真实用户路径（点击导航进入，禁地址栏直达），双主题按 `acceptance.config.json` 决定。

**取证方式：写 driver，不是直接跑 harness。** `harness.mjs` 只导出 helper（`login/gotoByClick/click/shot/writeManifest/waitForReady/stepClick/stepShot…`），**没有 CLI 入口、不吃 `--base/--steps/--out`**。必须复制 `create-visual-test-to-kb/scripts/example-driver.mjs` 改成本次真人路径脚本，再用 `node` 跑：

```bash
# 凭据在环境变量：MAP_AI_USER + MAP_ACCEPT_PASS（仅有 MAP_AI_PASSWORD 时取它兜底）
export PWPATH=$(npm root -g)/playwright
export MAP_ACCEPT_PASS="${MAP_ACCEPT_PASS:-$MAP_AI_PASSWORD}"
PREVIEW_URL=$(python3 .claude/skills/cds/cli/cdscli.py --human preview-url | head -1)
# driver 内 import harness helpers，对 2-4 个重要功能 login → gotoByClick → shot(带验证点 caption) → writeManifest(OUT)
node /tmp/daily-driver.mjs "$PREVIEW_URL"      # 产出 OUT/*.png + OUT/manifest.json
```

在报告对应的新功能小节插入「{{IMG:<name>}}」占位（report-template.md 已支持逐步配图），**并把 harness 产出的 `manifest.json` 一起传给 Phase 5 的 `publish.py --manifest`**——脚本会先把截图上传到知识库拿可访问 URL、回填占位，再写正文。`publish.py` 发布前有硬闸：正文里若残留任何未替换的 `{{IMG:}}`/`{{EVIDENCE}}` 占位（即占位有了却没传对应截图）会**直接拒发**，杜绝读者看到坏占位。**缺少截图取证的新功能段落，必须显式写「本功能未取截图，原因：……」**（用文字，不要留占位），不留空白让读者疑惑。

> 取证依赖预览环境就绪 + 浏览器登录凭据（`MAP_AI_USER` / `MAP_ACCEPT_PASS`）。若环境/凭据不可用，跳过本阶段并在报告里注明「本期无截图，因预览环境/凭据不可用」，不要假装截过。

### Phase 5：发布到知识库

仅当**真实提交数 > 0**（`wc -l < /tmp/today_real.tsv`，与 Phase 4 零提交硬闸同一判据，不是 2.1 的 first-parent 行数）才执行。调 `reference/publish.py` 完成 find-or-create「日报知识库」+ 建条目 + 写正文（含 Phase 4.5 截图）+ 出分享链：

```bash
export AI_ACCESS_KEY=...            # 已在 CDS 远端环境注入
# 注意：续行反斜杠必须是行尾最后一个字符，行内注释会截断命令（Codex P2 教训）
# HEAD_SHA 来自 Phase 1，不重解
COVER_TO=$(git log -1 "$HEAD_SHA" --format=%cI)
python3 .claude/skills/daily-report-summary/reference/publish.py \
  --base https://main-prd-agent.miduo.org \
  --impersonate inernoro \
  --title "日报-${TODAY}-今日大事早知道" \
  --daily-date "${TODAY}" \
  --report-html /tmp/daily-${TODAY}.html \
  --last-commit "$HEAD_SHA" \
  --cover-to "$COVER_TO" \
  --replace-same-date \
  --manifest /tmp/acc_shots/manifest.json
# --last-commit：**必传，脚本已强制**（纪律 2；不传直接 exit 7 拒发）。它是下一期的水位线起点；
#   当天晚些时候的提交会永久漏报（2026-07-30 实测漏 36 个真实提交的根因）。
# --cover-to：SHA 因 force push / 浅克隆不可达时的降级水位线，一并写上。
# --replace-same-date：同一天重跑/修正时替换旧条目而不是叠一篇（先建新、校验落库成功、再删旧）。
# --report-html 为默认报纸版；用户要 md 时换成 --report-md /tmp/daily-${TODAY}.md
# --manifest：有 Phase 4.5 截图时必传，脚本据此上传图 + 回填 {{IMG:}} 占位；无截图可省略
# 二选项：--report-html 与 --report-md 恰好传一个（纪律 6）；html 版发布前有自包含/禁脚本/viewport 硬校验
# 无密钥 / 无文档空间时退化：加 --local --out <path>，落本地文件（仅自查，不算交付）
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
| 窗口内真实提交数为 0（`wc -l /tmp/today_real.tsv`） | 写「自上期日报（{prevDate}）以来主干无新落地提交」，不发布空报告。**注意措辞**：水位线口径下这句话的含义是「上期之后没有新东西」，不是「今天没干活」 |
| 上期日报中断/漏跑（`gap=true`） | 无需人工干预：窗口自动从上期水位线一路续到本期 HEAD。dateline 与「今日大事」首条必须写明这是补记期、补的是哪几天（纪律 2） |
| 水位线读取失败（知识库不可达/鉴权失败） | `coverage_window.py` 直接 exit 3，**不要**当成「首次运行」继续——那会把历史重报一遍。修好再跑 |
| 上期条目无 `lastCommit` 也无 `coverTo`（本机制上线前的老条目） | 自动退化为当日口径并在 stderr 告警；本期正常出报，回写水位线后下期即恢复连续 |
| 本地是浅克隆（容器默认） | Phase 1 已带 `--unshallow`；不做的话 `git log <sha>..HEAD` 会因为 SHA 不可达而降级成时间戳口径 |
| 预览环境 524 / 不可达 | 正文已就绪，提示稍后用同命令重跑（publish.py 自带退避重试 + 空壳兜底） |
| 「日报知识库」已存在 | 复用，不重复建；同日重跑用 `--replace-same-date` 替换旧条目，不叠第二篇 |
| 没有 AI 密钥 / 无文档空间 | 退化为 `--local` 落 `doc/` 外的本地 md（仅自查，不算交付）。注意 `--local` 不写水位线，下期会退化为当日口径 |

## 注意事项

1. 报告语言全中文，价值主张从用户视角写，PR 英文标题翻译为简洁中文
2. 严格遵守分层权重（纪律 1）：新增多讲，优化/修复次之，计划/遗留垫底
3. 禁止 emoji（CLAUDE.md 规则 0）
4. 数字必须来自 git 输出（纪律 5）
5. 知识库默认私有；分享链对「拿到链接者」开放，非殿堂（isPublic=true 对所有人）
6. **发布必带 `--last-commit`**（纪律 2）。这是整条连续覆盖链的唯一支点：漏一次，
   下一期就断链退回按日历日采，当天晚些时候的提交永久漏报，而且**报告自己看不出来**
   ——每期单独看都正常，只有把相邻两期的覆盖区间拼起来才发现中间有洞。
