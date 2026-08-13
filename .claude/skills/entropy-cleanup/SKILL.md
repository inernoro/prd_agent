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
# 先拿到审计的完整输出和退出码，再判——不能把两件事挤进一条管道。
# `... | grep '^BLOCK: ' || true` 那种写法会把审计崩溃（比如某个 SKILL.md
# 不是 UTF-8，读取时抛异常）读成「没有 BLOCK 行」= 干净，闸门 fail-open。
AUDIT_OUT=$(python3 scripts/doc-readability-check.py --skills-audit 2>&1)
AUDIT_RC=$?
BLOCKERS=$(printf '%s\n' "$AUDIT_OUT" | grep '^BLOCK: ' || true)

if [ "$AUDIT_RC" -ne 0 ] && [ -z "$BLOCKERS" ]; then
  # 非零却一条 BLOCK 都没有 = 审计自己出错了，不是「干净」。一律当阻塞。
  echo "[BLOCKED] 技能审计异常退出（rc=$AUDIT_RC），无法判定是否干净，本轮不自动合并："
  printf '%s\n' "$AUDIT_OUT"
  BLOCKERS="审计异常退出 rc=$AUDIT_RC"
elif [ -n "$BLOCKERS" ]; then
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

#### 6.2 检查是否已有未合并的熵减 PR（在其 head 上审计并上报，不擅自合并）

使用 `mcp__github__list_pull_requests`（state=open, base=main）查询 `inernoro/prd_agent`。
- 若已有标题含「熵减计划」的 open PR：
  - **标题以 `[需人工] ` 开头的一律跳过**，不得合并。那是上一轮被 D4 硬闸挡下的 PR，
    里面带着未修复的可发现性缺陷；无条件合并它等于把硬闸的作用推迟一轮就作废
    （这正是硬闸要防的事）。留给人处理，本轮继续创建新 PR。
  - **其余的每一个都要在它自己的 head 上跑审计**，不是在当前分支上跑——当前分支干净
    不代表那个 PR 干净，拿此处的绿灯去批准彼处的合并是在用一份不相干的证据放行。

    做法（`git fetch` 一次只带一个 ref 目标，避免 `FETCH_HEAD` 落到哪一个取决于命令行
    顺序的歧义；仓库常见浅克隆，历史不够棘轮会因为找不到公共祖先直接失败，`--unshallow`
    只对浅克隆有效、对完整仓库跑会报错，所以失败就回退普通 fetch——一次成功后整个本地
    仓库对该 remote 就是完整历史，第二条 fetch 不需要再补）：

    ```bash
    git fetch origin main --unshallow 2>/dev/null || git fetch origin main
    git fetch origin <该PR的head分支>
    git worktree add <临时目录> FETCH_HEAD
    ```

    **用 worktree，禁止直接 `git checkout <sha>`**——那会 detach 当前工作区的 HEAD，
    Step 6.3 取当前分支名会拿到空字符串，后续创建 PR 直接断掉。在这个临时 worktree 里
    重跑一遍 D1-D4 双向扫描 + `doc-readability-check.py --ratchet --baseline-ref origin/main`
    （**必须带 `--baseline-ref`**，否则比对的是那个历史 PR 自己提交时冻结的基线文件——
    它可能比当前 main 的基线更宽松，会把「相对现在 main 其实在退步」的欠账放绿灯放过去；
    CI 自己跑 ratchet 也是带 `--baseline-ref` 调用，这里对齐同一口径），再用
    `mcp__github__pull_request_read`（method=`get_diff`）对这个 PR 走一遍 **6.4 同款内容
    核查**（删除行是否真是幽灵、追加行范围是否仅限 doc/changelog/技能元数据、有没有混入
    代码文件或不属于本轮的生成物）。审计完成后 `git worktree remove <临时目录>`，确保
    当前工作分支分毫未动。

    - 结构审计（D1-D4+棘轮）与 6.4 内容核查**都**通过，且 `mcp__github__pull_request_read`
      （method=`get`）返回的 `mergeable_state` 为 `clean`（无冲突、必需检查全绿）→ **不要
      直接调用合并工具**。仓库策略是 PR 默认保持 Ready、关闭自动合并，未经用户明确指示
      不得合并（`AGENTS.md` §5.5）——这条对历史 PR 同样成立，且历史 PR 的作者是另一个
      会话，比当天自己产出的 PR 更需要一次人的眼睛过一遍。把审计结论（干净，可合并）
      连同 PR 号写进本轮新 PR 的「已知（非本轮阻塞）」小节，请用户确认后再合并，不要
      替用户按下合并键。
    - `mergeable_state` 为 `unstable`（无冲突，但有必需检查未过——GitHub `MergeStateStatus`
      对 `UNSTABLE` 的定义就是「可合并但状态检查未全绿」）→ **不算「干净可合并」**，本地
      D1-D4/棘轮/6.4 只覆盖文档结构与 diff 范围，不代表该 PR 真实 CI 全绿。记「#N 无冲突
      但 CI 检查未过，需先看该 PR 自己的 check 状态再决定是否合并」，与 `clean` 分开报告，
      不要混进「可合并」那一类。
    - `mergeable_state` 为 `behind`（分支落后于 main，无实质冲突只是没更新）→ 同样只
      报告不处理：记「#N 落后于 main N 个提交，建议合并前先更新分支」，不擅自
      `update_pull_request_branch` 或 rebase 它——那仍然是对另一个会话产出的分支做写
      操作，交给用户或它自己下一轮跑。
    - `mergeable_state` 为 `dirty`（真冲突，通常是 `changelogs/.entropy-manifest.yml` 尾部
      追加点撞车）→ **禁止自动 rebase/强解冲突**（那需要判断哪些内容已被后续 PR 覆盖、
      哪些仍缺失，属于需要人工判断的场景，机械脚本不做这个决策）。只记录该 PR 号、
      审计结果（干净/有缺陷）与冲突原因，继续创建本轮新 PR，把这些信息写进新 PR 的
      「已知（非本轮阻塞）」小节。
    - 6.4 内容核查不通过（发现幽灵删除、代码文件混入、越界改动）→ 明确标注「不建议合并，
      原因：xxx」，同样只报告不处理。
    - 审计发现该 PR 内容已被更晚合并的其它 commit 完全覆盖（manifest 条目已在 main、
      或对应设计文档章节已存在）→ 在新 PR 里记一句「#N 已无净新增价值，建议直接关闭」，
      不强行合并一个空转的 PR。
  - **连续 3 个以上未合并的历史熵减 PR 时视为积压信号**：本轮除了推进当天的 D1-D7，
    还要在 PR 正文里显式列出每一个积压 PR 的审计结论（可合并 / 待人工解冲突 / 建议关闭），
    避免像 2026-08 那次一样堆到 6 个才被用户发现「怎么全是垃圾分支」。不要求当场解决
    所有冲突或替用户下合并决定（那超出机械审计范围），但**必须让积压可见**，不能只字
    不提地继续创建第 N+1 个新 PR。

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
