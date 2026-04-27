# CLAUDE.md

> PRD Agent 全栈项目。子目录 CLAUDE.md 含各模块构建命令，`.claude/rules/` 含按需加载的架构规则。

---

## 0. 禁止任何 Emoji（最高优先级，先于一切其他规则）

**本系统任何项目（`prd-api/`、`prd-admin/`、`prd-desktop/`、`prd-video/`、`cds/`、`doc/`、`changelogs/`、提交信息、PR 描述、UI 渲染输出、聊天回复）一律不允许出现 emoji 字符。**

适用范围：
- 代码字面量（任何 `'<emoji>'` / `"<emoji>"` / 模板字符串里的 emoji）—— 一律 reject
- UI 文案（按钮标签、tooltip、空状态、toast、表头）—— 一律 reject
- 文档 Markdown（README / doc/*.md / changelogs/*.md / 注释）—— 一律 reject
- Commit message / PR title / PR body —— 一律 reject
- 给用户的回复正文（除非用户明确粘贴 emoji 让 Claude 复述）—— 一律 reject

替代方案：
- 状态/类型用 **SVG icon**（前端项目已有 ICON 注册表 / lucide-react / cds 的 `ICON.*`）
- 重要程度用文案分级（"建议 / 警告 / 必填 / 已禁用"）
- 视觉强调走 CSS（颜色、加粗、底色），不走 emoji

例外（仅本节本身）：本规则正文为了说明"哪些字符算 emoji"，必要时会在 inline `code` 字面量里展示反面例子，比如 `'rocket'` / `'lightbulb'`。除此之外的任何 markdown / 代码 / UI 都一律拒收。规则标题、段落正文（含历史溯源段）一律不带 emoji 字符。

历史背景：用户 2026-04-27 第二次明确强调"本系统任何项目不允许使用任何的 emoji 图标"。第一次违反是分支卡 stats chips 用了 4 个 emoji（火箭/机器人/灯泡/向下箭头），已立刻修复。本规则置顶意在阻止再犯。

---

## 项目结构

```
prd_agent/
├── prd-api/          # .NET 8 后端 (C# 12)        → prd-api/CLAUDE.md
├── prd-admin/        # React 18 管理后台 (Vite)    → prd-admin/CLAUDE.md
├── prd-desktop/      # Tauri 2.0 桌面客户端        → prd-desktop/CLAUDE.md
├── prd-video/        # Remotion 视频合成
├── changelogs/       # 更新记录碎片（每 PR 一个文件，发版时合并）
├── doc/              # 编号文档 (spec/design/plan/rule/guide/report)
└── scripts/          # 构建/部署脚本
```

## 快速启动

```bash
# Docker Compose (推荐)
docker compose -f docker-compose.dev.yml up -d --build
# Web: localhost:5500, API: localhost:5000, Mongo: localhost:18081, Redis: localhost:18082

# Windows
.\quick.ps1           # Backend only
.\quick.ps1 all       # Server + desktop + admin
```

各模块构建命令见子目录 CLAUDE.md（`prd-api/`、`prd-admin/`、`prd-desktop/`）。

### Video (prd-video/) — Remotion 4.0

```bash
cd prd-video && pnpm install && pnpm start
```

---

## 强制规则

### 1. 前端包管理器：pnpm Only

所有前端项目（`prd-admin`、`prd-desktop`、`prd-video`）统一使用 **pnpm**，禁止 npm / yarn。
Lockfile 仅保留 `pnpm-lock.yaml`，禁止提交 `package-lock.json` 或 `yarn.lock`。

### 2. C# 静态分析

任何 `.cs` 改动完成后必须执行（详见 `prd-api/CLAUDE.md`）：

```bash
cd prd-api && dotnet build --no-restore 2>&1 | grep -E "error CS|warning CS" | head -30
```

- `error CS*`：必须修复
- `warning CS*`：评估是否为本次改动引入

### 3. 任务完成交接

完成开发任务后，**必须主动**使用 `task-handoff-checklist` 技能生成交接清单（涉及 3+ 文件变更、API 端点变更、或 UI 页面变更时）。1-2 个文件小修改无需生成。

### 4. 更新记录维护（Changelog Fragments）

对 `prd-api/`、`prd-admin/`、`prd-desktop/`、`prd-video/` 的任何代码变更（feat/fix/refactor/perf），**提交前必须**在 `changelogs/` 目录创建碎片文件，**禁止直接编辑 `CHANGELOG.md`**。

#### 碎片文件规则

- 文件名：`changelogs/YYYY-MM-DD_<短描述>.md`（如 `2026-03-19_safari-fix.md`）
- 内容为纯表格行（无表头），每行一条记录：
  ```
  | feat | prd-admin | 新增XX功能 |
  | fix | prd-api | 修复XX问题 |
  ```
- 同一 PR 的所有变更放在**一个碎片文件**中
- 纯文档变更（`doc/`）、纯 CLAUDE.md 规则调整可选记录

#### 发版合并

版本发布时执行 `bash scripts/assemble-changelog.sh`，自动将碎片文件按日期合并进 `CHANGELOG.md` 的 `[未发布]` 区域并删除碎片文件。

#### 为什么这样做

多分支并行开发时，直接编辑 `CHANGELOG.md` 会在同一位置插入内容导致 **必然冲突**。碎片文件各自独立，彻底消除合并冲突。

### 5. 提交与 PR 工作流

#### 5.1 Commit message 必须使用中文

所有 `git commit` 信息**必须用中文**撰写（标题 + 正文）。允许保留英文技术术语（API/SSE/createPortal 等专有名词）和 Conventional Commits 前缀（`feat`/`fix`/`refactor`/`perf`/`docs`/`chore`/`test`），其余表述一律中文。

```
✅ fix(prd-admin): 修复周报弹窗样式错乱
✅ feat(prd-api): 新增缺陷分享 SSE 流式推送
❌ fix: resolve modal styling issue
```

#### 5.2 测试全部通过后才推送 / 提 PR

`git push` 与创建 PR **前必须**跑通对应模块的本地校验，**任意一项失败都不得推送**：

| 改动范围 | 必跑校验 |
|----------|----------|
| `prd-api/` `.cs` | `cd prd-api && dotnet build --no-restore`（零 `error CS*`） |
| `prd-admin/` / `prd-desktop/` `.ts` `.tsx` | `pnpm tsc --noEmit` + `pnpm lint`（本次改动文件零新增告警） |
| 含单元/集成测试的模块 | `pnpm test` / `dotnet test` 对应套件全绿 |
| 本地缺 SDK 无法验证 | 必须走 `/cds-deploy` 远端编译，CDS 绿灯后才推送 |

#### 5.3 PR 创建条件

除非用户明确要求"提交 PR"/"创建 PR"/"提 PR"，否则**禁止自动创建 Pull Request**。
任务完成后只做 commit + push，不得擅自调用 PR 创建工具。
遇到阻塞无法完成的任务，向用户说明阻塞原因并等待指示，禁止提交半成品。

#### 5.4 PR 描述必须简洁注明 diff

被允许创建 PR 时，描述模板必须包含「改动摘要」段落，**简洁列出 diff 范围**（修改的文件/模块 + 一句话变更说明）。禁止只写一行标题就提交。

```markdown
## 摘要
1-3 句话说明 PR 解决了什么问题、用什么方案。

## 改动 diff
- `prd-admin/src/pages/report-agent/ReportDetailPage.tsx`：浏览记录 popover 改用 createPortal + inline style
- `changelogs/2026-04-19_xxx.md`：新增 changelog 碎片

## 测试
- [x] pnpm tsc --noEmit 通过
- [x] pnpm lint 本文件零新增告警
- [ ] 真人通过预览域名验收
```

### 6. LLM 交互过程可视化

任何涉及大模型调用的功能，**必须**向用户展示交互过程，禁止让用户面对空白等待：

- **流式输出**：LLM 响应必须使用 SSE 流式推送，前端逐字/逐块渲染（打字效果）
- **进度反馈**：批量 LLM 任务必须推送进度事件（如"正在分析第 3/45 个缺陷…"）
- **思考过程**：如果 LLM 支持 thinking，应展示思考过程
- **阶段提示**：长任务拆分阶段，每个阶段开始时推送状态（准备中 → 分析中 → 生成中 → 完成）
- **兜底方案**：如无法流式输出，至少显示动画加载状态 + 预估耗时提示

原则：用户在等待 AI 响应时，屏幕上必须有持续变化的内容。静止的"加载中…"超过 2 秒即为体验缺陷。

### 7. 新增 Model 必须对照现有 Model 写法

新建 MongoDB 实体类时，**必须先读一个现有同类 Model 文件**，对照其 Id 声明方式、属性标注、命名风格。禁止凭记忆或通用知识编写。

**具体规则**：
- Id 声明：`public string Id { get; set; } = Guid.NewGuid().ToString("N");`，不加 `[BsonId]` / `[BsonRepresentation]`
- 必须 `grep` 一个现有 Model（如 `DefectReport.cs`）确认格式后再写
- 获取用户 ID：`this.GetRequiredUserId()`，不用 `User.FindFirstValue("userId")`

**前端 service 层同样适用**：新建 `services/real/*.ts` 时，必须先读 `apiClient.ts` 的 `apiRequest` 签名。关键陷阱：
- `apiRequest` 内部会自动 `JSON.stringify(options.body)`，**调用方传原始对象，禁止再 `JSON.stringify`**
- ❌ `body: JSON.stringify({ title })` → 双重序列化，后端 400
- ✅ `body: { title }` → 正确
- FormData 上传不能走 `apiRequest`（会被 JSON 序列化），必须直接 `fetch`
- `apiRequest` 返回 `ApiResponse<T>` 格式 `{success, data, error}`，**用 `res.success` 判断，不是 `res.ok`**
- 错误信息是对象 `res.error?.message`，不是字符串 `res.error`

### 8. Agent 开发"完成"标准

功能开发声称"完成"前，**必须全部满足**以下条件：
- 后端编译零错误（本地 + CDS 环境双重验证）
- 前端页面可通过预览地址打开并正常渲染
- 核心业务流程端到端跑通（不是只有 CRUD）
- 直连预览域名测试（非 container-exec），模拟真实用户访问路径
- 依赖的外部服务（如 ASR 模型池）已确认可用

**禁止**：
- 骨架完成就报"已实现"——CRUD 能用不等于业务跑通
- 绕过真实访问路径测试——container-exec 是诊断工具，不是验收工具
- 不主动查系统能力——需要模型池就去查平台有没有，需要用户就去查数据库有哪些

### 9. 新功能/新 Agent 导航默认去百宝箱 + 必须声明位置

新 Agent 默认注册到百宝箱（`prd-admin/src/stores/toolboxStore.ts` 的 `BUILTIN_TOOLS`），左侧导航和首页快捷为可选升级。**新条目必须带 `wip: true`**，通过规则 #8 完成标准验收后才删除该字段转为正式发布。交付消息必须包含三行：

```
【位置】百宝箱 / 左侧导航"XX"菜单 / 首页快捷入口
【路径】登录后首页 → 1) 点击 → 2) 点击 → 3) 到达
【预览】https://{tail}-{prefix}-{project-slug}.miduo.org/{page-path}
```

URL 格式见规则 #11（v3 公式：`{tail}-{prefix}-{project-slug}`，重要的靠前）。禁止只给路由、位置模糊、未注册百宝箱就声称完成。详见 `.claude/rules/navigation-registry.md`。

### 10. doc/ 文件命名必须走 6 类前缀

`doc/` 下所有 `.md` 文件**必须**以 `spec.` / `design.` / `plan.` / `rule.` / `guide.` / `report.` 其中一个前缀开头，否则不允许落盘。详细前缀语义、文件头部格式、状态枚举见 `doc/rule.doc-naming.md`。

- ✅ `doc/design.report-agent.md`、`doc/guide.quickstart.md`、`doc/report.2026-W13.md`
- ❌ `doc/output-xxx.md`、`doc/notes-temp.md`、`doc/report-agent.md`（无类型前缀）
- ❌ `doc/samples/xxx.md`（禁止建子目录，保持 doc/ 扁平）

新增或重命名文档前：
1. 先读 `doc/rule.doc-naming.md` 确认前缀、头部、状态枚举
2. 同步更新 `doc/index.yml`（外部同步工具消费）与 `doc/guide.list.directory.md`（人类索引）
3. 触发 `/doc-sync` 技能校验一致性（可选）

### 11. 代码 push 后必须显示预览地址

**任何代码改动（`prd-api/`、`prd-admin/`、`prd-desktop/`、`prd-video/`）执行 `git push` 后**，最终给用户的回复**必须**包含预览地址，让用户知道去哪验收。

#### 正确的 URL 公式（v3：tail-prefix-project，重要的靠前）

```
https://${tail}-${prefix}-${projectSlug}.miduo.org/
```

`${tail}` 是分支名第一个 `/` 之后的部分（"在干啥"，最重要），`${prefix}` 是 `/` 之前的 agent / 类型前缀（claude / cursor / feat / fix），`${projectSlug}` 是仓库根目录名（项目身份，最不需要常看）。三者全部走 slugify：转小写 + 非 `[a-z0-9-]` 替换为 `-` + 合并连续 `-` + 去头尾 `-`。

| 输入 | 拆解 | 输出 URL |
|------|------|---------|
| 分支 `claude/fix-refresh-error-handling-2Xayx` + 项目 `prd-agent` | tail=`fix-refresh-error-handling-2xayx`, prefix=`claude`, project=`prd-agent` | `https://fix-refresh-error-handling-2xayx-claude-prd-agent.miduo.org/` |
| 分支 `feat/login` + 项目 `demo` | tail=`login`, prefix=`feat`, project=`demo` | `https://login-feat-demo.miduo.org/` |
| 分支 `main` + 项目 `prd-agent` | tail=`main`, **无 prefix**, project=`prd-agent` | `https://main-prd-agent.miduo.org/` （中段省略） |
| 分支 `feat/auth/login`（多级路径） + 项目 `demo` | tail=`auth-login`, prefix=`feat`, project=`demo` | `https://auth-login-feat-demo.miduo.org/` |

⚠ **历史 URL 公式演化**（CDS proxy 仍兼容旧链接，但**新生成**一律用 v3）：
- v1（2026-04 之前）：`${branchSlug}.miduo.org`（无项目前缀）— legacy 项目
- v2（2026-04-26 ceb2c01）：`${projectSlug}-${branchSlug}.miduo.org`（项目前缀）
- v3（2026-04-27 起）：`${tail}-${prefix}-${projectSlug}.miduo.org`（重要的靠前）

实现唯一来源：`cds/src/services/preview-slug.ts` 的 `computePreviewSlug(branch, projectSlug)`。CDS 后端、PR 评论模板、check-run 摘要、Settings 预览全部过这一函——改公式只动一处。

#### 强制行为

每次 push 后必须调用 `/preview-url` 技能（或内联跑下方脚本拼接），在交付消息里独立成行输出：

```
【预览】https://{tail}-{prefix}-{project-slug}.miduo.org/{可选-具体页面路径}
```

#### 推荐写法

```bash
slugify() {
  echo "$1" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9-]/-/g; s/--*/-/g; s/^-//; s/-$//'
}
PROJECT_SLUG=$(slugify "$(basename "$(git rev-parse --show-toplevel)")")
BRANCH=$(git branch --show-current)
case "$BRANCH" in
  */*)
    PREFIX=$(slugify "${BRANCH%%/*}")
    TAIL=$(slugify "${BRANCH#*/}")
    SLUG="${TAIL}-${PREFIX}-${PROJECT_SLUG}"
    ;;
  *)
    SLUG="$(slugify "$BRANCH")-${PROJECT_SLUG}"
    ;;
esac
echo "https://${SLUG}.miduo.org/"
```

#### 适用场景

- ✅ 任何 `.cs` / `.ts` / `.tsx` / `.rs` / `.css` 改动 push 后
- ✅ Dockerfile / docker-compose 改动 push 后
- ✅ 涉及 UI 入口变更的（同步规则 #9 的【位置】+【路径】）
- ❌ 仅文档（`doc/`）/ 仅 `.claude/` 元数据 / 仅 `changelogs/` 的 push 可省略

#### 反面案例

> 2026-04-26 用户反馈「不知道怎么看」——AI 完成 push 但只说「commit 已推送，CDS 几分钟内自动部署」，没给具体 URL。修复：本规则强制输出预览地址。
>
> 同日二次反馈：AI 加了规则但 URL 公式错了（只用 `${branchSlug}`，缺 `${projectSlug}` 前缀），CDS 多项目改造后该公式不再有效。
>
> 2026-04-27 三次反馈：v2 公式（项目名前缀）虽然能用，但项目名永远排第一遮住关键信息——重要的靠前。修复：v3 公式（tail-prefix-project），项目名后缀化。

#### 与规则 #9 的关系

规则 #9 是新 Agent 交付时的【位置/路径/预览】三行结构；本规则覆盖**所有** push（不限于新 Agent），**任何代码改动 push 后都必须有【预览】行**。

跑评测/脚手架产出的"样本/证据"文件也必须套用合适的前缀（如 `report.skill-eval-sample-*.md`），不允许留 `output-*.md` / `tmp-*.md` 之类的裸文件名。

---

## 架构规则索引

以下规则按需加载（仅当编辑匹配 glob 的文件时），详见 `.claude/rules/`：

| 规则文件 | 触发范围 | 核心要点 |
|----------|----------|----------|
| `app-identity.md` | `prd-api/src/**/*.cs` | Controller 硬编码 appKey，6 个应用标识 |
| `data-audit.md` | `Models/**/*.cs`, `Controllers/**/*.cs` | 新增实体引用时审计所有消费端点 |
| `llm-gateway.md` | `prd-api/src/**/*.cs` | 所有 LLM 调用必须通过 ILlmGateway |
| `frontend-architecture.md` | `**/*.{ts,tsx}` | 前端无业务状态 + SSOT + 组件复用 + 默认可编辑 |
| `frontend-modal.md` | `prd-admin/src/**/*.tsx`, `prd-desktop/src/**/*.tsx` | 模态框 3 硬约束：inline style 高度 + createPortal + min-h:0 |
| `full-height-layout.md` | `prd-admin/src/pages/**/*.tsx`, `prd-desktop/src/pages/**/*.tsx` | 宽屏页面必须撑满视口：根 `h-full min-h-0 flex flex-col`，禁止 `calc(100vh - Npx)` 魔数，滚动发生在最近内容层 |
| `server-authority.md` | `prd-api/src/**/*.cs` | CancellationToken.None + Run/Worker + SSE 心跳 |
| `doc-types.md` | `doc/**/*.md` | 6 种文档前缀（spec/design/plan/rule/guide/report） |
| `marketplace.md` | 市场相关文件 | CONFIG_TYPE_REGISTRY + IForkable 白名单复制 |
| `snapshot-fallback.md` | `Controllers/**/*.cs`, `Services/**/*.cs` | 快照反规范化必须有等价覆盖的兜底查询路径 |
| `enum-ripple-audit.md` | `Enums/**/*.cs`, `types/**/*.ts` | 枚举/常量扩展时全栈 6 层涟漪审计 |
| `codebase-snapshot.md` | 无 glob (手动维护) | 项目快照：架构模式、功能注册表、115 个 MongoDB 集合 |
| `zero-friction-input.md` | `**/*.{ts,tsx}` | 能上传不手输，不确定就两个都给，禁止空白发呆 |
| `guided-exploration.md` | `**/*.{ts,tsx}` | 陌生页面 3 秒内知道做什么，空状态必须有引导 |
| `no-rootless-tree.md` | `**/*.{cs,ts,tsx}` | 无根之木禁令 + 借用法则：不假定不存在的能力，缺什么借什么 |
| `bridge-ops.md` | `cds/src/**/*.ts` | Bridge 操作规范：鼠标轨迹 + spa-navigate + description 必填 |
| `navigation-registry.md` | 新 Agent / 新功能入口 | SSOT 模型：路由信息写到 launcherCatalog/agentSwitcherStore/toolboxStore，「设置→导航顺序」+ Cmd+K 自动同步；CI 跑 `navCoverage` 测试，未登记或 phantom 路由直接 fail |
| `quickstart-zero-friction.md` | 入口脚本 (`*init*`, `*quick*`, `*setup*`, `Dockerfile`) | 快启动大包大揽：假设用户是小白，自动检测+安装依赖，不能自动的给复制粘贴命令 |
| `cds-first-verification.md` | 任何可执行代码改动 (`.cs`, `.ts`, `.tsx`, `.rs`, Dockerfile) | 本地无 SDK ≠ 无法验证：必须用 `/cds-deploy` 兜底，禁止把验证负担转嫁给用户 |
| `cds-auto-deploy.md` | 已 link GitHub 的项目交付收尾 | push 即部署 — 不再提示用户手动跑 `/cds-deploy-pipeline`；CDS 通过 webhook 自动建分支 + 构建 + 部署；UI 开着时必须有"分支出现 + 构建中"动画 |
| `gesture-unification.md` | 任何可平移/缩放的 2D 画布（ReactFlow / 自定义 DOM canvas / Konva 等） | 手势统一：两指拖动=平移、双指捏合或 ⌘/Ctrl+滚轮=缩放、禁止双击缩放；提供 ReactFlow + 自定义 canvas 两套标准配置 |
| `compute-then-send.md` | `prd-api/src/**/*.cs` 里 LLM / 外部 API 调用类（ILlmGateway / OpenAIImageClient 等） | 外部调用必须分"算/发"两阶段：发送阶段接收已解析结果不得再 resolve；禁止用 DI 装饰器 / AsyncLocal / 实例字段 在兄弟调用间传递 state |

---

## 质量保障技能链

```
需求 → /validate → 方案 → /plan-first → /risk → /trace → 实现 → /verify → /scope-check → /cds-deploy → /smoke → /preview → /uat → /handoff → /weekly
```

### 主流程技能（按开发生命周期排列）

| 技能 | 触发词 | 输入 → 输出 |
|------|--------|-------------|
| **skill-validation** | `/validate` | 输入需求描述 → 检测模糊/不完整/不可测试等 8 种气味，排查与已有功能重复，输出七维度评分报告 |
| **plan-first** | `/plan-first` | 输入任务描述 → 输出实施方案和影响分析，等用户确认后才执行代码变更 |
| **risk-matrix** | `/risk` | 输入功能变更范围 → 按 MECE 原则评估六维度风险（正确性/兼容/性能/安全/运维/体验），输出风险矩阵表 |
| **flow-trace** | `/trace` | 输入功能名 → 追踪从前端到数据库的完整数据流和控制流，输出端到端路径图（大白话版 + 技术版） |
| **human-verify** | `/verify` | 输入代码变更 → 从魔鬼辩护、反向验证、边界测试、用户场景四个角度模拟人工审查，输出问题清单 |
| **scope-check** | `/scope-check` | 输入当前分支 → 逐文件分类为 owned/shared/foreign，检测越界修改和 append-only 违规，输出边界审计报告 |
| **cds-deploy-pipeline** | `/cds-deploy` | 输入代码提交 → 自动推送到 CDS 灰度环境、等待容器就绪、执行冒烟测试，失败自动定位原因 |
| **smoke-test** | `/smoke` | 输入模块名 → 扫描 Controller 端点，自动生成链式 curl 脚本（前一步输出 ID 传给后续请求） |
| **preview-url** | `/preview` | 输入当前分支 → 自动拼接 `分支名.miduo.org` 预览地址，用于人工验收 |
| **acceptance-checklist** | `/uat` | 输入功能场景 → 生成真人逐步打勾的 UAT 清单（Phase 0-7：前置 → 冷启 → 执行 → 验证 → 回归 → 回滚 → 负面），每步含预期结果 + 失败排查手册。CLI/Web 双通道支持 |
| **task-handoff-checklist** | `/handoff` | 输入当前变更 → 扫描导航/文档/规则/工作流/测试/风险/质量/后续 8 个维度，输出交接清单 |
| **weekly-update-summary** | `/weekly` | 输入时间范围 → 从 git 历史收集 commit/PR/贡献者数据，输出分类周报（完成项 + 下周优先级） |

### 辅助技能（按需使用）

| 技能 | 触发词 | 输入 → 输出 |
|------|--------|-------------|
| **bridge** | `/bridge` | 输入操作指令 → 通过 CDS 预览页面远程操作浏览器（鼠标轨迹 + DOM 读取 + 点击/输入/SPA 导航） |
| **conflict-resolution** | `/resolve` | 输入当前分支 → 将 main 合并进来，AI 自动解决冲突，避免 PR 时冲突 |
| **doc-writer** | `/doc` | 输入文档类型 → 校验 `doc/` 下的命名和表头格式，自动套用 6 种标准模板（spec/design/plan/rule/guide/report） |
| **doc-sync** | `/doc-sync` | 无需输入 → 扫描 `doc/` 目录，自动对齐 `index.yml` 和 `guide.list.directory.md` |
| **code-hygiene** | `/hygiene` | 输入代码变更 → 检测死代码/兼容垫片/命名残留/冗余参数等 10 类技术债，输出清理建议 |
| **deep-trace** | `/deep-trace` | 输入代码变更 → 跨层（C#→JSON→Rust→React）验证字段名、类型、序列化、空值处理的正确性 |
| **llm-visibility** | `/visibility` | 输入代码变更 → 扫描所有 LLM 调用点，检查是否符合「禁止空白等待」原则，输出合规报告 |
| **llm-call-trace** | `/llm-trace` | 前端选 A 后端跑 B / LLM 日志 model 不对时 → 按"前端 body → DB run → resolve 调用次数审计 → LLM 日志 Model"的顺序定位，避免凭直觉打补丁（本仓库血泪技能） |
| **feature-emerge** | `/emerge` | 输入任意模块/痛点 → 扫描该模块能力 + 全局横向能力（Gateway / Bridge / Run-Worker / Attachment）→ 四层发散（基线/差异化/智力/疯狂）→ 收敛推荐波次。通用涌现，不限文档 |
| **cn-brief-summary** | `200字总结` | 无需输入 → 在回复末尾自动追加 ≤200 字中文通俗总结 |
| **dev-completion-report** | `/dev-report` | 开发完成后 → 输出三段式报告：200 字总结 + 总结清单（改动/风险/测试/验收）+ 行业对比分析 |
| **create-skill-file** | `/create-skill` | 输入技能需求 → 生成符合规范的 SKILL.md 文件并评分 |
| **cds-project-scan** | `/cds-scan` | 输入项目目录 → 自动检测技术栈和基础设施，生成 CDS docker-compose YAML |
| **theme-transition** | `/theme-transition` | 输入项目 → 添加 View Transition API 圆形水波纹主题切换动效（含降级方案） |
| **agent-guide** | `/help` | 无需输入 → 读取 `.agent-workspace/` 进度文件，告知当前阶段和下一步操作 |
| **create-executor** | `/create-executor` | 输入执行器名称和用途 → 自动读取代码、生成执行器、注册、自测，全自动接入 CLI Agent 执行器 |

### 专项修复技能

| 技能 | 触发词 | 输入 → 输出 |
|------|--------|-------------|
| **fix-unused-imports** | — | 输入 TS6133 错误 → 自动删除未使用的 TypeScript import/变量 |
| **fix-surface-styles** | `/fix-surface` | 输入页面路径 → 扫描并修复 CSS 样式偏差，统一到 Surface System |
| **add-agent-permission** | `加权限` | 输入权限名 → 自动判断分类并同步修改后端枚举 + 前端类型 + 角色分配 |
| **add-image-gen-model** | `添加生图模型` | 输入模型信息 → 在后端 Config + 前端 Adapter 中注册新的图片生成模型 |
| **update-model-size** | `更新模型尺寸` | 输入模型名 → 对比官方 API 文档，更新模型尺寸配置 |
| **release-version** | `/release` | 输入版本类型 → 自动检测当前版本，分析变更，执行 patch/minor/major 发版 |
| **ai-defect-resolve** | `修复缺陷` | 输入缺陷链接 → 按标准工作流（列清单→评论→修复→验收）自动化修复 |
| **remotion-scene-codegen** | `优化场景` | 输入场景需求 → 提供 Remotion API 上下文，生成高质量视频场景代码 |

### 文档写作与设计技能

| 技能 | 触发词 | 输入 → 输出 |
|------|--------|-------------|
| **technical-documentation** | — | 输入文档需求 → Diátaxis 工作流 + 8 种模板（Spec/Architecture/Runbook/API/Quick Start/How-to/FAQ/Tutorial） |
| **ui-ux-pro-max** | — | 输入设计需求 → 67 种风格 + 96 种配色 + 57 种字体搭配，支持 13 种技术栈 |

### 元技能

| 技能 | 触发词 | 输入 → 输出 |
|------|--------|-------------|
| **find-skills** | `找技能` | 输入能力需求 → 从技能生态搜索并推荐可安装的第三方技能 |
| **api-debug** | — | 输入 API 端点 → 查询真实 API 数据辅助调试 |
| **dev-setup** | `装环境` | 无需输入 → 自动检测并安装 .NET/Node/Rust/pnpm SDK，执行 API 测试 |

### 使用指引

0. **首次开发 Agent** → `/help` 进入新手引导，全程阶段式陪伴（详见 `doc/guide.agent-onboarding.md`）
1. **新需求提出时** → `/validate` 验证需求质量和价值（中大型功能必跑）
2. **方案设计时** → `/plan-first` 先出方案再动手，用户确认后执行
3. **方案评审时** → 先 `/risk` 评估风险，再 `/trace` 追踪关键链路
4. **开发完成后** → 先 `/verify` 交叉验证，再 `/scope-check` 边界检查
5. **部署测试时** → `/cds-deploy` 一键部署灰度环境，再 `/smoke` 冒烟测试
6. **需人工验收时** → `/preview` 生成预览地址 → `/uat` 生成逐步打勾的验收清单，真人按表执行每一步
7. **提 PR 前** → `/resolve` 预合并主分支，AI 代替人类解决冲突
8. **准备上线时** → `/handoff` 生成交接清单（涉及 3+ 文件时自动触发）
9. **周五收尾时** → `/weekly` 生成本周总结（完成后自动触发 `/doc-sync`）
10. **写文档时** → `/doc` 查看类型速查，或直接创建文档时自动套用模板
11. **迁移/重构后** → `/hygiene`
