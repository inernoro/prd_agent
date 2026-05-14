---
name: daily-entropy-plan
description: 每日熵减计划（仅手动触发）。一条命令跑完全流程：合并历史熵减 PR → 切干净分支 → 六维双向扫描 → 自动修复 → diff 核验 → 提交 + 推送 + 创建 PR + squash 合并。全程不中断、不需要人工确认任何步骤。**仅在用户显式输入 `/daily-entropy` 或 `每日熵减` 时触发**，禁止根据对话上下文自动推断使用。日常的"熵清理"请用 `entropy-cleanup` 技能。
---

# Daily Entropy Plan — 每日熵减计划

## 触发约束（最重要）

**本技能只能手动触发**。仅以下两种情况允许执行：

1. 用户显式输入 `/daily-entropy`
2. 用户原文里出现"每日熵减计划"、"跑一遍每日熵减"、"daily entropy"

**禁止**根据"看起来需要清理文档"、"index.yml 有遗漏"等推断自动调用本技能。日常局部清理请用 `entropy-cleanup`。本技能会**自动 push + 创建并合并 PR**，误触发会污染 main 分支历史。

## 与 entropy-cleanup 的边界

| 维度 | entropy-cleanup | daily-entropy-plan（本技能） |
|------|----------------|-------------------------------|
| 触发 | 关键词 / 自动推断 | **仅手动 `/daily-entropy`** |
| 范围 | 六维扫描 + 局部修复 | 全流程编排（含 PR + 合并） |
| 分支 | 当前分支原地修 | 切新分支 `claude/entropy-YYYYMMDD-xxxxx` |
| 终态 | 留给用户决定要不要 push | 自动 push + 自动 squash 合并到 main |
| 频率 | 随手跑 | 每天一次 |

如果只想看欠款不动 main，用 `entropy-cleanup`。

## 执行流程（全程不中断）

### 第一步：清理历史熵减 PR

```
mcp__github__list_pull_requests(owner=inernoro, repo=prd_agent, state=open)
```

筛选标题包含"熵减"或"entropy"的 PR：
- 有 → `mcp__github__merge_pull_request(merge_method=squash)` 逐个合并，避免与今天的分支冲突
- 无 → 跳过

### 第二步：拉取最新 main，创建工作分支

```bash
git fetch origin main
git checkout main
git pull origin main

WEEK=$(date +%Y-W%V)
SUFFIX=$(cat /dev/urandom | tr -dc 'a-z' | head -c 5)
BRANCH="claude/entropy-$(date +%Y%m%d)-${SUFFIX}"
git checkout -b "$BRANCH"
```

### 第三步：六维双向扫描

#### D1 — `doc/` 命名规范违规

```bash
for f in doc/*.md; do
  key=$(basename "$f" .md)
  echo "$key" | grep -qE "^(spec|design|plan|rule|guide|report|debt)\." \
    || echo "NAMING_VIOLATION: $key"
done
```

#### D2 — `doc/index.yml` 双向扫描

```bash
# 补缺
for f in doc/*.md; do
  key=$(basename "$f" .md)
  grep -q "^  $key:" doc/index.yml || echo "MISSING_INDEX: $key"
done

# 删幽灵（真实校验，必须 [ -f ] 验证）
grep -E "^  [a-z]" doc/index.yml | sed 's/:.*//;s/  //' | while read key; do
  [ -f "doc/${key}.md" ] || echo "GHOST_INDEX: $key"
done
```

#### D3 — `doc/guide.list.directory.md` 双向扫描

```bash
# 补缺
for f in doc/*.md; do
  key=$(basename "$f" .md)
  grep -q "\`$key\`" doc/guide.list.directory.md || echo "MISSING_GUIDE: $key"
done

# 删幽灵
grep -oE '`[a-z][a-z0-9._-]+`' doc/guide.list.directory.md | tr -d '`' | while read key; do
  [ -f "doc/${key}.md" ] || echo "GHOST_GUIDE: $key"
done
```

#### D4 — `CLAUDE.md` 技能表双向扫描

```bash
# 补缺
for d in .claude/skills/*/; do
  skill=$(basename "$d")
  grep -q "| \*\*$skill\*\*" CLAUDE.md || echo "MISSING_SKILL_TABLE: $skill"
done

# 删幽灵
grep -oE '\*\*[a-z][a-z0-9_-]+\*\*' CLAUDE.md | tr -d '*' | sort -u | while read skill; do
  [ -d ".claude/skills/${skill}" ] || echo "GHOST_SKILL_TABLE: $skill"
done
```

#### D6 — 未处理 changelog（最多 5 条/次，避免单次 diff 过大）

```bash
MANIFEST="changelogs/.entropy-manifest.yml"
PROCESSED=$(grep "^  - " "$MANIFEST" 2>/dev/null | sed 's/  - //' | sort)
for f in changelogs/*.md; do
  name=$(basename "$f")
  echo "$PROCESSED" | grep -qF "$name" || echo "UNPROCESSED_CHANGELOG: $name"
done | head -5
```

> D5（codebase-snapshot）暂不在每日流程内，留给 `entropy-cleanup` 按需触发。

### 第四步：自动修复

| 标记 | 修复动作 | 安全护栏 |
|------|---------|---------|
| `NAMING_VIOLATION: <key>` | `git mv` 加前缀 + 同步 index.yml / guide.list 中的引用 | 重命名后再次 `[ -f ]` 验证新文件存在 |
| `MISSING_INDEX: <key>` | 在 `doc/index.yml` 对应 section 追加条目 | 追加前 `grep -q` 二次确认不存在 |
| `MISSING_GUIDE: <key>` | 在 `doc/guide.list.directory.md` 追加条目 | 同上 |
| `MISSING_SKILL_TABLE: <skill>` | 在 `CLAUDE.md` 技能表对应分类追加一行 | 同上 |
| `GHOST_INDEX: <key>` | `[ -f doc/${key}.md ]` 二次确认不存在 → `sed -i` 删该行 | 缺失证据则跳过 |
| `GHOST_GUIDE: <key>` | 同上 → 删该行 + 紧跟的摘要行 | 同上 |
| `GHOST_SKILL_TABLE: <skill>` | `[ -d .claude/skills/${skill} ]` 不存在 → 删该行 | 同上 |
| `UNPROCESSED_CHANGELOG: <name>` | 读取 changelog，向对应 `design.*.md` 追加章节 + 写入 manifest | manifest 追加后下次不会重复处理 |

### 第五步：提交前 diff 核验

```bash
git diff doc/ CLAUDE.md .claude/ changelogs/
```

逐行检查所有 `-`（删除）行：

- 必须对应一个 `GHOST_*` 标记，且该标记的"文件不存在"证据已通过 `[ -f ]` / `[ -d ]` 验证
- 任何无法解释的删除行 → **跳过该项**，不进入提交（宁可少改一项，绝不删错）

### 第六步：提交 + 推送 + 创建 PR + 合并

```bash
git add doc/ CLAUDE.md changelogs/ .claude/
git commit -m "chore: 日常熵清理 $(date +%Y-%m-%d)"
git push -u origin "$(git branch --show-current)"
```

创建 PR：

```
mcp__github__create_pull_request(
  owner=inernoro, repo=prd_agent,
  base=main, head=<当前分支>,
  title="每日熵减计划 YYYY-WXX — <本次主要修复内容简述>",
  body="自动生成的每日熵减 PR。\n\n## 修复项\n- ...（逐项列）\n\n## 跳过项（diff 核验未通过）\n- ...\n"
)
```

合并：

```
mcp__github__merge_pull_request(merge_method=squash)
```

> 纯文档变更，不等 CI。

## 失败处理（不中断主流程）

| 失败点 | 兜底 |
|--------|------|
| 历史 PR 合并冲突 | 跳过该 PR，记录到本次 PR 描述的"已知遗留"段 |
| 创建分支失败（同名已存在） | 改用更长的随机后缀重试一次，仍失败则报错并停止 |
| push 失败 | 按 CLAUDE.md "Git Operations"：指数退避重试 4 次（2s/4s/8s/16s） |
| PR 创建失败 | 不重试，输出分支名 + 让用户手动建 PR |
| PR 合并失败 | 不强合，保留 PR 让用户处理 |

## 输出格式

执行结束后给出一份简报：

```
每日熵减完成（YYYY-MM-DD）

历史 PR：合并 N 个 / 跳过 M 个
本次修复：
  - 命名违规：X 项
  - index.yml 补缺：X / 删幽灵：X
  - guide.list 补缺：X / 删幽灵：X
  - 技能表 补缺：X / 删幽灵：X
  - changelog 入库：X 条

跳过项（diff 核验未通过）：N 项
  - ...

PR：<url>
合并状态：squash merged / 待用户处理
```

## 历史背景

每日熵清理之前是散落在 chat 里的一串 bash + MCP 调用，每次跑都要复制粘贴一长段，且容易在"跳过哪些项"上犹豫。本技能把它定型成一个**手动触发的固定流程**，确保：

1. 每天一次，不多不少
2. 全程无人工确认，跑完即合
3. 危险动作（删除行）必须有真实文件系统证据兜底
4. 误触发风险被"仅手动触发"约束封死
