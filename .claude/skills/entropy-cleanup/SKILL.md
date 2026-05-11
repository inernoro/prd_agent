---
name: entropy-cleanup
description: 日常熵清理技能。扫描六个维度的一致性债务并自动补齐：(1) doc/ 命名规范违规文件；(2) doc/index.yml 缺失条目；(3) doc/guide.list.directory.md 缺失条目；(4) CLAUDE.md 技能表遗漏；(5) codebase-snapshot 过期数据；(6) changelog→doc 内容覆盖（增量，manifest 追踪）。触发词："/entropy"、"熵清理"、"文档欠债"、"索引同步"、"entropy cleanup"。
---

# Entropy Cleanup — 日常熵清理

## 背景

随着分支并行开发，代码落地但文档/索引/技能声明不同步积累"欠款"。本技能像每日家务，把六类熵增自动清零。

## 核心约束

### 幂等性保证

**本技能任何次运行的结果必须可叠加，不得产生冲突。**

实现原则：
1. **检查后写入**：每个 Step 在追加内容前，必须先 `grep -q` 确认不存在，存在则跳过
2. **只追加不修改**：已有内容一律不改动，只向已有结构末尾追加新条目
3. **提交前 diff 核验**：`git diff --stat` 确认只有追加行（`+` 行），无删除行（`-` 行）
4. **manifest 防重复**：维度 6（changelog 内容覆盖）通过 `changelogs/.entropy-manifest.yml` 记录已处理条目，下次跳过

运行两次的期望结果：第一次追加 N 项，第二次追加 0 项（因为第一次已全部填入）。

### 增量历史覆盖

结构性欠债（维度 1-4）：每次全量扫描 `doc/*.md`，自然覆盖所有历史欠债。

内容性欠债（维度 6）：通过 manifest 每次处理 **最多 5 条** 未处理的 changelog 片段，不求一次全清，日积月累自然覆盖所有历史变更。

---

## 六维扫描目标

| 维度 | 检查内容 | 自动修复 | 幂等保证 |
|------|---------|---------|---------|
| D1 doc/ 命名规范 | 文件名不以 7 类合规前缀开头 | git mv 改名，同步更新索引 | mv 前检查目标文件不存在 |
| D2 index.yml 覆盖率 | doc/*.md 存在但无对应条目 | 追加条目 | grep -q 存在则跳过 |
| D3 guide.list 覆盖率 | doc/*.md 存在但目录无 backtick 条目 | 追加带描述的条目 | grep -q 存在则跳过 |
| D4 CLAUDE.md 技能表 | .claude/skills/ 有技能但表格未登记 | 追加表格行 | grep -q 存在则跳过 |
| D5 codebase-snapshot | MongoDB 集合数、功能描述过期 | 人工确认后更新 | 人工操作，不自动修改 |
| D6 changelog→doc 内容 | changelog 片段对应的设计/规格文档缺失描述 | 向相关文档追加章节 | manifest 记录，已处理跳过 |

---

## 执行流程

### Step 0 — 读取 manifest（维度 6 专用）

```bash
MANIFEST="changelogs/.entropy-manifest.yml"
# 如果 manifest 不存在，创建空文件
[ -f "$MANIFEST" ] || echo "processed: []" > "$MANIFEST"

# 读取已处理的 changelog 文件名列表
grep -A9999 "^processed:" "$MANIFEST" | grep "^  - " | sed 's/  - //'
```

### Step 1 — 扫描（只读，全量）

```bash
# D1. 命名规范违规（全量扫描）
for f in doc/*.md; do
  key=$(basename "$f" .md)
  echo "$key" | grep -qE "^(spec|design|plan|rule|guide|report|debt)\." || echo "NAMING_VIOLATION: $key"
done

# D2. index.yml 缺失（全量扫描）
for f in doc/*.md; do
  key=$(basename "$f" .md)
  grep -q "^  $key:" doc/index.yml || echo "MISSING_INDEX: $key"
done

# D3. guide.list.directory.md 缺失（全量扫描）
for f in doc/*.md; do
  key=$(basename "$f" .md)
  grep -q "\`$key\`" doc/guide.list.directory.md || echo "MISSING_GUIDE: $key"
done

# D4. 技能表缺失（全量扫描）
for d in .claude/skills/*/; do
  skill=$(basename "$d")
  grep -q "| \*\*$skill\*\*" CLAUDE.md || echo "MISSING_SKILL_TABLE: $skill"
done

# D6. 未处理的 changelog（限量：最多 5 条）
PROCESSED=$(grep "^  - " "$MANIFEST" 2>/dev/null | sed 's/  - //' | sort)
UNPROCESSED=()
for f in changelogs/*.md; do
  name=$(basename "$f")
  echo "$PROCESSED" | grep -qF "$name" || UNPROCESSED+=("$name")
done
# 取前 5 条未处理的
printf '%s\n' "${UNPROCESSED[@]}" | sort | head -5
```

### Step 2 — 报告

输出格式：

```
=== 熵清理扫描报告 (YYYY-MM-DD) — 第 N 次运行 ===

[D1 命名违规] N 个
[D2 index.yml 缺失] N 个
[D3 guide.list 缺失] N 个
[D4 技能表缺失] N 个
[D5 snapshot 需人工审查] 需对照 codebase-snapshot.md
[D6 changelog 待处理] N 条（本次处理前 5 条，其余下次）
  - 2026-05-11_defect-title-polish.md → 影响 design.defect-agent.md / design.skill-marketplace-open-api.md
  - ...

幂等性状态：
  - 结构性欠款（D1-D4）：全量扫描，运行两次期望第二次为 0
  - 内容性欠款（D6）：manifest 追踪，本次处理 M 条，历史累计已处理 K 条

总欠款：N 项
确认自动修复? [Y/n]
```

### Step 3 — 自动修复（追加为主，绝不覆盖已有内容）

**D1 命名违规**：
```bash
# 只在目标文件不存在时才 mv
if [ ! -f "doc/$NEW_NAME" ]; then
  git mv "doc/$OLD_NAME" "doc/$NEW_NAME"
  # 同步更新 index.yml 和 guide.list（旧 key → 新 key）
  sed -i "s/^  $OLD_KEY:/$NEW_KEY:/" doc/index.yml
  sed -i "s/\`$OLD_KEY\`/\`$NEW_KEY\`/" doc/guide.list.directory.md
fi
```

**D2 index.yml 缺失**（追加前二次确认）：
```bash
# 只有 grep -q 确认不存在时才追加
grep -q "^  $key:" doc/index.yml || {
  # 按前缀插入到对应注释块末尾
  ...
}
```

**D3 guide.list.directory.md 缺失**（追加前二次确认）：
```bash
grep -q "\`$key\`" doc/guide.list.directory.md || {
  # 追加条目到对应分节末尾
  ...
}
```

**D4 技能表缺失**（追加前二次确认）：
```bash
grep -q "| \*\*$skill\*\*" CLAUDE.md || {
  # 追加到对应表格末尾
  ...
}
```

**D6 changelog→doc 内容覆盖**：
1. 读取 changelog 文件，提取涉及模块（`| feat/fix | prd-api/prd-admin | ... |` 第 2 列）
2. 对每个模块，定位对应的 `design.*.md` 或 `spec.*.md` 文件
3. 判断是否有对应章节（grep 关键词），没有则**追加新章节**（不修改现有内容）
4. 完成后将该 changelog 文件名追加到 manifest：

```bash
echo "  - $changelog_name" >> "$MANIFEST"
```

### Step 4 — 提交前 diff 核验（强制）

```bash
git diff --stat
# 期望输出：只有 + 行，无 - 行（除了 changelog mv 的 git mv 操作）
git diff doc/ CLAUDE.md .claude/ changelogs/ | grep "^-" | grep -v "^---" | head -5
# 如果有非 git-mv 产生的删除行，停下来确认
```

如果出现意外删除行，**停止提交，人工确认**。

### Step 5 — 收尾

```bash
# changelog 碎片（幂等：文件名含日期，同一天重跑会覆盖）
cat > "changelogs/$(date +%Y-%m-%d)_entropy-cleanup.md" << 'EOF'
| chore | doc | 熵清理：D1 命名修复 N 个，D2 index N 条，D3 目录 N 条，D4 技能表 N 条，D6 changelog 覆盖 M 条 |
EOF

git add doc/ CLAUDE.md changelogs/ .claude/
git commit -m "chore: 日常熵清理 $(date +%Y-%m-%d)"
git push -u origin $(git branch --show-current)
```

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

## 日常使用

```
用户说：/entropy
AI 执行：Step 0（读 manifest）→ Step 1-2（扫描 + 报告）→ 给用户看报告 → 确认后 Step 3-5（修复 + 核验 + 提交）
```

建议频率：**每日或每次 PR 合并后**（配合 `/weekly` 使用，周报收尾后运行）。

PR 标题约定：`每日熵减计划 YYYY-WXX — <本次主要修复内容>`。PR 提交后自动等待 CI，无需人工触发。

---

## 幂等性自检清单

每次运行结束后核对：

- [ ] `git diff --stat` 仅有追加，无删除（除 git mv）
- [ ] D1-D4 第二次空跑结果为 0
- [ ] manifest 中无重复条目
- [ ] 已处理的 changelog 文件名均已在 manifest 中

---

## 与其他技能的关系

| 技能 | 覆盖范围 | 与本技能的关系 |
|------|---------|--------------|
| `doc-sync` | index.yml + guide.list.directory 对齐 | 本技能 D2/D3 的超集，额外覆盖命名规范、技能表、changelog 内容 |
| `code-hygiene` | 代码层技术债 | 互补，本技能管文档/元数据债，code-hygiene 管代码债 |
| `scope-check` | 分支边界审计 | 互补，本技能面向主分支历史债，scope-check 面向当前分支 |
| `weekly-update-summary` | 周报生成 | 建议在 /weekly 完成后立即运行 /entropy |
