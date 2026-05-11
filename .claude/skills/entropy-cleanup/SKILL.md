---
name: entropy-cleanup
description: 日常熵清理技能。扫描五个维度的一致性债务并自动补齐：(1) doc/ 命名规范违规文件；(2) doc/index.yml 缺失条目；(3) doc/guide.list.directory.md 缺失条目；(4) CLAUDE.md 技能表遗漏；(5) codebase-snapshot 过期数据。触发词："/entropy"、"熵清理"、"文档欠债"、"索引同步"、"entropy cleanup"。
---

# Entropy Cleanup — 日常熵清理

## 背景

随着分支并行开发，代码落地但文档/索引/技能声明不同步积累"欠款"。本技能像每日家务，把以下五类熵增自动清零。

## 五维扫描目标

| 维度 | 检查内容 | 自动修复 |
|------|---------|---------|
| doc/ 命名规范 | 文件名不以 `spec./design./plan./rule./guide./report./debt.` 开头 | git mv 改名 |
| index.yml 覆盖率 | doc/*.md 存在但 index.yml 没有对应条目 | 追加条目 |
| guide.list.directory.md 覆盖率 | doc/*.md 存在但目录文件没有 backtick 条目 | 追加带描述的条目 |
| CLAUDE.md 技能表 | .claude/skills/ 目录有技能但 CLAUDE.md 表格没有登记 | 追加表格行 |
| codebase-snapshot 数字 | MongoDB 集合数、功能状态描述已过期 | 人工确认后更新 |

## 执行流程

### Step 1 — 扫描（只读）

```bash
# 1a. 命名规范违规
ls doc/*.md | xargs -I{} basename {} .md | \
  grep -v "^spec\.\|^design\.\|^plan\.\|^rule\.\|^guide\.\|^report\.\|^debt\."

# 1b. index.yml 缺失
for f in doc/*.md; do
  key=$(basename $f .md)
  grep -q "^  $key:" doc/index.yml || echo "MISSING_INDEX: $key"
done

# 1c. guide.list.directory.md 缺失
for f in doc/*.md; do
  key=$(basename $f .md)
  grep -q "\`$key\`" doc/guide.list.directory.md || echo "MISSING_GUIDE: $key"
done

# 1d. 技能表缺失（.claude/skills/ 目录 vs CLAUDE.md 表格）
for d in .claude/skills/*/; do
  skill=$(basename $d)
  grep -q "| \*\*$skill\*\*" CLAUDE.md || echo "MISSING_SKILL_TABLE: $skill"
done
```

### Step 2 — 报告

输出格式：

```
=== 熵清理扫描报告 (YYYY-MM-DD) ===

[命名违规] 0 个
[index.yml 缺失] N 个
[guide.list 缺失] N 个
[技能表缺失] N 个
[snapshot 需人工审查] 需对照 codebase-snapshot.md 中的数字

总欠款：N 项
```

### Step 3 — 自动修复

对 Step 2 中发现的问题，按以下规则自动修复：

**命名违规**：
- 读取文件头部 `# 标题` 或 `title:` frontmatter 判断正确前缀
- `git mv` 改名，同步更新 index.yml 和 guide.list.directory.md

**index.yml 缺失**：
- 读取文件 H1 标题作为中文标题
- 按前缀分组插入到对应 `# ── N、XXX ──` 注释块末尾

**guide.list.directory.md 缺失**：
- 读取文件 H1 + 第一段摘要
- 生成 `- [标题](key) \`key\`` + `  > 摘要` 格式插入对应分节末尾

**技能表缺失**：
- 读取 `.claude/skills/{name}/SKILL.md` 的 `description:` frontmatter
- 按触发词归类到「主流程技能 / 辅助技能 / 专项修复技能 / 元技能」之一
- 追加一行到对应表格

### Step 4 — 不自动修复的项目

以下需要人工确认：
- codebase-snapshot.md 中的 MongoDB 集合数（需对照代码）
- 功能状态描述（"已完成 / 未实现"的判断需要业务上下文）
- 技能触发词分类有歧义时（归哪个表格）

### Step 5 — 收尾

```bash
# 创建 changelog 碎片
cat > changelogs/$(date +%Y-%m-%d)_entropy-cleanup.md << 'EOF'
| chore | doc | 熵清理：修复命名违规 N 个，补齐 index.yml N 条，补齐目录 N 条，补齐技能表 N 条 |
EOF

# commit
git add doc/ CLAUDE.md changelogs/
git commit -m "chore: 日常熵清理 $(date +%Y-%m-%d)"
git push -u origin $(git branch --show-current)
```

## 日常使用

```
用户说：/entropy
AI 执行：Step 1-2（扫描）→ 给用户看报告 → 确认后 Step 3-5（修复）
```

建议频率：**每周一次**（配合 `/weekly` 使用，周报收尾后运行）。

## 与其他技能的关系

| 技能 | 覆盖范围 | 与本技能的关系 |
|------|---------|--------------|
| `doc-sync` | index.yml + guide.list.directory 对齐 | 本技能 Step 1b/1c 的超集，额外覆盖命名规范和技能表 |
| `code-hygiene` | 代码层技术债 | 互补，本技能管文档/元数据债，code-hygiene 管代码债 |
| `scope-check` | 分支边界审计 | 互补，本技能面向主分支历史债，scope-check 面向当前分支 |
| `weekly-update-summary` | 周报生成 | 建议在 /weekly 完成后立即运行 /entropy |

## 执行示例

```
/entropy

=== 熵清理扫描报告 (2026-05-11) ===

[命名违规] 2 个
  - cds-github-auto-deploy-acceptance-2026-05-11 (无前缀) → report.*
  - handoff.cds-blue-green (前缀不合法) → guide.*

[index.yml 缺失] 53 个
  design.cds-cluster-bootstrap / design.document-store / ...

[guide.list 缺失] 57 个
  spec.cds-compose-contract / guide.agent-onboarding / ...

[技能表缺失] 2 个
  qa-ledger / createzzdemo

[snapshot 需人工审查]
  MongoDB 集合数：CLAUDE.md 写 115，codebase-snapshot.md 写 118

总欠款：114 项

确认自动修复? [Y/n]
```
