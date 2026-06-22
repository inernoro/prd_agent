---
name: entropy-cleanup
description: 日常熵清理技能。扫描六个维度的一致性债务并双向修复（补缺 + 删幽灵）：(1) doc/ 命名规范违规；(2) doc/index.yml 缺失/幽灵条目；(3) doc/guide.list.directory.md 缺失/幽灵条目；(4) CLAUDE.md 技能表缺失/幽灵行；(5) codebase-snapshot 过期数据；(6) changelog→doc 内容覆盖（增量，manifest 追踪）。触发词："/entropy"、"熵清理"、"文档欠债"、"索引同步"、"entropy cleanup"。
---

# Entropy Cleanup — 日常熵清理

## 背景

随着分支并行开发，代码落地但文档/索引/技能声明不同步积累"欠款"。本技能像每日家务，把六类熵增自动清零。

## 核心约束

### 双向扫描原则

每个结构化维度（D2/D3/D4）必须同时做两个方向：

| 方向 | 判断条件 | 操作 | 验证方式 |
|------|---------|------|---------|
| **补缺（Add）** | 文件/目录存在，但索引无对应条目 | 追加条目 | 写入前 `grep -q` 二次确认不存在 |
| **删幽灵（Prune）** | 索引有条目，但对应文件/目录不存在 | 删除该行 | 删除前 `[ -f ]` / `[ -d ]` 真实文件系统验证 |

**"真实校验"规则**：只依赖文件系统事实（`[ -f doc/${key}.md ]`、`[ -d .claude/skills/${name} ]`），
不凭猜测或文件名推断。文件存在才留，不存在才删。

### 幂等性保证

1. **检查后写入**：追加前 `grep -q` 确认不存在
2. **验证后删除**：删除前 `[ -f ]` / `[ -d ]` 确认文件确实不存在
3. **提交前 diff 核验**：`git diff` 中的删除行（`-`）必须全部有对应的"文件不存在"证据，否则停止提交
4. **manifest 防重复**：D6 通过 `changelogs/.entropy-manifest.yml` 记录已处理条目

运行两次的期望结果：第一次增删 N 项，第二次增删 0 项。

### 增量历史覆盖

结构性欠债（D1-D4）：每次全量双向扫描，自然覆盖所有历史欠债。

内容性欠债（D6）：通过 manifest 每次处理 **最多 5 条** 未处理的 changelog 片段。

---

## 六维扫描目标

| 维度 | 补缺方向 | 删幽灵方向 | 验证方式 |
|------|---------|---------|---------|
| D1 doc/ 命名规范 | — | — | git mv 改名（文件确实存在才 mv） |
| D2 index.yml | doc/*.md 无对应 index 条目 → 追加 | index 有条目但 `doc/${key}.md` 不存在 → 删行 | `[ -f doc/${key}.md ]` |
| D3 guide.list | doc/*.md 无 backtick 条目 → 追加 | guide.list 有 backtick 条目但文件不存在 → 删行 | `[ -f doc/${key}.md ]` |
| D4 CLAUDE.md 技能表 | .claude/skills/ 有目录无表格行 → 追加 | 表格有行但 `.claude/skills/${name}/` 不存在 → 删行 | `[ -d .claude/skills/${name} ]` |
| D5 codebase-snapshot | — | — | 人工确认后更新 |
| D6 changelog→doc | changelog 未处理 → 追加章节 | — | manifest 记录，已处理跳过 |

---

## 执行流程

### Step 0 — 读取 manifest（维度 6 专用）

```bash
MANIFEST="changelogs/.entropy-manifest.yml"
[ -f "$MANIFEST" ] || echo "processed: []" > "$MANIFEST"
grep -A9999 "^processed:" "$MANIFEST" | grep "^  - " | sed 's/  - //'
```

### Step 1 — 双向扫描（只读，全量）

```bash
# D1. 命名规范违规
for f in doc/*.md; do
  key=$(basename "$f" .md)
  echo "$key" | grep -qE "^(spec|design|plan|rule|guide|report|debt)\." || echo "NAMING_VIOLATION: $key"
done

# D2. index.yml — 补缺方向
for f in doc/*.md; do
  key=$(basename "$f" .md)
  grep -q "^  $key:" doc/index.yml || echo "MISSING_INDEX: $key"
done

# D2. index.yml — 删幽灵方向（真实校验）
grep -E "^  [a-z]" doc/index.yml | sed 's/:.*//' | sed 's/  //' | while read key; do
  [ -f "doc/${key}.md" ] || echo "GHOST_INDEX: $key"
done

# D3. guide.list — 补缺方向
for f in doc/*.md; do
  key=$(basename "$f" .md)
  grep -q "\`$key\`" doc/guide.list.directory.md || echo "MISSING_GUIDE: $key"
done

# D3. guide.list — 删幽灵方向（真实校验）
grep -oE '\`[a-z][a-z0-9._-]+\`' doc/guide.list.directory.md | tr -d '`' | while read key; do
  [ -f "doc/${key}.md" ] || echo "GHOST_GUIDE: $key"
done

# D4. 技能表 — 补缺方向
for d in .claude/skills/*/; do
  skill=$(basename "$d")
  grep -q "| \*\*$skill\*\*" CLAUDE.md || echo "MISSING_SKILL_TABLE: $skill"
done

# D4. 技能表 — 删幽灵方向（真实校验）
grep -oE '\*\*[a-z][a-z0-9_-]+\*\*' CLAUDE.md | tr -d '*' | sort -u | while read skill; do
  [ -d ".claude/skills/${skill}" ] || echo "GHOST_SKILL_TABLE: $skill"
done

# D6. 未处理的 changelog（限量：最多 5 条）
MANIFEST="changelogs/.entropy-manifest.yml"
PROCESSED=$(grep "^  - " "$MANIFEST" 2>/dev/null | sed 's/  - //' | sort)
for f in changelogs/*.md; do
  name=$(basename "$f")
  echo "$PROCESSED" | grep -qF "$name" || echo "UNPROCESSED_CHANGELOG: $name"
done | head -5
```

### Step 2 — 报告

```
=== 熵清理扫描报告 (YYYY-MM-DD) ===

[D1 命名违规]        N 个
[D2 index.yml]       补缺 N 条 / 删幽灵 N 条
[D3 guide.list]      补缺 N 条 / 删幽灵 N 条
[D4 技能表]          补缺 N 条 / 删幽灵 N 条
[D5 snapshot]        需人工审查
[D6 changelog]       本次处理 N 条，manifest 累计 M 条

净变更：+A 行  -B 行
```

### Step 3 — 双向自动修复

**D1 命名违规**：
```bash
# 只在目标文件不存在时才 mv
if [ ! -f "doc/$NEW_NAME" ]; then
  git mv "doc/$OLD_NAME" "doc/$NEW_NAME"
  sed -i "s/^  $OLD_KEY:/$NEW_KEY:/" doc/index.yml
  sed -i "s/\`$OLD_KEY\`/\`$NEW_KEY\`/" doc/guide.list.directory.md
fi
```

**D2 index.yml 删幽灵**：
```bash
ghost_key="design.old-removed-doc"
[ -f "doc/${ghost_key}.md" ] && echo "文件仍存在，跳过删除" || {
  sed -i "/^  ${ghost_key}:/d" doc/index.yml
}
```

**D3 guide.list 删幽灵**：
```bash
ghost_key="design.old-removed-doc"
[ -f "doc/${ghost_key}.md" ] && echo "文件仍存在，跳过删除" || {
  grep -n "\`${ghost_key}\`" doc/guide.list.directory.md | head -1 | cut -d: -f1 | while read ln; do
    next=$((ln + 1))
    sed -i "${ln}d" doc/guide.list.directory.md
    sed -n "${next}p" doc/guide.list.directory.md | grep -q "^  >" && sed -i "${next}d" doc/guide.list.directory.md
  done
}
```

**D4 技能表删幽灵**：
```bash
ghost_skill="old-removed-skill"
[ -d ".claude/skills/${ghost_skill}" ] && echo "目录仍存在，跳过删除" || {
  sed -i "/| \*\*${ghost_skill}\*\*/d" CLAUDE.md
}
```

**D2/D3/D4 补缺（追加前 grep -q 二次确认）**：
```bash
# D2 追加示例
grep -q "^  $key:" doc/index.yml || {
  printf "  %s:\n    title: \"%s\"\n    status: active\n" "$key" "$title" >> doc/index.yml
}
# D3 追加示例
grep -q "\`$key\`" doc/guide.list.directory.md || {
  printf "- \`%s\`\n  > %s\n" "$key" "$desc" >> doc/guide.list.directory.md
}
# D4 追加示例
grep -q "| \*\*$skill\*\*" CLAUDE.md || {
  printf "| **%s** | \`/%s\` | ... |\n" "$skill" "$trigger" >> CLAUDE.md
}
```

**D6 changelog→doc 内容覆盖**：
1. 读取 changelog 文件，提取涉及模块（第 2 列：prd-api/prd-admin 等）
2. 定位对应 `design.*.md` 文件
3. 判断是否有对应章节（grep 关键词），没有则**追加新章节**（不修改现有内容）
4. 完成后将该 changelog 文件名追加到 manifest：
```bash
echo "  - $changelog_name" >> "$MANIFEST"
```

### Step 4 — 提交前 diff 核验（强制）

```bash
git diff doc/ CLAUDE.md

# 核验规则：
# + 行（追加）：无需额外验证，追加前已做 grep -q
# - 行（删除）：必须逐行确认对应文件/目录确实不存在
#   反例：发现 "- design.foo:" 被删，立刻 [ -f doc/design.foo.md ] 确认
#   如果文件存在却出现删除行 → 立即停止，说明逻辑错误

git diff --stat
# 期望：删除行数 = 幽灵条目数（精确匹配，不多不少）
```

### Step 5 — 收尾与推送

```bash
# 1. 生成本次 changelog 碎片（用实际数字替换 N）
cat > "changelogs/$(date +%Y-%m-%d)_entropy-cleanup.md" << 'EOF'
| chore | doc | 熵清理：D1 N 个，D2 +N/-N，D3 +N/-N，D4 +N/-N，D6 N 条 |
EOF

# 2. Stage 并提交
git add doc/ CLAUDE.md changelogs/ .claude/
git commit -m "chore: 日常熵清理 $(date +%Y-%m-%d)"

# 3. 推送（当前分支即目标分支，scheduled run 自带隔离分支）
git push -u origin $(git branch --show-current)
```

### Step 6 — 自动创建 PR 并开启合并监控（必须执行）

推送完成后立即执行以下步骤，**不得省略**。这是本技能从"推代码"升级为"自动交付"的核心。

#### 6.1 判断是否需要创建 PR

- 若 `git log origin/main..HEAD --oneline` 输出为空（当前分支没有超过 main 的 commit），**跳过 PR 创建**并结束。
- 若当前分支是 `main`，**跳过 PR 创建**并结束（不能从 main 向 main 发 PR）。

#### 6.2 检查是否已有未合并的熵减 PR

使用 `mcp__github__list_pull_requests`（state=open, base=main）查询 `inernoro/prd_agent`。
- 若已有标题含「熵减计划」的 open PR，先尝试用 `mcp__github__merge_pull_request`（squash）合并旧 PR；合并失败则记录并继续创建新 PR。

#### 6.3 创建 PR

使用 `mcp__github__create_pull_request` 创建：

```
owner: inernoro
repo:  prd_agent
title: 每日熵减计划 YYYY-WXX — <本次主要修复内容，如 "D2+D3+D6 修补 (N 条)">
base:  main
head:  <当前分支名，由 git branch --show-current 取得>
body:  （见下方模板）
```

PR body 模板（从 Step 2 报告提取数字）：
```markdown
## 熵清理摘要

- D2 index.yml：+N/-N 条
- D3 guide.list：+N/-N 条
- D4 技能表：+N/-N 条
- D6 changelog→doc：本次处理 N 条，manifest 累计 M 条

## 改动 diff
- `doc/index.yml`：补缺/删幽灵条目
- `doc/guide.list.directory.md`：补缺/删幽灵条目
- `changelogs/.entropy-manifest.yml`：新增已处理 changelog 记录
- `changelogs/YYYY-MM-DD_entropy-cleanup.md`：本次 changelog 碎片

## 测试
- [x] 双向扫描完成，diff 核验通过
- [x] 运行两次验证：第二次净变更为 0
```

#### 6.4 开启自动合并

PR 创建成功后，立即调用 `mcp__github__enable_pr_auto_merge`：
```
owner:        inernoro
repo:         prd_agent
pullNumber:   <上一步返回的 PR number>
mergeMethod:  squash
```

若 CI 未配置（仓库无必需 check），auto-merge 可能直接触发合并，这是预期行为。

#### 6.5 订阅 PR 并监控到合并完成

调用 `mcp__github__subscribe_pr_activity` 订阅该 PR：
- 收到 CI 通过事件 → 确认 auto-merge 已触发
- 收到 PR 已合并事件 → 记录合并 SHA，结束任务
- 收到 CI 失败事件 → 分析失败原因；若是文档内容类冲突，尝试修复后 force-push；若无法自修复，发送通知给用户

**重要**：订阅后不得用 `sleep` 轮询——等待 webhook 事件唤醒即可。PR 合并或关闭后自动调用 `mcp__github__unsubscribe_pr_activity` 解除订阅。

---

## Manifest 格式

`changelogs/.entropy-manifest.yml`：

```yaml
# 已处理的 changelog 片段（D6 changelog→doc 内容覆盖）
# 自动维护，请勿手动删除条目
processed:
  - 2026-05-11_defect-title-polish.md
  - 2026-05-11_desktop-post-update-summary.md
  # 每次 D6 处理完毕后自动追加
```

---

## PR 工作流

- **标题约定**：`每日熵减计划 YYYY-WXX — <本次主要修复内容>`
- **自动创建**：Step 6 在推送后必须自动调用 `mcp__github__create_pull_request` 创建，不需要人工触发
- **自动合并**：创建后立即调用 `mcp__github__enable_pr_auto_merge`（squash 策略），CI 通过即自动合并
- **去重保护**：创建前先查 open PR，有同类 PR 先合并再创建
- **无净变更跳过**：当前分支没有超过 main 的 commit 时，不创建 PR（幂等运行不产生空 PR）

---

## 幂等性自检清单

- [ ] D2/D3/D4 补缺：写入前 `grep -q` 确认不存在
- [ ] D2/D3/D4 删幽灵：删除前 `[ -f ]`/`[ -d ]` 确认文件/目录真实不存在
- [ ] `git diff` 中每一行 `-` 行都有对应的"文件不存在"证据
- [ ] 运行两次期望第二次净变更为 0

---

## 与其他技能的关系

| 技能 | 覆盖范围 | 与本技能的关系 |
|------|---------|--------------|
| `doc-sync` | index.yml + guide.list 对齐（仅补缺） | 本技能是超集，额外覆盖幽灵删除、命名规范、技能表、changelog 内容 |
| `code-hygiene` | 代码层技术债 | 互补，本技能管文档/元数据债 |
| `scope-check` | 分支边界审计 | 互补，本技能面向主分支历史债 |
| `weekly-update-summary` | 周报生成 | 建议在 /weekly 完成后立即运行 /entropy |
