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

替代方案：状态/类型用 SVG icon（前端已有 ICON 注册表 / lucide-react / cds 的 `ICON.*`）；重要程度用文案分级（建议 / 警告 / 必填 / 已禁用）；视觉强调走 CSS（颜色、加粗、底色）。

例外仅限本节：为说明「哪些字符算 emoji」，可在 inline code 里写反面例子如 `'rocket'`。

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
| `prd-admin/` `prd-desktop/` `.ts` `.tsx` | `pnpm tsc --noEmit` + `pnpm lint`（改动文件零新增告警） |
| `llmgw/` | 见 `llmgw/AGENTS.md` 的模块校验表 |
| 含测试的模块 | `pnpm test` / `dotnet test` 全绿 |
| 本地缺 SDK | 走 `/cds-deploy` 远端编译，CDS 绿灯后才推送 |

**5.3 禁止自动创建 PR**。除非用户明确说「提 PR / 创建 PR」，任务完成只做 commit + push。遇阻塞说明原因并等指示，禁止提交半成品。

**5.4 PR 描述走标准模板**，SSOT 是 `.github/pull_request_template.md`（改格式只动这一个文件）。必填段落：摘要 / 改动 diff（按端分组、逐条「文件或模块 + 一句话」）/ 测试 / 风险与已知边界。

模板是下限不是上限：① 必填段落不得缺失；② 不适用的写「无」或删除，不得写占位空话；③ 不得因模板没某栏就丢弃重要信息。平台自动创建的 PR（描述只有一行 commit message）后续**必须**补全。

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

- 正确：`spec.cds.settings.md`、`design.cds.agent.runtime.md`
- 错误：`spec.cds-settings.md`（黏连）、`design.defect-automation-autonomy.md`（appname 不在首段）、`output-xxx.md`（无前缀）

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

- **架构规则** `.claude/rules/`：52 条，全体 Agent 共用，每条开头两行导读（`**一句话**` / `**什么时候撞上**`）。支持路径作用域的宿主（如 Claude Code 的 `paths` frontmatter）按命中文件自动加载；**不支持的宿主必须自己按下面这份清单主动去读**。
- **Codex 专属补充** `.Codex/rules/`：不与共用规则重复，Codex 侧没有按需加载机制，所以在此点名——
  - `local-debugging.md`：本地连调、视觉修复、接口排查、CDS 部署验证的工作方式。
  - `production-release-safety.md`：碰发布链路（`exec_dep.sh` / `fast.sh` / `deploy/nginx/**` / `docker-compose*.yml` / 发布类 workflow）前必读，它再指向 SSOT `doc/rule.platform.production-release-safety.md`。公网 HTML 与入口资源可用才算发布完成，容器或接口健康都不算数。
- **技能**：57 个，位于宿主的项目级技能根（`.claude/skills/`；部分通用宿主用 `.agents/skills/`）。名称与描述通常由宿主自动注入，此处不重复维护清单。

生命周期主线（按顺序取用）：需求 `/validate` → 方案 `/plan-first` → 风险 `/risk` → 链路 `/trace` → 实现 → 交叉验证 `/verify` → 边界 `/scope-check` → 部署 `/cds-deploy` → 冒烟 `/smoke` → 预览 `/preview` → 验收 `/uat`（复杂场景先 `/验收场景` 再 `/验收`）→ 交接 `/handoff` → 周报 `/weekly`。

常用辅助：`/resolve` 预合并解冲突、`/doc` 写文档、`/doc-sync` 对齐索引、`/entropy` 清理一致性欠债、`/hygiene` 清技术债、`/llm-trace` 排查模型调用不符、`/laowang` 卡住时强制拆解。首次开发 Agent 走 `/help`。
