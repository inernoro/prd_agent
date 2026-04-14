---
name: release-version
description: Automatically release a new version. Detects current version, analyzes recent changes, suggests version bump (patch/minor/major), and executes release. Trigger when user says "请发版本", "release", "发版", "bump version".
---

# Release Version

自动化版本发布流程：合并 changelog 碎片 → 包裹版本标题 → 同步桌面端版本号 → 打 tag → 推送。

## 触发词

- "请发版本"
- "发版"
- "release"
- "bump version"
- "发布新版本"

## 关键依赖

| 工具 | 路径 | 作用 |
|------|------|------|
| changelog 合并脚本 | `bash scripts/assemble-changelog.sh` | 把 `changelogs/*.md` 碎片合并到 `CHANGELOG.md` 的 `[未发布]` 段，并 git rm 碎片 |
| 版本同步 + tag + push | `./quick.sh release <version>` | 同步 `prd-desktop/` 三个版本文件 + commit + tag + push（**要求 working tree clean**）|
| 仅同步版本号 | `./quick.sh version <version>` | 只同步版本号 + 打 tag，不 commit，调试用 |

> ⚠️ **顺序不可乱**：`quick.sh release` 在 line 386 检查 `git diff --quiet HEAD`，working tree 必须干净。所以"合并碎片 + 包裹版本标题"必须先做完并 commit，才能调用 `quick.sh release`。

## 执行流程

### 0. 前置：合并 changelog 碎片（Phase 0，最容易被遗忘的一步）

每个 PR 在 `changelogs/` 留下一个碎片文件（CLAUDE.md 规则 #4）。发版前必须把这些碎片合并进 `CHANGELOG.md`，否则发版后碎片还堆着、用户更新弹窗看不到本次变更。

```bash
# Step 0.1: 看一下还有哪些碎片没合并
ls changelogs/*.md 2>/dev/null | grep -v "^changelogs/.gitkeep$" || echo "（无碎片）"

# Step 0.2: dry-run 预览将要插入的内容
bash scripts/assemble-changelog.sh --dry-run

# Step 0.3: 用户确认无误后真正合并
bash scripts/assemble-changelog.sh
```

合并脚本会自动：
1. 按日期分组所有碎片内容
2. 在 `CHANGELOG.md` 的 `## [未发布]` 段下插入合并后的表格
3. `git rm` 碎片文件

**如果 `changelogs/` 是空的**：跳过这一步，直接进入 Phase 1。

### 0.5 包裹版本标题（手工编辑 CHANGELOG.md）

合并后的 `CHANGELOG.md` 现在是这样：

```markdown
## [未发布]

### 2026-04-14

| 类型 | 模块 | 描述 |
|------|------|------|
| feat | prd-admin | 新增 XX 功能 |
...
```

需要手工把这些条目"封装"成一个版本块，让 Tauri 自动更新弹窗 / GitHub Release Notes 能读到。包裹格式见 `CHANGELOG.md` 末尾的「维护规则 → 版本发布标记」：

```markdown
## [1.7.0] - 2026-04-14

> 🚀 **用户更新项**
> - 新增 XX 功能（一句话给最终用户看的）
> - 修复 YY 问题
> - 桌面端 ZZ 优化

### 2026-04-14
（保留原有日条目）

| 类型 | 模块 | 描述 |
| ... |

---

## [未发布]
（清空，从这里开始接收下一轮）
```

**关键约束**：
- `用户更新项` 区块用人话写 3-6 条最重要变更，**给非技术用户看**——因为这是 Tauri 弹窗里展示的 release notes
- 类型列里的 `chore` `docs` `refactor` 一般不进 `用户更新项`
- 包裹完后 `## [未发布]` 段必须留空（保留标题和标题下一行空行），下次发版继续从这里追加

### 0.6 提交 CHANGELOG.md 改动

```bash
git add CHANGELOG.md changelogs/    # changelogs/ 因为 git rm 了碎片，也要 add
git commit -m "docs: prepare CHANGELOG for v{version}"
```

**这一步必须做**，否则下一步 `quick.sh release` 会因为 working tree 不干净而拒绝执行。

### 1. 获取当前版本信息

```bash
# 获取最新 tag
git tag --sort=-v:refname | head -1

# 查看当前 package.json 中的版本
cat prd-desktop/package.json | grep '"version"'
```

### 2. 分析自上次发版以来的变更

```bash
# 获取上次 tag 以来的所有提交
git log $(git describe --tags --abbrev=0)..HEAD --oneline

# 查看变更的文件统计
git diff --stat $(git describe --tags --abbrev=0)..HEAD

# 查看变更的文件列表
git diff --name-only $(git describe --tags --abbrev=0)..HEAD
```

### 3. 判断版本增幅级别

根据变更内容判断应该增加哪个级别的版本号：

#### Patch (x.y.Z) - 默认选择
适用于：
- Bug 修复
- 小型 UI 调整（样式、文案）
- 代码重构（不影响功能）
- 依赖更新（非破坏性）
- 文档更新

**关键词**: fix, refactor, style, chore, docs, update, enhance, tweak

#### Minor (x.Y.0) - 需要提醒用户确认
适用于：
- 新功能添加
- 功能增强（非破坏性）
- 新增 API 端点
- 新增页面或组件
- 较大的 UI 改版

**关键词**: feat, add, implement, new, feature, 新增, 添加, 实现

**触发条件**:
- 新增超过 3 个文件
- 变更超过 500 行代码
- 提交信息包含 `feat:` 或 `add` 开头

#### Major (X.0.0) - 必须提醒用户确认
适用于：
- 破坏性变更（Breaking Changes）
- 不兼容的 API 修改
- 架构重大调整
- 依赖大版本升级
- 功能移除

**关键词**: breaking, remove, deprecate, migrate, 重构, 迁移

**触发条件**:
- 提交信息包含 `BREAKING CHANGE` 或 `!:`
- 删除超过 10 个文件
- 重命名核心模块

### 4. 询问用户确认

根据分析结果，向用户展示：

```
## 版本发布分析

**当前版本**: v1.5.2
**建议新版本**: v1.5.3 (Patch)

### 自上次发版的变更 (共 X 个提交)

- abc1234 Fix: 修复某某问题
- def5678 Refactor: 重构某某模块
- ...

### 变更统计
- 新增文件: X
- 修改文件: Y
- 删除文件: Z
- 代码变更: +XXX / -YYY 行

### 判断依据
本次变更主要是 Bug 修复和小型调整，建议 Patch 版本。

是否继续发布 v1.5.3？
```

如果检测到可能需要 Minor 或 Major：

```
⚠️ 检测到以下重大变更，建议考虑升级版本级别：

- 新增了 3 个新功能模块
- 代码变更量超过 800 行
- 包含 "feat: 实现新功能" 提交

建议选择：
1. v1.5.3 (Patch) - 仅小版本修复
2. v1.6.0 (Minor) - 包含新功能 [推荐]
3. v2.0.0 (Major) - 重大版本升级

请选择版本号：
```

### 5. 执行发版

**前置确认**（每条都必须 ✅）：
- [ ] `changelogs/` 已通过 `bash scripts/assemble-changelog.sh` 合并完毕（或本来就是空的）
- [ ] `CHANGELOG.md` 的新版本已包裹成 `## [X.Y.Z] - YYYY-MM-DD` 标题 + `> 🚀 用户更新项` 区块
- [ ] CHANGELOG.md 改动已 commit
- [ ] `git status` 输出 `working tree clean`

用户确认后执行：

```bash
# 使用项目的发版脚本（v 前缀可有可无，脚本会自动剥离）
./quick.sh release 1.5.3
```

此命令按 `quick.sh:361 release_version()` 顺序自动：
1. **预检**：working tree 必须 clean（`git diff --quiet HEAD`），否则直接退出
2. **预检**：tag 不能已存在
3. **同步版本号**：调用 `scripts/sync-desktop-version.sh` 改三个文件：
   - `prd-desktop/src-tauri/tauri.conf.json`
   - `prd-desktop/src-tauri/Cargo.toml`
   - `prd-desktop/package.json`
4. **commit**：`git commit -m "chore(release): bump version to 1.5.3"`（只 add 上述三个文件）
5. **打 tag**：`git tag v1.5.3`
6. **推送**：`git push` + `git push origin v1.5.3`
7. GitHub Actions 触发 desktop 构建和 release 发布

### 6. 发版后确认

```
✅ 版本 v1.5.3 发布成功！

- CHANGELOG.md: ## [1.5.3] - 2026-04-14（已包裹）
- changelogs/:  已清空（碎片已合并）
- Git commits: 2 个
  - docs: prepare CHANGELOG for v1.5.3
  - chore(release): bump version to 1.5.3
- Git tag: v1.5.3
- Push 完成

GitHub Actions 正在构建发布包...
查看进度: https://github.com/inernoro/prd_agent/actions
```

**主动告知用户**：
- Tauri 桌面端的"自动更新"弹窗会在用户下次打开应用时显示，body 取自 `## [1.5.3]` 下面的 `> 🚀 用户更新项` 区块
- 如果用户更新项写得敷衍（或漏写），弹窗里也会显得敷衍。这一步不要省事

## 版本号计算示例

| 当前版本 | Patch | Minor | Major |
|---------|-------|-------|-------|
| 1.5.2   | 1.5.3 | 1.6.0 | 2.0.0 |
| 2.0.0   | 2.0.1 | 2.1.0 | 3.0.0 |
| 0.9.9   | 0.9.10| 0.10.0| 1.0.0 |

## 特殊情况处理

### `changelogs/` 还有未合并的碎片

**这是最高优先级的检查**——必须在做任何其他事之前先处理。

```bash
ls changelogs/*.md 2>/dev/null | grep -v ".gitkeep"
```

如果有输出：
```
⚠️ 发现 N 个未合并的 changelog 碎片：
- changelogs/2026-04-14_xxx.md
- changelogs/2026-04-13_yyy.md
- ...

必须先合并这些碎片到 CHANGELOG.md，否则发版后这些变更不会出现在用户更新项里。

执行 `bash scripts/assemble-changelog.sh --dry-run` 预览？
```

**禁止**：跳过碎片合并直接发版。这会导致：
1. 下次发版时这批碎片会被合并到下个版本里，造成版本归属错误
2. Tauri 自动更新弹窗看不到本次变更
3. GitHub Release Notes 缺失内容

### CHANGELOG.md 的 `[未发布]` 段是空的

发版前必须确认 `[未发布]` 段下确实有内容（合并完碎片后）。如果是空的：

```
ℹ️ CHANGELOG.md 的 [未发布] 段是空的。

可能原因：
1. 这一轮没有任何 PR 留过碎片 → 检查 git log 确认
2. 上次发版后忘了从 [未发布] 段开始接收新条目 → 检查模板格式

是否仍要发版？（不推荐，除非是热修复 / 配置变更）
```

### 工作区有未提交的更改

```
⚠️ 检测到未提交的更改：
[显示 git status]

quick.sh release 在 line 386 会拒绝执行（git diff --quiet HEAD 检查）。

请先：
1. 把 CHANGELOG.md 的改动 commit
2. 把其他无关改动 stash 或 commit
3. 然后重新执行 ./quick.sh release <version>
```

### 没有新的提交
```
ℹ️ 自上次发版 (v1.5.2) 以来没有新的提交。

是否仍要发布新版本？这通常用于：
- 修复发布配置问题
- 重新触发 CI/CD
```

### Tag 已存在
```
❌ Tag v1.5.3 已存在！

可选操作：
1. 使用下一个版本 v1.5.4
2. 删除现有 tag 并重新发布（谨慎，需要 git tag -d + git push origin :refs/tags/v1.5.3）
```

### 用户跳过了"包裹版本标题"步骤

如果用户只跑了 `bash scripts/assemble-changelog.sh` 和 `./quick.sh release` 但没手工包裹 `## [X.Y.Z] - YYYY-MM-DD` 标题：

后果：发版成功但 CHANGELOG 里的条目仍然挂在 `[未发布]` 段下。Tauri 弹窗读不到 release notes。

补救：重新编辑 CHANGELOG.md 把条目挪到 `## [X.Y.Z] - YYYY-MM-DD` 标题下，commit 一个 `docs: backfill release notes for v1.5.3`，但这不会回填到已发布的 GitHub Release Notes（需要去 GitHub 手动编辑）。

**最佳做法**：发版前必须主动询问用户"用户更新项里要写哪几条"，引导他完成包裹。

## 相关命令

```bash
# 看碎片
ls changelogs/*.md

# 合并碎片（dry-run）
bash scripts/assemble-changelog.sh --dry-run

# 真正合并
bash scripts/assemble-changelog.sh

# 仅同步版本号（不创建 commit/tag）
./quick.sh version <version>

# 完整发版流程（要求 working tree clean）
./quick.sh release <version>

# 查看最近的 tags
git tag --sort=-v:refname | head -10

# 查看某个 tag 的详情
git show v1.5.2
```

## 完整最小流程速记

```bash
# 1. 合并碎片
ls changelogs/*.md && bash scripts/assemble-changelog.sh

# 2. 手工编辑 CHANGELOG.md：
#    - 把 [未发布] 下的条目包成 ## [1.5.3] - 2026-04-14 标题
#    - 在标题下方加 > 🚀 用户更新项 + 3-6 条人话
#    - [未发布] 段留空

# 3. commit
git add CHANGELOG.md changelogs/
git commit -m "docs: prepare CHANGELOG for v1.5.3"

# 4. 发版
./quick.sh release 1.5.3
```
