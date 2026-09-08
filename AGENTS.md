# AGENTS.md

> PRD Agent 全栈项目（`prd-api` .NET 8 / `prd-admin` React+Vite / `prd-desktop` Tauri / `prd-video` Remotion / `llmgw` LLM 网关 / `cds` 分支预览部署）。
> 本文件是全体 AI Agent 的共用规则 SSOT，工具中立。各模块构建命令见子目录同名文件；架构规则见 `.claude/rules/`。

<!--
为什么这份是 SSOT：本仓库曾经并行维护根 CLAUDE.md 与根 AGENTS.md 两份 95% 相同的副本，
没有同步脚本，结果必然漂移——AGENTS.md 知道 llmgw 模块，CLAUDE.md 一个字都没提，
导致 llmgw 的必跑校验命令对 Claude Code 完全不可见。
现在 CLAUDE.md 只做 `@AGENTS.md` 导入 + 一小节宿主专属差异，正文只此一份。
守卫：scripts/tests/test_claude_memory_contract.py
-->

## 0. 禁止任何 Emoji（最高优先级，先于一切其他规则）

本系统任何项目（含 `doc/`、`changelogs/`、提交信息、PR 描述、UI 文案、**给用户的回复正文**）一律不允许出现 emoji 字符。

替代方案：状态/类型用 SVG icon（前端已有 ICON 注册表 / lucide-react / cds 的 `ICON.*`）；重要程度用文案分级（建议 / 警告 / 必填 / 已禁用）；视觉强调走 CSS（颜色、加粗、底色）。例外仅限本节：为说明「哪些字符算 emoji」，可在 inline code 里写反面例子如 `'rocket'`。

<!--
历史背景：用户 2026-04-27 第二次明确强调「本系统任何项目不允许使用任何的 emoji 图标」。
第一次违反是分支卡 stats chips 用了 4 个 emoji（火箭/机器人/灯泡/向下箭头），已立刻修复。
本规则置顶意在阻止再犯。
-->

## 快速启动

```bash
docker compose -f docker-compose.dev.yml up -d --build
# Web 5500 / API 5000 / Mongo 18081 / Redis 18082
.\quick.ps1 all          # Windows: server + desktop + admin
cd prd-video && pnpm start   # Remotion 4.0
```

---

## 强制规则

### 1. 前端包管理器：pnpm Only

`prd-admin` / `prd-desktop` / `prd-video` / `llmgw/web` 统一 pnpm，禁止 npm / yarn。仅保留 `pnpm-lock.yaml`，禁止提交 `package-lock.json` / `yarn.lock`。

### 2. C# 静态分析

任何 `.cs` 改动后必须跑，`error CS*` 必须修复，`warning CS*` 评估是否本次引入：

```bash
cd prd-api && dotnet build --no-restore 2>&1 | grep -E "error CS|warning CS" | head -30
```

### 3. 任务完成交接

涉及 3+ 文件 / API 端点 / UI 页面变更时，**必须主动**用 `task-handoff-checklist` 技能生成交接清单。1-2 个文件的小修改无需生成。

### 4. 更新记录：只写碎片，禁止编辑 CHANGELOG.md

对 `prd-api` / `prd-admin` / `prd-desktop` / `prd-video` / `llmgw` 的任何代码变更（feat/fix/refactor/perf），提交前必须建 `changelogs/YYYY-MM-DD_<短描述>.md`，内容为纯表格行（无表头），同一 PR 全部变更放**一个**文件：

```
| feat | prd-admin | 新增XX功能 |
| fix | prd-api | 修复XX问题 |
```

类型枚举：`feat` `fix` `perf` `refactor` `docs` `chore` `test` `ci` `security` `ops` `style` `polish` `rule` `merge` `revert`。纯 `doc/` 或纯规则调整可选记录。发版时跑 `bash scripts/assemble-changelog.sh` 合并。

<!--
为什么这样做：多分支并行开发时直接编辑 CHANGELOG.md 会在同一位置插入内容导致必然冲突。
碎片文件各自独立，彻底消除合并冲突。
-->

### 5. 提交与 PR 工作流

**5.1 Commit message 必须中文**（标题 + 正文）。允许保留英文技术术语（API/SSE/createPortal）和 Conventional Commits 前缀。类型枚举同规则 #4，另加 `build` `release`。

```
正确：fix(prd-admin): 修复周报弹窗样式错乱
错误：fix: resolve modal styling issue
```

**5.2 校验全绿才准 push**，任意一项失败都不得推送：

| 改动范围 | 必跑校验 |
|----------|----------|
| `prd-api/` `.cs` | `dotnet build --no-restore`（零 `error CS*`） |
| `prd-admin/` `prd-desktop/` 前端源码 | `.ts` `.tsx`：`pnpm tsc --noEmit` + `pnpm lint`（改动文件零新增告警）。改到 `.css` **另跑 `pnpm build`**——tsc/lint/vitest 一个都不解析 CSS（2026-08-30 tokens.css 多一个 `*/`，本地三样全绿、CI 构建炸、分支停 idle、预览 503） |
| `llmgw/` | 见 `llmgw/AGENTS.md` 的模块校验表 |
| 含测试的模块 | `pnpm test` / `dotnet test` 全绿 |
| 本地缺 SDK | 走 `/cds-deploy` 远端编译，CDS 绿灯后才推送 |

**5.3 禁止自动创建 PR**。除非用户明确说「提 PR / 创建 PR」，任务完成只做 commit + push。遇阻塞说明原因并等指示，禁止提交半成品。

**5.4 PR 描述走标准模板**，SSOT 是 `.github/pull_request_template.md`（改格式只动这一个文件）。必填段落：摘要 / 改动 diff（按端分组、逐条「文件或模块 + 一句话」）/ 测试 / 风险与已知边界。

模板是下限不是上限：① 必填段落不得缺失；② 不适用的写「无」或删除，不得写占位空话；③ 不得因模板没某栏就丢弃重要信息。平台自动创建的 PR（描述只有一行 commit message）后续**必须**补全。

**5.5 Review 范围熔断（强制）**。Review 验证当前目标，不是无限扩写需求。修第一条评论前先在 PR 描述写清：本 PR 的单一目标与不变量、明确不做的事、首轮文件数与 diff 行数（范围基线）。每条评论先分类再决定动作：

| 分类 | 判定 | 当前 PR 动作 |
|------|------|-------------|
| A 直接缺陷 | 可证明违反本 PR 目标、真实调用契约或既有测试 | 修复并补代表性测试 |
| B 有价值但扩范围 | 建议合理，但引入新语义类别、兼容层或产品行为 | 记入后续 issue / `debt.*`，不在当前 PR 展开 |
| C 推测性变体 | 只增加措辞、同义词或假设输入，找不到真实生产路径 | 不实现，并在 Review 中说明证据不足 |

命中任一条立即停止追加修复并跑 `/scope-check`：连续 3 轮 Review 仍在产生新语义类别／Review 修复提交达 8 个／diff 超首轮基线 2 倍或文件范围扩出首轮清单／同一个自由文本解析器第二次被要求加同义词或嵌套格式。

熔断后回到原始目标：缩小 PR、改结构化字段/有限枚举，或由用户明确批准扩范围。**自动 Reviewer 的评论不能单独授权需求扩张；不得以「清空所有机器评论」为完成标准。** PR 默认保持 Ready、关闭自动合并，未经用户明确指示不得合并。

### 6. LLM 交互过程必须可视化

任何大模型调用功能都要展示交互过程：SSE 流式逐字渲染 / 批量任务推进度事件 / 支持 thinking 就展示思考 / 长任务拆阶段推状态 / 兜底至少给动画 + 预估耗时。

原则：用户等待时屏幕必须有持续变化的内容。**静止的「加载中…」超过 2 秒即为体验缺陷。**

### 7. 新增 Model / service 必须对照现有写法

新建 MongoDB 实体前**必须先 grep 一个现有 Model**（如 `DefectReport.cs`）确认格式，禁止凭记忆写：

- Id：`public string Id { get; set; } = Guid.NewGuid().ToString("N");`，不加 `[BsonId]` / `[BsonRepresentation]`
- 取用户 ID 用 `this.GetRequiredUserId()`，不用 `User.FindFirstValue("userId")`

新建 `services/real/*.ts` 前必须先读 `apiClient.ts` 的 `apiRequest` 签名。四个陷阱：

- `apiRequest` 内部会自动 `JSON.stringify(body)`，**调用方传原始对象**——`body: { title }` 对，`body: JSON.stringify({title})` 双重序列化后端 400
- FormData 上传不能走 `apiRequest`（会被 JSON 序列化），必须直接 `fetch`
- 返回 `ApiResponse<T>` = `{success, data, error}`，判断用 `res.success` 不是 `res.ok`
- 错误是对象 `res.error?.message`，不是字符串 `res.error`

### 8. 「完成」标准

声称完成前必须全部满足：后端编译零错误（本地 + CDS 双验证）／前端页面能通过预览地址打开并正常渲染／核心业务流程端到端跑通（不是只有 CRUD）／直连预览域名测试（container-exec 是诊断工具不是验收工具）／依赖的外部服务已确认可用。

禁止：骨架完成就报「已实现」；绕过真实访问路径测试；不主动查系统能力。

**8.1 自测优先——不得把校验责任先交还给用户。** 提交前必须至少跑通一条自测路径，并在交付消息里**写明走了哪条、断言了什么**：

1. Vitest / xUnit 集成测试，断言新行为发生（首选，最廉价）
2. `/cds-deploy` 推灰度环境等容器就绪 + 冒烟
3. Playwright 无头浏览器直连预览域名走真实用户路径
4. `WebFetch` + 已有 API key 打真实端点断言返回值

禁止用「我无法做到 X」当借口——必须先列出试过哪几条路径才被卡住。自测跑不通就**明说「自测未跑通，问题可能仍存在」**，不许声称「已修复」。不适用：纯文档 / 纯注释 / 纯 changelog，或用户说了「先提，等会儿我再测」。

<!--
历史背景：2026-05-07 用户反复反馈「修了七八轮还是同一个 bug」，根因之一是 AI 提交后只跑
tsc --noEmit + 单元测试，把「端到端是否真的解决」丢给用户去点击验证。用户不是 QA。
-->

### 9. 新功能/新 Agent 默认注册百宝箱 + 必须声明位置

新 Agent 默认注册到 `prd-admin/src/stores/toolboxStore.ts` 的 `BUILTIN_TOOLS`，**必须带 `wip: true`**，通过规则 #8 验收后才删掉转正式。左侧导航和首页快捷是可选升级。交付消息必须含三行：

```
【位置】百宝箱 / 左侧导航"XX"菜单 / 首页快捷入口
【路径】登录后首页 → 1) 点击 → 2) 点击 → 3) 到达
【预览】<cdscli 返回的实际入口>{功能页深链}
```

禁止只给路由、位置模糊、未注册百宝箱就声称完成。详见 `navigation-registry` 规则（有 CI 守卫 `navCoverage`）。

### 10. doc/ 命名：`{类型前缀}.{appname}[.{子模块}].md`

两条铁律缺一不可（完整语义见 `doc/rule.doc.naming.md`）：

1. **类型前缀**七选一：`spec.` `design.` `plan.` `rule.` `guide.` `report.` `debt.`
2. **appname 优先 + 点分层级**：topic 第一段是应用名，子模块用 `.` 续接，禁止用 `-` 把 appname 和子模块黏死

跨切面用保留域名段 `platform.` / `frontend.` / `skill.` / `doc.`。目录保持扁平，禁子目录。

正确 `spec.cds.settings.md`、`design.cds.agent.runtime.md`；错误 `spec.cds-settings.md`（黏连）、`design.defect-automation-autonomy.md`（appname 不在首段）、`output-xxx.md`（无前缀）。

`debt.*` 记工程债务台账——交付时声明的「已知边界」必须固化进对应 `debt.{module}.md`，不能只留在 commit message 里。

**每篇文档必须带导读三行**（`**一句话**` / `**谁该读**` / `**读完能做什么**`，写在 H1 与版本行之后）。正文只写人类要掌控的层次（为什么做 / 给谁用 / 数据怎么流动 / 关键表设计 / 取舍与风险 / 验收标准）；**实现代码、接口签名、目录树、逐文件改法一律不进文档**——AI 要细节直接读源码。闸门：`python3 scripts/doc-readability-check.py --ratchet`（CI `docs-readability`，新文档不带导读三行会红）。

新增/重命名文档后同步 `doc/index.yml` 与 `doc/guide.list.directory.md`。评测产出的样本/证据/报告**不进 `doc/`**，归验收知识库。

### 11. push 后必须用 cdscli 给出真实预览地址

只要项目接了 CDS，任何代码改动 push 后或需人工验收时，最终回复必须先跑这条命令再列地址。本仓库 `cdscli.py` 只有一份，在 `.claude/skills/cds/cli/`；若你的宿主用别的技能根，就在那个根下定位同一个脚本，不要硬编码不存在的路径：

```bash
python3 .claude/skills/cds/cli/cdscli.py --human preview-url
```

**唯一 SSOT**：只能用 CDS `GET /api/branches` 返回的 `previewUrl` / `previewUrls`，多入口全部列出。**禁止**本地 slugify、拼 `${x}.miduo.org`、`tr '/' '-'` 推 branch id、在 commit/PR/模板里手写 URL（`cds/tests/services/preview-url-skill-drift.test.ts` 有守卫扫描）。缺凭据或分支未部署就如实报错，不许猜地址。

**必须给最终深链，不给根地址**：cdscli 输出是根域名 SSOT（域名部分不许自己造），功能页路由 + query/tab/锚点由你按本次改动的真实路由追加，让用户点一下就落到验收那一屏。多个功能页改动就给多条。反例 `【预览】https://xxx.miduo.org/`；正例 `【预览】https://xxx.miduo.org/open-platform?tab=open-api`。

不适用：仅 `doc/` / 仅 Agent 元数据目录 / 仅 `changelogs/` 的 push。

<!--
历史背景：2026-04-26 用户反馈「不知道怎么看」——AI push 后只说「CDS 几分钟内自动部署」没给 URL。
同日二次反馈 URL 公式错（缺 projectSlug 前缀）；2026-04-27 三次反馈项目名排第一遮住关键信息。
2026-06-04 用户强制要求最终深链：「每次预览给根地址，导致我每次都要走一圈」。
结论：URL 一律走 cdscli，不再维护任何本地公式。
-->

---

## 规则与技能

- **架构规则** `.claude/rules/`：54 条，全体 Agent 共用。支持路径作用域的宿主（如 Claude Code 的 `paths` frontmatter）按命中文件自动加载。**不支持的宿主自己选**：`ls .claude/rules/`，每个文件开头两行导读就是选取依据——`**一句话**` 说它要求什么、`**什么时候撞上**` 说什么改动会触发它，读这两行判断要不要往下读全文。这两行由 CI 强制（缺了 `docs-readability` 会红），所以扫描永远有效；此处不再维护第二份索引表——上一份漂移到 33/52 才被发现。
- **Codex 专属补充** `.Codex/rules/`：不与共用规则重复，Codex 侧没有按需加载机制，所以在此点名——
  - `local-debugging.md`：本地连调、视觉修复、接口排查、CDS 部署验证的工作方式。
  - `production-release-safety.md`：碰发布链路（`exec_dep.sh` / `fast.sh` / `deploy/nginx/**` / `docker-compose*.yml` / 发布类 workflow）前必读，它再指向 SSOT `doc/rule.platform.production-release-safety.md`。公网 HTML 与入口资源可用才算发布完成，容器或接口健康都不算数。
- **技能**：57 个在 `.claude/skills/`，另有 3 个在 `.agents/skills/`。多数宿主会自动注入名称与描述，**但只注入它自己那个技能根**——只认 `.agents/skills` 的宿主看不到另外 57 个。**注入不全时自己选**：`ls .claude/skills/`，每个目录的 `SKILL.md` frontmatter 里 `name` 与 `description` 就是选取依据（description 写明了触发场景）。frontmatter 字段的完整性由 CI 棘轮盯着（只降不升），但「目录里整个没有 SKILL.md」CI 现在拦不住——扫到这种目录按缺陷报出来，别当它不存在；此处同样不维护会漂移的第二份清单。
<!--
历史显式索引仅供旧宿主查阅，不作为规则或技能 SSOT，也不注入 Agent 上下文。

| 规则文件 | 触发范围 | 核心要点 |
|----------|----------|----------|
| `app-identity.md` | `prd-api/src/**/*.cs` | Controller 硬编码 appKey，6 个应用标识 |
| `data-audit.md` | `Models/**/*.cs`, `Controllers/**/*.cs` | 新增实体引用时审计所有消费端点 |
| `llm-gateway.md` | `prd-api/src/**/*.cs` | 所有 LLM 调用必须通过 ILlmGateway |
| `frontend-architecture.md` | `**/*.{ts,tsx}` | 前端无业务状态 + SSOT + 组件复用 + 默认可编辑 |
| `frontend-modal.md` | `prd-admin/src/**/*.tsx`, `prd-desktop/src/**/*.tsx` | 模态框 3 硬约束：inline style 高度 + createPortal + min-h:0 |
| `full-height-layout.md` | `prd-admin/src/pages/**/*.tsx`, `prd-desktop/src/pages/**/*.tsx` | 宽屏页面必须撑满视口：根 `h-full min-h-0 flex flex-col`，禁止 `calc(100vh - Npx)` 魔数，滚动发生在最近内容层 |
| `server-authority.md` | `prd-api/src/**/*.cs` | CancellationToken.None + Run/Worker + SSE 心跳 |
| `doc-types.md` | `doc/**/*.md` | 7 种文档前缀（spec/design/plan/rule/guide/report/debt） |
| `marketplace.md` | 市场相关文件 | CONFIG_TYPE_REGISTRY + IForkable 白名单复制 |
| `snapshot-fallback.md` | `Controllers/**/*.cs`, `Services/**/*.cs` | 快照反规范化必须有等价覆盖的兜底查询路径 |
| `enum-ripple-audit.md` | `Enums/**/*.cs`, `types/**/*.ts` | 枚举/常量扩展时全栈 6 层涟漪审计 |
| `codebase-snapshot.md` | 无 glob (手动维护) | 项目快照：架构模式、功能注册表、118 个 MongoDB 集合 |
| `zero-friction-input.md` | `**/*.{ts,tsx}` | 能上传不手输，不确定就两个都给，禁止空白发呆 |
| `guided-exploration.md` | `**/*.{ts,tsx}` | 陌生页面 3 秒内知道做什么，空状态必须有引导 |
| `chief-designer-usability.md` | `prd-admin/src/**/*.tsx`, `prd-desktop/src/**/*.tsx` | 好用四原则（首席设计师视角）：快启动无等待 / 奥卡姆剃刀剃掉不需人类处 / 不遮挡可视化够明显 / 短途减步不杜撰长链；交付前四条自审，两条不及格即返工 |
| `no-rootless-tree.md` | `**/*.{cs,ts,tsx}` | 无根之木禁令 + 借用法则：不假定不存在的能力，缺什么借什么 |
| `bridge-ops.md` | `cds/src/**/*.ts` | Bridge 操作规范：鼠标轨迹 + spa-navigate + description 必填 |
| `navigation-registry.md` | 新 Agent / 新功能入口 | SSOT 模型：路由信息写到 launcherCatalog/agentSwitcherStore/toolboxStore，「设置→导航顺序」+ Cmd+K 自动同步；CI 跑 `navCoverage` 测试，未登记或 phantom 路由直接 fail |
| `quickstart-zero-friction.md` | 入口脚本 (`*init*`, `*quick*`, `*setup*`, `Dockerfile`) | 快启动大包大揽：假设用户是小白，自动检测+安装依赖，不能自动的给复制粘贴命令 |
| `cds-first-verification.md` | 任何可执行代码改动 (`.cs`, `.ts`, `.tsx`, `.rs`, Dockerfile) | 本地无 SDK ≠ 无法验证：必须用 `/cds-deploy` 兜底，禁止把验证负担转嫁给用户 |
| `cds-auto-deploy.md` | 已 link GitHub 的项目交付收尾 | push 即部署 — 不再提示用户手动跑 `/cds-deploy-pipeline`；CDS 通过 webhook 自动建分支 + 构建 + 部署；UI 开着时必须有"分支出现 + 构建中"动画 |
| `gesture-unification.md` | 任何可平移/缩放的 2D 画布（ReactFlow / 自定义 DOM canvas / Konva 等） | 手势统一：两指拖动=平移、双指捏合或 ⌘/Ctrl+滚轮=缩放、禁止双击缩放；提供 ReactFlow + 自定义 canvas 两套标准配置 |
| `compute-then-send.md` | `prd-api/src/**/*.cs` 里 LLM / 外部 API 调用类（ILlmGateway / OpenAIImageClient 等） | 外部调用必须分"算/发"两阶段：发送阶段接收已解析结果不得再 resolve；禁止用 DI 装饰器 / AsyncLocal / 实例字段 在兄弟调用间传递 state |
| `user-readable-errors.md` | `**/*.{cs,ts,tsx}` | 用户错误必须说明结果与恢复动作；原始异常、HTTP、token、Provider、模型和协议细节只能进入脱敏日志或管理员诊断详情 |
| `blocked-state-circuit-breaker.md` | 长任务 / 多轮自动执行 Agent | 撞上自己无法提供的外部输入时必须熔断：≥8 提交或≥2h 无功能净进展即停止进度剧场、发一条合并升级、切纯代码或挂起；禁止 plan thrashing 和不眠 grinding |
| `production-release-safety.md` | `exec_dep.sh`、`fast.sh`、`deploy/nginx/**`、`docker-compose*.yml`、生产发布 workflow | 公网 HTML 与入口资源才是完成门；静态站原子切换；旧命令兼容；发布证据可追溯 |

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
| **stable-smoke** | `/稳测` | 每 48 小时对测试与正式环境执行关键用户旅程合成监控，按模块出报告；首次逃逸问题必须固化为永久回归用例 |
| **preview-url** | `/preview` | 输入当前分支 → 读取 CDS API 实际返回的 `previewUrl` / `previewUrls`，多入口全部列出，禁止本地推算 |
| **acceptance-checklist** | `/uat` | 输入功能场景 → 生成真人逐步打勾的 UAT 清单（Phase 0-7：前置 → 冷启 → 执行 → 验证 → 回归 → 回滚 → 负面），每步含预期结果 + 失败排查手册。CLI/Web 双通道支持 |
| **acceptance-scenario-orchestrator** | `/验收场景` | 输入每日/PR/commit/未发布分支/缺陷复测等复杂验收目标 → 先做场景识别、PR/commit 到结果映射、指差法开测清单、证据链契约，再交给 `/验收` 取证归档 |
| **task-handoff-checklist** | `/handoff` | 输入当前变更 → 扫描导航/文档/规则/工作流/测试/风险/质量/后续 8 个维度，输出交接清单 |
| **auto-fix-issues** | `/audit` | Agent 间 issue 反馈/修复/复测协议。三档标签 (`待解决` / `已解决待验收` / `已验收`)、issue + tracker + PR 收尾 + 复测报告四套模板，PR 合并必须改 label 的强制清单，杜绝"修了忘改 label" |
| **issues-autofix** | `/issues-autofix` | 无人值守日常 issue 维护 Agent。批跑 open issue，按分类规则自动答复/修复/升级，绝不反向询问。完全跳过 `visual-test:*` / `discussion` / 其他 Agent 领地（详见 `doc/rule.skill.issues-system.md` §3） |
| **issues-visual-create** | `/issues-visual-create` | 创建一条视觉验收子 issue。输入"测什么"(PR#/commit/页面)，按 #605 模板 v0.x 生成 `[visual-test]` issue，挂 `visual-test:pending` 等执行者接单 |
| **issues-visual-run** | `/issues-visual-run` | 24h 视觉测试执行者 Agent 逻辑。拉 `visual-test:pending` 队列，按矩阵跑用例(双主题强制)，回评论失败清单(P0-P3) 或 `/visual-pass`。完全不开新 issue |
| **create-visual-test-to-kb** | `/验收` | 工业级功能验收/视觉测试全流水线（MAP 验收标准 v2）。三段不可分：标准/模板 → 模拟人类浏览器取证（点击导航进入、禁地址栏直达、双主题截图）→ 报告归档进知识库出分享链。归档前强制准入校验（目标/档位/Verdict/截图数/证据完整性不达标直接拒收）。项目无关，改 `acceptance.config.json` 跨仓库复用 |
| **weekly-update-summary** | `/weekly` | 输入时间范围 → 四源聚合（git 提交与 PR + 日报知识库 + CDS 验收中心 + 缺陷台账/发布版本）→ 输出**面向老板/产品经理**的业务周报：质量闸（验收通过率 + 未通过清单）→ 业务价值看板（谁能多做什么）→ 逐日脉络挂日报深链 → 落地对照 → 下周优先级 → 术语表，技术细节降到附录 |
| **daily-report-summary** | `/daily` | 输入目标日期 → 从 git 历史按单日提交收集改动，按「新增多讲 → 优化/修复次之 → 计划/遗留垫底」分层写日报，find-or-create「日报知识库」发布并出分享链 |

### 辅助技能（按需使用）

| 技能 | 触发词 | 输入 → 输出 |
|------|--------|-------------|
| **conflict-resolution** | `/resolve` | 输入当前分支 → 将 main 合并进来，AI 自动解决冲突，避免 PR 时冲突 |
| **doc-writer** | `/doc` | 输入文档类型 → 校验 `doc/` 下的命名和表头格式，自动套用 7 种标准模板（spec/design/plan/rule/guide/report/debt） |
| **doc-sync** | `/doc-sync` | 无需输入 → 扫描 `doc/` 目录，自动对齐 `index.yml` 和 `guide.list.directory.md` |
| **code-hygiene** | `/hygiene` | 输入代码变更 → 检测死代码/兼容垫片/命名残留/冗余参数等 10 类技术债，输出清理建议 |
| **deep-trace** | `/deep-trace` | 输入代码变更 → 跨层（C#→JSON→Rust→React）验证字段名、类型、序列化、空值处理的正确性 |
| **llm-visibility** | `/visibility` | 输入代码变更 → 扫描所有 LLM 调用点，检查是否符合「禁止空白等待」原则，输出合规报告 |
| **llm-call-trace** | `/llm-trace` | 前端选 A 后端跑 B / LLM 日志 model 不对时 → 按"前端 body → DB run → resolve 调用次数审计 → LLM 日志 Model"的顺序定位，避免凭直觉打补丁（本仓库血泪技能） |
| **feature-emerge** | `/emerge` | 输入任意模块/痛点 → 扫描该模块能力 + 全局横向能力（Gateway / Bridge / Run-Worker / Attachment）→ 四层发散（基线/差异化/智力/疯狂）→ 收敛推荐波次。通用涌现，不限文档 |
| **dev-completion-report** | `/dev-report` | 开发完成后 → 输出三段式报告：200 字总结 + 总结清单（改动/风险/测试/验收）+ 行业对比分析 |
| **create-skill-file** | `/create-skill` | 输入技能需求 → 生成符合规范的 SKILL.md 文件并评分 |
| **production-hotfix-release** | `/hotfix-prod` | 输入生产环境 + 指定分支/提交 → 基于线上当前 revision 最小 cherry-pick，走 CI 产物 + 生产脚本热发布，严禁保存或输出敏感信息 |
| **cds-project-scan** | `/cds-scan` | 输入项目目录 → 自动检测技术栈和基础设施，生成 CDS docker-compose YAML |
| **cds** | `/cds` | 输入项目/分支 → CDS 全生命周期管理：扫描生成 compose YAML + Agent 鉴权 + 推送部署 + 等待就绪 + 分层冒烟 + 故障诊断自动排查，内置 cdscli Python 封装所有 CDS REST API |
| **cds-release** | `/cds-release` | 输入项目、生产域名与服务器 → 强制项目级 Key 和项目身份校验，自动检测现有脚本/无脚本 Compose/无脚本静态站，配置正式发布目标并完成预检、最终入口验收、回滚与错误目标归档 |
| **theme-transition** | `/theme-transition` | 输入项目 → 添加 View Transition API 圆形水波纹主题切换动效（含降级方案） |
| **agent-guide** | `/help` | 无需输入 → 读取 `.agent-workspace/` 进度文件，告知当前阶段和下一步操作 |
| **create-executor** | `/create-executor` | 输入执行器名称和用途 → 自动读取代码、生成执行器、注册、自测，全自动接入 CLI Agent 执行器 |
| **createzzdemo** | `/createzzdemo` | 输入教程名 → 枚举 A-F 6 类步骤让用户选组合，生成 DailyTipUpsert JSON 入库，含大全套 showcase 回归模板 |
| **tutorial-daily-maintain** | `/tutorial-daily-maintain` | 定时(建议每日) → 扫 git 增量映射受影响页面教程 → 锚点漂移检测(P0-P2) → 起草「本周有更新」提醒(advanced/`*-update-*`) → 教程健康报告发布到独立验收知识库。首版只产草稿+告警，不自动改 seed |
| **entropy-cleanup** | `/entropy` | 无需输入 → 扫描 doc/ 命名、index.yml、guide.list、技能表、changelog 碎片、codebase-snapshot 五维一致性，输出欠款清单并自动补齐 |
| **laowang** | `老王`、`/laowang` | 用户卡住/任务太难/争执不下时触发 → 用米多解决问题五步法（直面问题 → 抓主要矛盾 → 责任到人 → 备齐资源 → 做好才算做）强制拆解。风格直率，副作用：50% 概率追加一项延伸任务 |

### 专项修复技能

| 技能 | 触发词 | 输入 → 输出 |
|------|--------|-------------|
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
| **ui-ux-pro-max** | — | 输入设计需求 → 67 种风格 + 96 种配色 + 57 种字体搭配，支持 13 种技术栈 |
| **product-document-generator** | — | 输入产品需求 → 按工程版 1+N 主-子文档模板或敏捷版模板生成/补全符合 AI 开发要求的产品文档（Part A 价值层 + Part B 功能层两阶段） |

### 元技能

| 技能 | 触发词 | 输入 → 输出 |
|------|--------|-------------|
| **findmapskills** | `海鲜市场` | 输入能力需求 → 通过长效 API Key 在 PrdAgent 海鲜市场搜索、下载、上传、订阅技能包 |
| **find-skills** | `找技能` | 输入能力需求 → 从技能生态搜索并推荐可安装的第三方技能 |
| **api-debug** | — | 输入 API 端点 → 查询真实 API 数据辅助调试 |
| **dev-setup** | `装环境` | 无需输入 → 自动检测并安装 .NET/Node/Rust/pnpm SDK，执行 API 测试 |
| **qa-ledger** | `/ledger` | 无需输入 → 在回复开头追加「对话台账」表格，逐条登记本轮问题/处理状态/结论，让交付有迹可循 |

### 使用指引

0. **首次开发 Agent** → `/help` 进入新手引导，全程阶段式陪伴（详见 `doc/guide.platform.agent-onboarding.md`）
1. **新需求提出时** → `/validate` 验证需求质量和价值（中大型功能必跑）
2. **方案设计时** → `/plan-first` 先出方案再动手，用户确认后执行
3. **方案评审时** → 先 `/risk` 评估风险，再 `/trace` 追踪关键链路
4. **开发完成后** → 先 `/verify` 交叉验证，再 `/scope-check` 边界检查
5. **部署测试时** → `/cds-deploy` 一键部署灰度环境，再 `/smoke` 冒烟测试
6. **需人工验收时** → `/preview` 生成预览地址 → `/uat` 生成逐步打勾的验收清单；复杂验收先走 `/验收场景` 做范围和证据链编排，再走 `/验收`（create-visual-test-to-kb）以真人路径复验并归档证据
7. **提 PR 前** → `/resolve` 预合并主分支，AI 代替人类解决冲突
8. **准备上线时** → `/handoff` 生成交接清单（涉及 3+ 文件时自动触发）
9. **周五收尾时** → `/weekly` 生成本周总结（完成后自动触发 `/doc-sync`）
10. **写文档时** → `/doc` 查看类型速查，或直接创建文档时自动套用模板
11. **迁移/重构后** → `/hygiene`
-->
生命周期主线（按顺序取用）：需求 `/validate` → 方案 `/plan-first` → 风险 `/risk` → 链路 `/trace` → 实现 → 交叉验证 `/verify` → 边界 `/scope-check` → 部署 `/cds-deploy` → 冒烟 `/smoke` → 预览 `/preview` → 验收 `/uat`（复杂场景先 `/验收场景` 再 `/验收`）→ 交接 `/handoff` → 周报 `/weekly`。

常用辅助：`/resolve` 预合并解冲突、`/doc` 写文档、`/doc-sync` 对齐索引、`/entropy` 清理一致性欠债、`/hygiene` 清技术债、`/llm-trace` 排查模型调用不符、`/laowang` 卡住时强制拆解。首次开发 Agent 走 `/help`。
