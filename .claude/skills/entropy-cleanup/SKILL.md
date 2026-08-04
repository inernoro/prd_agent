---
name: entropy-cleanup
description: 日常熵清理技能。扫描七个维度的一致性债务并双向修复（补缺 + 删幽灵）：(1) doc/ 命名规范违规；(2) doc/index.yml 缺失/幽灵条目；(3) doc/guide.list.directory.md 缺失/幽灵条目；(4) 技能可发现性（SKILL.md frontmatter 完整性）；(5) codebase-snapshot 过期数据；(6) changelog→doc 内容覆盖（增量，manifest 追踪）；(7) 文档可读性（导读三行缺失 / 引用点不开 / 死链，判据见 doc/rule.doc.readability.md）。触发词："/entropy"、"熵清理"、"文档欠债"、"索引同步"、"entropy cleanup"。
---

# 日常熵清理

> **版本**：v1.0.0 | **状态**：已落地 | **触发**：`/entropy`、"熵清理"、"文档欠债"、"索引同步"、"entropy cleanup"

## 背景

随着分支并行开发，代码落地但文档/索引/技能声明不同步积累"欠款"。本技能像每日家务，把六类熵增自动清零。

## 核心约束

### 双向扫描原则

结构化索引维度（D2/D3）必须同时做两个方向；D4 自 2026-08-04 起只有补缺方向（见该维说明）：

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
5. **不猜就不写**：D4 里 `description` 缺失、整份 `SKILL.md` 缺失这两类无法安全重建，一律升级人工，禁止写占位符糊弄收敛

运行两次的期望结果：第一次增删 N 项，第二次增删 0 项。**例外**：第 5 条那类「需人工处理」条目在人处理之前会持续被报出来，这是有意保留的信号，不算幂等性被破坏。

### 增量历史覆盖

结构性欠债（D1-D4）：每次全量扫描，自然覆盖所有历史欠债（D2/D3 双向，D4 仅补缺）。

内容性欠债（D6）：通过 manifest 每次处理 **最多 5 条** 未处理的 changelog 片段。

---

## 七维扫描目标

| 维度 | 补缺方向 | 删幽灵方向 | 验证方式 |
|------|---------|---------|---------|
| D1 doc/ 命名规范 | — | — | git mv 改名（文件确实存在才 mv） |
| D2 index.yml | doc/*.md 无对应 index 条目 → 追加 | index 有条目但 `doc/${key}.md` 不存在 → 删行 | `[ -f doc/${key}.md ]` |
| D3 guide.list | doc/*.md 无 backtick 条目 → 追加 | guide.list 有 backtick 条目但文件不存在 → 删行 | `[ -f doc/${key}.md ]` |
| D4 技能可发现性 | 审计判为 `AUTOFIX_NAME` 的补 name；`BLOCK` 类升级人工 | — | `python3 scripts/doc-readability-check.py --skills-audit`（唯一判据，勿在本技能里重写） |
| D5 codebase-snapshot | — | — | 人工确认后更新 |
| D6 changelog→doc | changelog 未处理 → 追加章节 | — | manifest 记录，已处理跳过 |
| D7 文档可读性 | 缺导读三行 → 补；规则缺「一句话 + 什么时候撞上」两行 → 补；技能 frontmatter 的 description 说不清触发时机 → 补；裸引用 → 转可点链接 | 死链（引用的文档不存在）→ 修或删 | `python3 scripts/doc-readability-check.py --ratchet`；批量改写用 `--fix-links` |

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

# D4. 技能可发现性 —— 判据只有一处，不要在这里重写
#
# 2026-08-04：这里曾经用 grep 自己判 frontmatter，连续多轮被评审挑出偏差
# （只查键不查值、不限定 frontmatter 块、空值算合规、name 与目录不一致查不出）。
# 同一件事两处实现，弱的那处就是漏洞。判据现在只在
# scripts/doc-readability-check.py::check_skill 里，本维只消费它的输出。
#
# 输出契约：AUTOFIX_NAME: <dir>  → 可由目录名确定性补全
#           BLOCK: <dir> — <原因> → 不可安全自动修，必须挡住自动合并
D4_AUDIT=$(python3 scripts/doc-readability-check.py --skills-audit || true)
printf '%s\n' "$D4_AUDIT"

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
[D4 技能可发现性]    补缺 N 条
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

**D2/D3 补缺（追加前 grep -q 二次确认）**：
```bash
# D2 追加示例
grep -q "^  $key:" doc/index.yml || {
  printf "  %s:\n    title: \"%s\"\n    status: active\n" "$key" "$title" >> doc/index.yml
}
# D3 追加示例
grep -q "\`$key\`" doc/guide.list.directory.md || {
  printf "- \`%s\`\n  > %s\n" "$key" "$desc" >> doc/guide.list.directory.md
}
```

**D4 技能可发现性修复（只修审计判为可自动修的那一类）**：

`name` 键整个缺失时能安全推导——它按定义就等于目录名。其余一切（空值、与目录不一致、
description 缺失或说不清触发时机、frontmatter 语法坏、整份 SKILL.md 缺失）都不可
自动重建：description 决定这个技能什么时候被触发，编一个占位符比缺着更糟，属于
`no-rootless-tree` 说的「不许凭空造」。

```bash
python3 scripts/doc-readability-check.py --skills-audit \
  | grep '^AUTOFIX_NAME: ' | sed 's/^AUTOFIX_NAME: //' | while read -r dir; do
      sed -i "1a name: $(basename "$dir")" "$dir/SKILL.md"
      echo "FIXED_SKILL_NAME: $dir"
    done

# 修完复跑一次确认这一类已清零（BLOCK 那类留给 Step 4.5 判定）
python3 scripts/doc-readability-check.py --skills-audit | grep '^AUTOFIX_NAME: ' && \
  echo "[WARN] 仍有可自动修条目未处理" || true
```

**改了技能就必须重新生成分发包**（否则市场下载到的还是旧内容，Server Build & Test 的
新鲜度自测会红）。这一步不能省——`.claude/skills` 下有 24 个技能进了官方套装，
D4 的自动修复随时可能命中其中之一：

```bash
if git diff --quiet -- .claude/skills/ .agents/skills/; then
  :   # 本轮没动技能，跳过
else
  node scripts/bundle-official-skills.mjs
  node scripts/test-official-skill-bundles.mjs   # 必须通过才继续
fi
```

生成物 `prd-api/src/PrdAgent.Api/OfficialSkills/official-skills.generated.json` 要一并
提交（Step 5 的 git add 已含该路径）。注意该测试每次跑都会重写生成物里的时间戳，
若 diff **只有** `generatedAt` 一行变化，丢弃它，别提交无意义 churn。

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
git diff doc/ .claude/skills/ .agents/skills/ prd-api/src/PrdAgent.Api/OfficialSkills/

# 核验规则：
# + 行（追加）：无需额外验证，追加前已做 grep -q
# - 行（删除）：必须逐行确认对应文件/目录确实不存在
#   反例：发现 "- design.foo:" 被删，立刻 [ -f doc/design.foo.md ] 确认
#   如果文件存在却出现删除行 → 立即停止，说明逻辑错误
#   例外：official-skills.generated.json —— 重新打包是整段重新序列化，
#   同一处必然同时出现 - 和 + 两行，那是覆盖写不是删条目，不适用幽灵判据
#   （与 6.4 的白名单同一口径，两处必须一起改，别只改一边）

# 幽灵计数只看文档/索引那部分，不能把生成物的覆盖写算进来
git diff --stat -- doc/ .claude/skills/ .agents/skills/
# 期望：删除行数 = 幽灵条目数（精确匹配，不多不少）

git diff --stat -- prd-api/src/PrdAgent.Api/OfficialSkills/
# 期望：本轮改了技能才有输出；没改技能却有 diff → 停止，它不是本轮的产物
```

### Step 4.5 — 未偿 D4 债务的硬闸（必须在提交前判定）

审计输出里 `BLOCK:` 那一类无法安全自动修复（整份 SKILL.md 缺失、description 缺失、
frontmatter 语法坏、name 空值或与目录不一致、技能根整个不存在）。**只把它们写进 PR 正文
不算处理**——本技能后面的 Step 6.5 会自己 squash 合并，写在正文里的债务会连同 PR 一起被
合并掉，等于走了个过场。

判据只认审计的输出契约（`AUTOFIX_NAME:` / `BLOCK:` 两种前缀，见 Step 1）。**不要在这里
另起一套自己的标记名**——本技能此前用过 `MISSING_SKILL_MD` 之类的自造名，审计从来不输出
它们，于是闸门和模板都在匹配一个不存在的字符串。

所以在提交之前判定：

闸门**自己重跑一遍审计**，不读任何来自前面步骤的变量——上一版读的 `$D4_SCAN_OUTPUT`
从来没有被赋值过，真实运行时恒为空，闸门永不触发。**一个永不触发的闸门比没有闸门更糟**，
因为它让人以为这里被守住了。重跑只花毫秒级。

```bash
BLOCKERS=$(python3 scripts/doc-readability-check.py --skills-audit | grep '^BLOCK: ' || true)

if [ -n "$BLOCKERS" ]; then
  echo "[BLOCKED] D4 有无法自动修复的条目，本轮不自动合并："
  printf '%s\n' "$BLOCKERS"
fi
```

命中时的强制动作：

- 其余维度（D1/D2/D3/D6）已修好的照常提交推送，**不要丢弃已完成的工作**
- PR 正文必须填「需人工处理」小节，标题加前缀 `[需人工] `
- **跳过 Step 6.5 的自动合并**，改为在 PR 里留一条说明：缺什么、为什么不能自动补、需要人做什么
- 不得因为「其它维度都干净了」就判本轮无欠债，也不得写占位 description 来凑合并条件

判据口诀：**能自动修的修掉，修不了的就别让它悄悄合并进去。**

### Step 5 — 收尾与推送

```bash
# 1. 生成本次 changelog 碎片（用实际数字替换 N）
#
# 说明只能写在 heredoc 外面。碎片内容必须是纯表格行（共用规则 §4），
# assemble-changelog.sh 发版时原样拼进 CHANGELOG——写进 heredoc 的注释行
# 会照字面进碎片，最后变成正式变更日志表格里的垃圾行。
#
# D4 修了技能就在下面多加一行，模块列写 claude-md，别混进 doc 那行：
#   | chore | claude-md | 熵清理：D4 补 N 个技能的 frontmatter name |
cat > "changelogs/$(date +%Y-%m-%d)_entropy-cleanup.md" << 'EOF'
| chore | doc | 熵清理：D1 N 个，D2 +N/-N，D3 +N/-N，D6 N 条 |
EOF

# 2. Stage 并提交
git add doc/ changelogs/ .claude/ .agents/skills/ prd-api/src/PrdAgent.Api/OfficialSkills/
git commit -m "chore: 日常熵清理 $(date +%Y-%m-%d)"

# 3. 推送（当前分支即目标分支，scheduled run 自带隔离分支）
git push -u origin $(git branch --show-current)
```

### Step 6 — 自动创建 PR、核查内容后手动合并（必须执行）

推送完成后立即执行以下步骤，**不得省略**。这是本技能从"推代码"升级为"自动交付"的核心：Agent 自己建 PR、自己通读内容核查、核查通过后自己 squash 合并，**不把合并决定权交给仓库 auto-merge 开关**。

#### 6.1 判断是否需要创建 PR

- 若 `git log origin/main..HEAD --oneline` 输出为空（当前分支没有超过 main 的 commit），**跳过 PR 创建**并结束。
- 若当前分支是 `main`，**跳过 PR 创建**并结束（不能从 main 向 main 发 PR）。

#### 6.2 检查是否已有未合并的熵减 PR

使用 `mcp__github__list_pull_requests`（state=open, base=main）查询 `inernoro/prd_agent`。
- 若已有标题含「熵减计划」的 open PR：
  - **标题以 `[需人工] ` 开头的一律跳过**，不得合并。那是上一轮被 D4 硬闸挡下的 PR，
    里面带着未修复的可发现性缺陷；无条件合并它等于把硬闸的作用推迟一轮就作废
    （这正是硬闸要防的事）。留给人处理，本轮继续创建新 PR。
  - **其余的也不在本步合并**，只记录 PR 号并继续创建新 PR。

    原因：本步能跑的审计只覆盖调度器**当前 checkout**，而要合的是**另一个 PR 的 head**。
    当前分支干净不代表那个 PR 干净——拿此处的绿灯去批准彼处的合并，是在用一份不相干的
    证据放行。旧版这里是完全无校验的直接合并，本次不再补一个「看起来像校验」的动作，
    而是把这个不安全的自动合并去掉。

    旧 PR 由人处理，或等它自己那轮的 Step 6 流程走完。要恢复自动合并，必须先实现
    「在被合并 PR 的 head 上跑审计」，而不是在当前分支上跑（见 `doc/debt.platform.agent-rule-scope.md`）。

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
- D4 技能可发现性：补缺 N 条
- D6 changelog→doc：本次处理 N 条，manifest 累计 M 条

## 改动 diff
（**按本轮真实改动的文件列，没动的行删掉；D4 修了技能就必须列出来**——这些 PR 会被自动审阅合并，
摘要漏了文件等于审阅者看不到那处改动，也违反共用规则 §5.4「改动 diff 逐条列文件或模块」）
- `doc/index.yml`：补缺/删幽灵条目
- `doc/guide.list.directory.md`：补缺/删幽灵条目
- `.claude/skills/<name>/SKILL.md`：D4 补 frontmatter 的 name（仅当本轮 FIXED_SKILL_NAME 非空）
- `.agents/skills/<name>/SKILL.md`：同上，Codex 侧技能根（仅当本轮有修复）
- `prd-api/src/PrdAgent.Api/OfficialSkills/official-skills.generated.json`：D4 修的技能进了官方套装，随之重新生成（仅当本轮真有技能改动）
- `changelogs/.entropy-manifest.yml`：新增已处理 changelog 记录
- `changelogs/YYYY-MM-DD_entropy-cleanup.md`：本次 changelog 碎片

## 需人工处理（Step 4.5 的 $BLOCKERS 非空则必填，否则删除本节）
（**逐条照抄审计输出的原因**，别改写成「见 D4 说明」——PR 会被留下等人处理，
读它的人手上只有这段正文，原因丢了他就得自己重跑一遍审计才知道缺什么）
- `<审计给出的技能根/name>`：<审计给出的原因原文>

## 测试
- [x] 双向扫描完成，diff 核验通过
- [x] 运行两次验证：第二次净变更为 0
```

#### 6.4 检查 PR 内容（合并前强制，不得跳过）

合并前必须逐项核查 PR 的真实改动，确认是「干净的文档/索引熵清理」而非误删或越界：

1. 调用 `mcp__github__pull_request_read`（method=`get`）确认 `mergeable_state`：
   - `behind` → 先调 `mcp__github__update_pull_request_branch` 把 main 合进来，再继续
   - `dirty`（有冲突）→ 本地拉取 + 解决冲突 + force-push（manifest 冲突一律 `--ours`，guide.list/doc 内容冲突手动合并两边精华），不得盲目合并
   - `clean` / `unstable` → 可继续
2. 调用 `mcp__github__pull_request_read`（method=`get_diff`）通读 diff，逐条核对：
   - 所有 `-`（删除）行：必须是真实「幽灵条目」（对应 `doc/${key}.md` / `.claude/skills/${name}/` 确实不存在）。**发现删除了仍存在的文件对应条目 → 立即停止，不合并，通知用户**。**唯一例外是下面那个生成物**——重新打包会把技能内容整段重新序列化，同一处必然同时产生 `-` 与 `+` 两行，那是覆盖写不是删条目，套「幽灵」判据会把合法的重生成一律判死
   - 所有 `+`（追加）行：仅限 `doc/index.yml` / `doc/guide.list.directory.md` / 技能的 `SKILL.md` frontmatter / `changelogs/` / manifest，外加下面这一个生成物，不得有代码文件（`.cs`/`.ts`/`.tsx` 等）混入
   - `prd-api/src/PrdAgent.Api/OfficialSkills/official-skills.generated.json` 是**唯一允许出现的生成物**，且只在本轮真的改了技能时才允许——它是 Step 3 重新生成、Step 5 一并提交的分发包。**本轮没有 `SKILL.md` 改动却出现它 → 按越界处理，不合并**（那说明它来自别处，不是本轮熵减的产物）
   - `changed_files` 应全部落在文档/索引/changelog/技能元数据、以及上面那个生成物的范围内
3. 任一核查不通过 → **不合并**，发通知说明问题，等用户裁决。

#### 6.5 手动 squash 合并（核查通过后）

内容核查全部通过、**且 Step 4.5 未命中 D4 硬闸**时，由 Agent 直接调用 `mcp__github__merge_pull_request` 完成合并（**不依赖仓库 auto-merge 开关**）。命中硬闸时跳过本步，PR 留待人工处理：
```
owner:         inernoro
repo:          prd_agent
pullNumber:    <PR number>
merge_method:  squash
commit_title:  每日熵减计划 YYYY-WXX — <本次主要修复内容>
```

合并成功后记录返回的 SHA。**禁止**调用 `mcp__github__enable_pr_auto_merge` 把合并决定权交给仓库设置——熵减 PR 的合并必须经过本技能 6.4 的内容核查这道闸。

#### 6.6 收尾

- 合并成功 → 记录 SHA，结束任务。
- 若 6.4 发现 PR `dirty` 需要本地解冲突，解完 force-push 后回到 6.4 重新核查再合并。
- 全程**禁止**用 `sleep` 空转轮询；合并是同步调用，拿到结果即结束。

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
- **合并前核查**：合并前必须走 6.4 内容核查（diff 通读 + 删除行幽灵验证 + 无代码混入），核查通过才合并
- **手动 squash 合并**：由 Agent 调 `mcp__github__merge_pull_request`（squash）直接合并，**不依赖仓库 auto-merge 开关**，也不调 `enable_pr_auto_merge`——合并必须过技能内容核查这道闸
- **去重保护**：创建前先查 open PR，有同类 PR **不合并**，只记录 PR 号后继续创建新 PR（旧 PR 的 head 无法在本地审计，见 6.2）
- **无净变更跳过**：当前分支没有超过 main 的 commit 时，不创建 PR（幂等运行不产生空 PR）

---

## 幂等性自检清单

- [ ] D2/D3/D4 补缺：写入前 `grep -q` 确认不存在
- [ ] D2/D3 删幽灵：删除前 `[ -f ]`/`[ -d ]` 确认文件/目录真实不存在（D4 无删幽灵方向）
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
