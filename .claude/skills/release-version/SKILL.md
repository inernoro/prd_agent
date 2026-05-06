---
name: release-version
description: 一键发版本。用户说"发布版本：X.Y.Z"或"发版"时触发，自动盘点用户级改动、起草 release notes、调 release-prepare 备料、调 quick.sh release 完成 tag + push。所有 emoji 输出严格禁止（CLAUDE.md 规则 #0）。
---

# Release Version

把"发版本"压成两步：用户给版本号 → AI 起草 + 调脚本 → 收尾确认。

## 触发词

| 用户说 | 行为 |
|---|---|
| "发布版本：1.9.0" / "发版本：v1.9.0" | 直接用这个版本号，跳过推荐 |
| "发版" / "请发版本" / "release" / "bump version" | AI 分析提交后推荐版本号，等用户确认 |

## 关键依赖（**必须用、禁止绕过**）

| 命令 | 作用 |
|---|---|
| `./quick.sh release-prepare X.Y.Z --notes-stdin` | **唯一允许的**备料入口：合并 `changelogs/` 碎片 + 包裹 CHANGELOG `[未发布]` → `[X.Y.Z] - 日期` + 插入"用户更新项" bullet + commit |
| `./quick.sh release X.Y.Z` | **唯一允许的**发布入口：同步 `prd-desktop/` 三个版本文件 + commit + tag + push |
| `bash scripts/assemble-changelog.sh` | 仅供 release-prepare 内部调用，技能流程禁止单独使用 |

> **警告**：禁止用 `Edit` / `sed` 直接改 `CHANGELOG.md` 的版本头或 `[未发布]` 标记。所有结构化变更必须走 `release-prepare.sh`，否则会破坏脚本依赖的锚点格式。

## 全程禁止 Emoji（CLAUDE.md 规则 #0）

- 用户更新项 bullet 一律纯文字，禁止 `rocket` `sparkles` `bug` `boom` 等任何 emoji 字符
- 提示用户的对话也不要用 emoji
- 历史 CHANGELOG 已存在的 emoji（如 1.8.3 的 `> rocket **用户更新项**`，注：`rocket` 处实际是 emoji 字符）算遗留债务，新发版本不得复刻该模式
- 包裹格式以 release-prepare 输出为准：`> **用户更新项**`（无 emoji 前缀）

## 执行流程

### Phase 1：识别版本号

```
若用户消息含 "发布版本：X.Y.Z" / "发版本：vX.Y.Z" / 直接给的版本号
    → 提取 → 跳到 Phase 3
否则
    → Phase 2 推荐
```

### Phase 2：推荐版本号（仅当用户没给）

跑这几条收集信息：

```bash
git tag --sort=-v:refname | head -3                          # 最近 tag
cat prd-desktop/package.json | grep '"version"'              # 当前版本
git log $(git describe --tags --abbrev=0 2>/dev/null || git rev-list --max-parents=0 HEAD)..HEAD --oneline | wc -l   # 提交数
git log $(git describe --tags --abbrev=0 2>/dev/null || git rev-list --max-parents=0 HEAD)..HEAD --oneline | head -30
ls changelogs/*.md 2>/dev/null | wc -l                       # 待合并碎片数
```

判定规则：

| 信号 | 建议 |
|---|---|
| 仅 fix/refactor/chore/docs，碎片 < 20 | Patch |
| 含 feat 或 perf；碎片 20-100；新增 ≥ 3 文件 | Minor |
| commit message 含 `BREAKING CHANGE` 或 `!:`；删除/重命名核心模块 | Major |

输出给用户（**不带 emoji**）：

```
当前版本：v1.8.3
建议新版本：v1.9.0（Minor）
理由：自上次发版有 X 个提交，含 N 条 feat（海鲜市场、涌现探索器…），变更量约 ±YYY 行
（也可选 v1.8.4 Patch / v2.0.0 Major）

确认 v1.9.0 还是改其他？
```

等用户确认后进 Phase 3。

### Phase 3：起草"用户更新项"

来源：

```bash
ls changelogs/*.md                                                  # 本轮待合并碎片
cat changelogs/*.md | grep -E '^\| (feat|perf|fix) \| '             # 已分类的条目
git log $(git describe --tags --abbrev=0)..HEAD --oneline           # 提交摘要
```

挑选规则：

- **优先**：`feat | prd-desktop`、`feat | prd-admin`、`feat | prd-api`（用户能感知）
- **优先**：`perf` / `fix` 中影响主流程的（性能改善、用户报障的 bug 修复）
- **不要进 bullet**：`chore | *` / `docs | *` / `refactor | *`（除非是大重构且用户感知）
- **不要进 bullet**：纯基础设施（CDS / scripts / rules）—— 桌面用户感知不到
- 5-7 条上限。多余的让脚本自动产出的明细表格承载

写法约束：

- 一句话讲完一件事，不要分号堆叠
- 给非技术用户看，禁止 jargon（"compute-then-send"、"flushSync"、"SSE keepalive" 都不要）
- 禁止 emoji
- 引号统一用中文引号
- 禁止 "本次"、"该版本" 之类元描述

输出给用户：

```
以下是我起草的 5 条用户更新项，请 review：

1. 桌面登录页人性化：新增"记住用户名"勾选、密码显隐切换、大写锁定提示
2. 知识库文档支持重命名 + 文档右键菜单扩展
3. 更新通知弹窗新增"最近更新"列表
4. PRD 预览中 Word 转换 base64 图片现在可正常渲染
5. 海鲜市场（技能市场）上线

要改哪条 / 加哪条 / 删哪条，告诉我；都 OK 就回"确认"。
```

### Phase 4：等用户确认 bullets

可能反馈：

- "确认" / "OK" / "可以" → Phase 5
- "把 1 改成 XX" → 改完再让用户确认
- "加一条 ZZ" → 加完再让用户确认
- "重新写" → 回 Phase 3 调整

**禁止**：用户没明确说"确认"就进 Phase 5。

### Phase 5：调 release-prepare 备料

把确认的 bullets 用 `--notes-stdin` 喂给脚本（每行一条 bullet，无前缀）：

```bash
cat <<'EOF' | ./quick.sh release-prepare X.Y.Z --notes-stdin
桌面登录页人性化：新增"记住用户名"勾选、密码显隐切换、大写锁定提示
知识库文档支持重命名 + 文档右键菜单扩展
更新通知弹窗新增"最近更新"列表
PRD 预览中 Word 转换 base64 图片现在可正常渲染
海鲜市场（技能市场）上线
EOF
```

脚本会自动：
1. 跑 `assemble-changelog.sh` 合并所有碎片
2. 把 `## [未发布]` 改成 `## [X.Y.Z] - YYYY-MM-DD`
3. 在版本头下插入 `> **用户更新项**` + bullets
4. 顶部预留新的 `## [未发布]`
5. `git add CHANGELOG.md changelogs/` + commit `docs(release): 备料 v X.Y.Z CHANGELOG`

跑完后给用户：

```
CHANGELOG.md 已就位。Review 一下：
  git log -1 --stat
  head -30 CHANGELOG.md
确认无误回"发布"，我就跑 quick.sh release X.Y.Z 完成 tag + push。
```

### Phase 6：等用户最终确认

可能反馈：

- "发布" / "OK" / "继续" → Phase 7
- "改 XX" → 用 git 撤销备料 commit 重做：
  ```bash
  git reset --soft HEAD~1
  # 调整 bullets 后重新 Phase 5
  ```

### Phase 7：发布

```bash
./quick.sh release X.Y.Z
```

会自动：
1. 校验 working tree 干净（备料 commit 后应该干净）
2. 校验 tag 不存在
3. 同步 `prd-desktop/package.json` + `tauri.conf.json` + `Cargo.toml`
4. `git commit -m "chore(release): bump version to X.Y.Z"`
5. `git tag vX.Y.Z`
6. `git push` + `git push origin vX.Y.Z`

跑完汇报：

```
v X.Y.Z 已发布：
- CHANGELOG.md：## [X.Y.Z] - YYYY-MM-DD（已包裹）
- changelogs/：碎片已清空
- 三个版本源文件已同步至 X.Y.Z
- git tag vX.Y.Z 已推送
- GitHub Actions 正在构建桌面产物：https://github.com/inernoro/agent/actions

桌面用户下次打开应用时 auto-updater 会拉到 vX.Y.Z 的更新弹窗，body 取自"用户更新项"段。
```

## 边界情况

### `changelogs/` 是空的

`release-prepare.sh` 内部的 `assemble-changelog.sh` 会打印"没有碎片需要合并"然后正常进入版本头包裹环节——不阻塞。但要警告用户：

```
注意：本轮 changelogs/ 没有任何碎片。
可能原因：
1. 自上次发版以来没人提交过代码（看 git log 确认）
2. 大家忘了写碎片（看 git log 有多少 commit 没对应碎片）

仍要继续发版吗？（通常用于 hotfix / 配置调整）
```

### 工作区有未提交改动

`release-prepare.sh` 不阻塞（会和 CHANGELOG 一起 commit），但 `quick.sh release` 会拒绝。提示用户：

```
当前工作区有未提交改动：
[git status --short 输出]
是要把它们一起算进备料 commit，还是先 stash？
```

### Tag 已存在

`release-prepare.sh` 在 `--dry-run` 之前就会检测并 abort：

```
git tag 'v X.Y.Z' 已存在，疑似重复发版
```

让用户确认是要换版本号还是删 tag 重发。

### CHANGELOG.md 已经有 `## [X.Y.Z]` 段

`release-prepare.sh` 检测到会 abort。提示用户：

```
CHANGELOG.md 已存在 ## [X.Y.Z]，要不要换 X.Y.Z+1？
```

### 用户跳过 Phase 4 直接说 "发布"

不允许。必须有用户更新项 bullet 才能进 Phase 5。可让用户用 `--no-notes` 强制跳过：

```
你确定不写用户更新项吗？桌面 auto-updater 弹窗会显示空内容。
要继续无 notes 发版回"强制发"。
```

确认后用 `./quick.sh release-prepare X.Y.Z --no-notes`。

## 反面案例（不要做）

- 用 `Edit` / `Write` / `sed` 直接改 `CHANGELOG.md` 的 `[未发布]` 标记
- 用 `Bash` 手敲 `git add prd-desktop/src-tauri/tauri.conf.json + git tag` 绕过 `quick.sh release`
- 在用户更新项里写技术 jargon（"flushSync 重构"、"compute-then-send" 之类）
- 在用户更新项里写 emoji
- 用户没确认 bullets 就 commit
- 跑 `--no-notes` 时不警告用户

## 命令速查

```bash
ls changelogs/*.md                                           # 看碎片堆了多少
git tag --sort=-v:refname | head -5                          # 最近 tag
git log $(git describe --tags --abbrev=0)..HEAD --oneline    # 上次 tag 之后的提交

./quick.sh release-prepare X.Y.Z --notes-file /tmp/notes.md   # 备料（文件）
./quick.sh release-prepare X.Y.Z --notes-stdin                # 备料（stdin）
./quick.sh release-prepare X.Y.Z --no-notes                   # 备料（无 notes，会警告）
./quick.sh release-prepare X.Y.Z --notes-file ... --dry-run   # 备料预览，不动盘

./quick.sh release X.Y.Z                                      # 完成发布（必须先备料）
```

## 依赖工具一览

| 文件 | 角色 |
|---|---|
| `scripts/release-prepare.sh` | 备料：合并碎片 + 包 CHANGELOG + commit |
| `scripts/assemble-changelog.sh` | release-prepare 内部用，技能流程不直接调 |
| `scripts/sync-desktop-version.sh` | quick.sh release 内部用，同步三个版本文件 |
| `quick.sh release-prepare` | release-prepare.sh 的入口 |
| `quick.sh release` | 完整发版（同步版本 + commit + tag + push） |
| `quick.sh version` | 仅同步版本号 + tag（调试用，技能流程不用） |
