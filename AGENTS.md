# AGENTS.md

PRD Agent / MAP 的仓库共用规则。根 `CLAUDE.md` 导入本文件，不另维护正文副本。本文件保留长期约定、常用命令与查找入口；运行状态、验收记录和历史事故留在各自系统或 Git 历史中。

## 开始工作

- 先运行 `git rev-parse --show-toplevel`、`git branch --show-current`、`git status --short`；保留已有改动，不混入他人的文件。
- 本文件中的路径均相对 Git 仓库根目录，命令默认从根目录执行；模块命令先进入对应目录，worktree 使用各自的根目录。不要求固定的用户名、磁盘位置或克隆目录名。
- 根据当前操作系统、shell 和任务检查依赖；工具安装位置、个人技能目录与插件缓存从当前环境发现，不沿用其他设备的路径。
- 按本次任务的最新明确指令执行；主动完成已授权工作。一次性发布、合并、停服务或付费授权不成为永久权限。
- 修改模块前读取其 `AGENTS.md`；尚只有 `CLAUDE.md` 的模块，手动读取其中的模块约定。专项规则按末尾入口查找，不全量通读。

## 项目与模块

PRD Agent 是工程名称，MAP 是产品平台：围绕产品知识、需求、缺陷、报告、评审和工作流开展可追溯的团队协作。产品能力见 [README](README.md)。 CDS 是自动交付平台，负责项目接入、分支预览、部署过程、日志、版本恢复与验收证据，见 [CDS 规格](doc/spec.cds.md)。

| 目录 | 职责与模块入口 |
|---|---|
| `prd-api/` | .NET 8 API 与后台任务；[模块约定](prd-api/CLAUDE.md) |
| `prd-admin/` | React + Vite Web；[模块约定](prd-admin/CLAUDE.md) |
| `prd-desktop/` | Tauri 桌面端；[模块约定](prd-desktop/CLAUDE.md) |
| `llmgw/` | 统一模型网关，含控制台与 serving；[模块约定](llmgw/AGENTS.md) |
| `cds/` | CDS 控制面与 Web；[模块约定](cds/CLAUDE.md) |
| `claude-sdk-sidecar/` | Agent SDK 侧车；[说明](claude-sdk-sidecar/README.md) |

模块能否运行，以当前 checkout 的源码与构建清单为准，不按旧目录树推断。
本地开发可运行 `docker compose -f docker-compose.dev.yml up -d --build`：Web `5500`、API `5000`、Mongo `18081`、Redis `18082`。 快捷脚本：`./quick.sh` 启动后端，`./quick.sh admin` 启动 Web，`./quick.sh all` 启动全套；Windows 用 `./quick.ps1 all`。仅查文档时无需启动服务。
新环境首次构建前，前端在目标模块运行 `pnpm install --frozen-lockfile`，后端在 `prd-api/` 运行 `dotnet restore` 后再使用 `--no-restore`；SDK 与工具版本以模块构建清单、锁文件和 CI 为准，不沿用其他设备的安装版本。

## 环境与认证

以下变量名是用户指定的操作约定，不代表所有工具都会自动读取；不写入敏感值，不打印整份环境、凭据文件或认证响应。

| 变量/环境 | 用途 |
|---|---|
| 本地开发 | 当前 checkout 与本地依赖；不能代表线上版本。 |
| `CDS_HOST` / `CDS_TEST_HOST` | CDS 控制面 / CDS 测试控制面；查询项目、分支、状态、日志，均不是 MAP 业务入口。 |
| CDS 功能分支预览 | 当前分支的业务验收入口，从 CDS 查询，禁止拼域名或 branch ID。 |
| `MAP_CDS_MAIN_HOST` | MAP 的 CDS main 业务入口；main 分支、运行 SHA 与正式版本分别核对。 |
| `MAP_PROD_HOST` | MAP 正式业务入口；main 更新不等于正式已发布。 |
| `CDS_USER` / `CDS_PASSWORD` | CDS 人类登录账号；旧文档的 `CDS_USERNAME` 是服务端配置名，不假定 CLI 自动读取 `CDS_USER`。 |
| `MAP_USERNAME` / `MAP_PASSWORD` | MAP 页面登录账号，与 CDS 账号分开使用。 |
| `AI_ACCESS_KEY` | 自动化 API 鉴权；CDS 管理层与 MAP 业务层分别校验，不假定接受同一值或同一权限。 |

人类从目标 CDS 的 `/login` 登录，按实例启用的账号、GitHub 或 SSO 方式操作；MAP 从目标业务入口登录。
Agent 复用已授权凭据；缺失时按 [cds 技能](.claude/skills/cds/SKILL.md) 的 `connect` 页面批准流程接入。项目凭据 `.cds/credentials.json` 不得提交或展示，不为接入修改 shell profile。
换设备后重新检查环境变量与项目授权；本地凭据不会随 Git 克隆自动迁移，不假定另一台设备的登录态仍然可用。
配置缺失或认证失败时明确报告，不猜地址或账号。环境与认证细节见 [环境指南](doc/guide.cds.env.md) 和 [认证说明](.claude/skills/cds/reference/auth.md)；旧示例若打印密钥，改为仅检查存在性或脱敏结果。

## CDS 只读查询

本仓库的 CLI 源码为 `.claude/skills/cds/cli/cdscli.py`，其他技能复用它；该路径随仓库克隆，不依赖个人技能目录。先看 `--help`，ID 和 profile 从当前实例返回值获取，不从名称推算。
下例的 `python3` 表示可用的 Python 3 解释器；Windows 等环境可按实际安装改用 `py -3` 或 `python`，先核对版本。`<...>` 是待替换占位符，不能原样执行。

```bash
python3 .claude/skills/cds/cli/cdscli.py --help
python3 .claude/skills/cds/cli/cdscli.py auth inspect --strict
python3 .claude/skills/cds/cli/cdscli.py --human project list
python3 .claude/skills/cds/cli/cdscli.py --human branch list --project <projectId>
python3 .claude/skills/cds/cli/cdscli.py branch status <branchId>
python3 .claude/skills/cds/cli/cdscli.py branch history <branchId>
python3 .claude/skills/cds/cli/cdscli.py branch logs <branchId> --profile <profileId> --tail 100
python3 .claude/skills/cds/cli/cdscli.py deployment-run list --project <projectId>
python3 .claude/skills/cds/cli/cdscli.py deployment-run diagnose <runId>
```

`history` 查操作日志，`logs` 查容器日志，`deployment-run` 查阶段与失败诊断；输出需脱敏。入口查询见 §11。
查询不隐含部署、回滚、重启或修改配置授权。已连接 GitHub 的项目 push 可自动触发部署，只有本地修改授权时不要顺手 push。

## 0. 禁止 Emoji

代码、UI、文档、changelog、提交、PR 和给用户的回复均禁止 emoji。使用 SVG / lucide 图标或文字表达状态。

## 强制规则

### 1. 包管理器

前端统一 pnpm，禁止 npm / yarn；只保留 `pnpm-lock.yaml`，不提交其他包管理器锁文件。

### 2. C# 静态分析

改 `.cs` 后用 `dotnet --info` 检查 SDK；命令不可用时，按当前系统的实际安装位置定位，不假定固定路径。有 SDK 就在 `prd-api/` 跑 `dotnet build --no-restore`。修复编译错误，评估并修复本次新增的 `warning CS*`；保留退出码，不用日志过滤管道冒充 build 成功。远端判据见 §5.2。

### 3. 项目执行原则与交接

- **一次做好，少让用户操心**：先核实目标与问题、确定验证方法，再统筹实现、回归和交付；已授权且可自行判断的事项不逐步请示，不用口头“完成”代替结果。
- **未完成就持续推进，只因真实阻塞停下**：正常等待、可自行修复的失败不算阻塞；缺授权、凭据或外部资源、用户预算已尽，或安全/范围熔断需要决策时，一次说明证据、最小所需输入与续接动作，并继续不依赖阻塞的工作；用户暂停或取消立即遵从。
- **做完回看，清场再走**：交付前亲自检查最终产物和真实用户路径、核对证据与遗留项，按归属安全清理本任务临时资源；保留用户改动、共享资源和必要诊断证据，不把自测甩给用户，不把未验证写成完成。
- **交接**：涉及 3+ 文件 / API 端点 / UI 页面变更时，必须主动用 `task-handoff-checklist` 生成交接清单；1-2 个文件的小修改可简要交付。PR 收尾与评审修复使用 [game-over](.claude/skills/game-over/SKILL.md)。

### 4. Changelog

业务模块代码变更提交前，在 `changelogs/YYYY-MM-DD_<短描述>.md` 建一个碎片；同一 PR 全部变更放同一文件，禁止直接改 `CHANGELOG.md`。内容为无表头的表格行，例如 `| fix | prd-admin | 修复弹窗布局 |`。 类型：`feat/fix/perf/refactor/docs/chore/test/ci/security/ops/style/polish/rule/merge/revert`。纯文档、纯规则调整可选记录；发版由 `scripts/assemble-changelog.sh` 合并。

### 5. 提交与 PR

**5.1 中文提交**：标题与正文用中文，可保留技术术语和 Conventional Commits 前缀；类型沿用 §4，另可用 `build/release`。

**5.2 校验门禁**：push 前完成可执行的本地检查，失败不推送；push 后回看本次 SHA 对应 CI 和部署结果，失败当场修复。尚未运行或被跳过的检查不得写成通过。

| 改动 | 最低验证要求 |
|---|---|
| `prd-api/**/*.cs` | 有 SDK 时先 build。API 镜像构建成功只证明 API 项目编译；sln 与非集成、非手工 xUnit 以 CI `Server Build & Test` 为远端判据。 |
| `prd-admin/`、`prd-desktop/` 的 TS/TSX | 在对应模块跑 `pnpm tsc --noEmit`、`pnpm lint`，改动文件零新增告警；改 CSS 另跑 `pnpm build`。 |
| 含测试的模块 | 跑模块测试套件；Desktop Vitest 用 `pnpm test --run` 避免 watch。C# 常规测试过滤为 `Category!=Integration&Category!=Manual`。 |
| C# Integration / Manual | 仅按 `FullyQualifiedName` 点名受影响用例，先确认外部依赖和费用，禁止无过滤全跑；模块旧文档中的无过滤示例也须按此收窄。 |
| `prd-api/tests/PrdAgent.Tests/` | 不引用 API 项目；测试 API 源文件时核对 csproj 的链接编译项，防止只编生产镜像遗漏测试编译错误。 |
| `llmgw/` | 按 [模块校验表](llmgw/AGENTS.md)；`cds/` 与其他模块以其约定、package scripts 和实际 workflow 为准。 |

CI 的触发范围与步骤以 `.github/workflows/` 为准：当前 `ci.yml` 跑 main/develop push、对应 PR 或手动 dispatch；feature push 本身不会触发它。已有 PR 会自动触发时不要重复 dispatch；也不能为触发 CI 擅自创建 PR。详细判据见 [验证规则](.claude/rules/cds-first-verification.md)。

**5.3 PR 授权**：默认开发交付为 commit + push；用户限定本地修改、只读或先审视时从其要求。只有明确要求“提 PR / 创建 PR”才创建；未经明确授权不得合并，默认 Ready、关闭自动合并。不得提交半成品或无关改动。

**5.4 PR 描述**：使用 [.github/pull_request_template.md](.github/pull_request_template.md)，包含摘要、按端分组的改动 diff、测试、风险与已知边界；无适用内容写“无”，自动生成的简略描述也须补全。

**5.5 Review 范围熔断**：修第一条评论前，在 PR 描述明确单一目标、不变量、不做的事，以及首轮文件数和 diff 行数。评论分为 A 直接缺陷（修复并补代表性测试）、B 有价值但扩范围（记后续 issue 或 debt）、C 推测性变体（无生产路径证据不实现）。
命中任一条件停止追加修复并跑 `scope-check`：连续 3 轮产生新语义类别；Review 修复提交达 8 个；diff 超首轮 2 倍或扩出文件清单；同一自由文本解析器第二次被要求加同义词或嵌套格式。随后缩范围、改结构化输入，或由用户批准扩范围；机器评论不能单独授权扩需求，清空评论不作为完成标准。

### 6. LLM 过程可视化

LLM 调用必须展示流式内容、可用的 thinking 内容、批次进度或阶段状态；兜底至少动画与预计耗时。静止“加载中”超过 2 秒视为体验缺陷。模型调用走统一网关，详见 [LLM Gateway 规则](.claude/rules/llm-gateway.md)。

**6.1 产品体验与展示边界**：先按[预期管理](.claude/rules/expectation-management.md#产品和用户相互可预测)判断产品是否理解用户工作、用户能否预测点击结果；少点击、折叠、紧凑和技术全绿不自动证明优秀。产品页面只保留用户完成业务所需的操作、结果、当前状态和恢复指引；迁移详情、研发验收报告、覆盖矩阵、交付台账等内部交付记录不得做成产品入口或面板，也不得改名、折叠或放进帮助浮层后继续展示。归档、业务例外与交付自审见 [UI 规则](.claude/rules/chief-designer-usability.md#产品与内部交付记录的边界)。

### 7. 沿用现有契约

- 新 Mongo 实体先读现有 Model（如 `DefectReport.cs`）：Id 用 `Guid.NewGuid().ToString("N")`，不加 `[BsonId]` / `[BsonRepresentation]`；Controller 用户 ID 用 `this.GetRequiredUserId()`。
- 新 `services/real/*.ts` 先读 `prd-admin/src/services/real/apiClient.ts`：`apiRequest` 的 body 传原始对象；FormData 用直接 fetch；响应判断 `res.success`，错误取 `res.error?.message`。

### 8. 「完成」标准

**项目发布合同（不可绕过）**：默认 `cds-release.sh` 由项目提交与 CI 测试，CDS 只执行同提交脚本并记录正文哈希，不猜业务部署类型；独立脚本仅做明确备选，旧模式仅兼容。代码/资源变化须同步发布验证，禁借旧 CI、删校验、热改服务器或换旧模式绕过；须有同提交 CI、真实发布与公网证据。细则见 `.claude/rules/project-release-contract.md`。

声称完成前必须全部满足：后端编译零错误（判据见 `cds-first-verification.md` 的权威位置表：Branch Image 绿 = API 编得出来，CI 的 `Server Build & Test` 绿 = sln 零 error + 非集成非手工 xUnit；CDS 只负责运行、不负责编译）／前端页面能通过预览地址打开并正常渲染／核心业务流程端到端跑通（不是只有 CRUD）／直连预览域名测试（container-exec 是诊断工具不是验收工具）／依赖的外部服务已确认可用。

**验收技能自动触发**：用户要求「页面验收、功能验收、回归验收、验收报告」或交付需要这些产物时，即使未写斜杠命令，也必须读取 [create-visual-test-to-kb](.claude/skills/create-visual-test-to-kb/SKILL.md)，按其前置要求执行 [acceptance-test-design](.claude/skills/acceptance-test-design/SKILL.md) → [acceptance-scenario-orchestrator](.claude/skills/acceptance-scenario-orchestrator/SKILL.md) → 取证归档。宿主未列出技能时按这些仓库路径读取；`human-verify`、`/uat`、交接清单和 CDS 上传回执均不能替代。执行类验收报告必须经标准 `archive_report.py` 生成、准入校验和 `verify-open.mjs`；缺步骤保持验收未完成，不得手写 HTML、改档位或补模板标记绕过。禁止：骨架完成就报「已实现」；绕过真实访问路径测试；不主动查系统能力。**理解与纠偏**：先读真实源码、样式和用户素材，明确必留特征；重大视觉改动先自查并展示可运行关键场景，再按已有授权继续扩展，不增设审批（见 `.claude/rules/visual-anchor-first.md`）；收到否定反馈先对照原始要求与证据，说明具体偏差和修正动作，再实施并重跑能暴露偏差的路径，交付验证结果与证据，未验证就明说。禁止反复道歉、换措辞或堆功能代替纠偏，反馈不自动授权扩范围。

**用户能看懂也是完成门槛。** 面向用户交付时，必须按对话模板逐项回答原始业务目标：现在能做什么、怎样证明、还有什么没做到。主结论要用普通中文直接呈现，不能让用户阅读JSON、源码、日志或Markdown文档链接后自行判断。技术文件仅作佐证。用户明确表示看不懂时，交付状态保持未通过，先改正说明与可见证据，不能用测试数量、提交成功或内部验收标签代替用户验收。

**8.1 自测优先**：提交前至少跑通一条自测路径，交付写明路径、断言和结果；可选 Vitest / xUnit 断言新行为、CDS 灰度部署后冒烟、Playwright 直连预览域名走真实路径，或已有 API key 调真实端点断言。UI 仍须满足 §8。
自测跑不通时，列出已尝试路径，明确“自测未跑通，问题可能仍存在”，不得先将校验责任交给用户，也不许声称已修复。纯文档 / 注释 / changelog，或用户明确允许稍后测试时例外。 交付功能入口时，必须在交付的同一实例、账号和数据上下文中完成用户的主体任务；缺少版本、目标或操作权限的演示空态只算界面冒烟。其他环境中的成功不能替代交付入口的任务完成。用户拒收时先按其实际入口复现，保留首次失败，再按同一任务复验。

<!--
历史背景：2026-05-07 用户反复反馈「修了七八轮还是同一个 bug」，根因之一是 AI 提交后只跑
tsc --noEmit + 单元测试，把「端到端是否真的解决」丢给用户去点击验证。用户不是 QA。
-->

### 9. 新功能入口

新 Agent 默认在 `prd-admin/src/stores/toolboxStore.ts` 的 `BUILTIN_TOOLS` 注册，带 `wip: true`，通过 §8 后才转正式。导航与首页快捷按需升级；其他路由按 [导航注册规则](.claude/rules/navigation-registry.md) 选权威数据源，不重复维护清单，跑 `navCoverage`。 交付新功能必须包含三行：【位置】具体菜单或百宝箱；【路径】登录后逐步点击路径；【预览】实际功能页深链。不能只给路由或根地址。

### 10. doc/ 命名：`{类型前缀}.{appname}[.{子模块}].md`

两条铁律缺一不可（完整语义见 `doc/rule.doc.naming.md`）：
1. **类型前缀**：`spec.` `design.` `plan.` `rule.` `guide.` `report.` `debt.` `adr.` `pdr.`。类型原则同样放在 `doc/`，以 `guide.doc.pri.<类型>.md` 解释各类文章的作用并纳入统一索引；ADR/PDR 保存重要选择的理由与历史，现行规格与设计通过链接引用。
2. **appname 优先 + 点分层级**：topic 第一段是应用名，子模块用 `.` 续接，禁止用 `-` 把 appname 和子模块黏死

跨切面用保留域名段 `platform.` / `frontend.` / `skill.` / `doc.`。目录保持扁平，禁子目录。内容层级不授权根目录例外；规则或守卫变更须对照原约束与明确授权，不得扩白名单或豁免索引迁就错误产物。

正确 `spec.cds.settings.md`、`design.cds.agent.runtime.md`；错误 `spec.cds-settings.md`（黏连）、`design.defect-automation-autonomy.md`（appname 不在首段）、`output-xxx.md`（无前缀）。

`debt.*` 记工程债务台账——交付时声明的「已知边界」必须固化进对应 `debt.{module}.md`，不能只留在 commit message 里。

**每篇文档必须带导读三行**（`**一句话**` / `**谁该读**` / `**读完能做什么**`，写在 H1 与版本行之后）。正文只写人类要掌控的层次（为什么做 / 给谁用 / 数据怎么流动 / 关键表设计 / 取舍与风险 / 验收标准）；**实现代码、接口签名、目录树、逐文件改法一律不进文档**——AI 要细节直接读源码。闸门：`python3 scripts/doc-readability-check.py --ratchet`（CI `docs-readability`，新文档不带导读三行会红）。

新增/重命名文档后同步 `doc/index.yml` 与 `doc/guide.list.directory.md`。评测产出的样本/证据/报告**不进 `doc/`**，归验收知识库。

### 11. 真实预览深链

代码 push 后或需人工验收时，使用 [preview-url 技能](.claude/skills/preview-url/SKILL.md) 查询实际公开入口：

```bash
python3 .claude/skills/cds/cli/cdscli.py --human preview-url
```

保留 CDS 返回的全部公开入口，并按各自真实路由追加页面、query 或锚点；不猜域名、不暴露隐藏/内部域名、不用历史 URL 代替查询。取不到时说明缺凭据、未部署或查询失败，不补推算值。仅文档、Agent 元数据或 changelog 变更不要求部署预览。

### 12. 第三方服务器返回信息必须审计

每次第三方调用必须持久化可关联业务请求的脱敏响应证据；成功、失败、超时和解析异常均须可追溯，禁止只记 HTTP 状态或归一化错误。完整约束见 [第三方响应审计原则](.claude/rules/external-response-audit.md)，验收必须证明能从本系统查询上游返回与本地判定。

## 按任务读取规则与技能

- 新增或调整 CDS 页面导航前，必读[页面切换动效规范](.claude/rules/cds-page-motion.md)。
- 共用架构规则在 `.claude/rules/`。先按文件名与开头的“一句话 / 什么时候撞上”选择相关规则，再读全文；不要依赖宿主必然自动加载。枚举、数据引用、快照、长任务和 UI 变更各有专项约束。
- Codex 连调、视觉修复、接口排查先读 [.Codex/rules/local-debugging.md](.Codex/rules/local-debugging.md)。只读或脏工作区不机械执行其中的 pull 示例；先遵守任务范围与保留改动约定。
- 修改用户可见错误时，读 [.Codex/rules/user-readable-errors.md](.Codex/rules/user-readable-errors.md)：说明结果与恢复动作，原始诊断仅留在脱敏日志或管理员详情中。
- 改发布脚本、nginx、compose 或发布 workflow 前，必读 [.Codex/rules/production-release-safety.md](.Codex/rules/production-release-safety.md)，再读其指向的生产安全合同。公网 HTML 与入口资源可用才算发布完成。
- 仓库技能位于 `.claude/skills/` 和 `.agents/skills/`；宿主可能额外生成链接，缺链接时直接读取仓库内实际的 `SKILL.md`，不依赖另一台设备的安装状态。按 `name/description` 选择，不按固定数量或旧清单判断；个人技能由当前宿主发现，不复制个人路径与无关偏好。发现技能目录缺少 SKILL.md 时按缺陷报告，不把它当作不存在。
- CDS 接入 / 鉴权 / CLI 用 [cds](.claude/skills/cds/SKILL.md)；项目扫描用 [cds-project-scan](.claude/skills/cds-project-scan/SKILL.md)；部署与日志排障用 [cds-deploy-pipeline](.claude/skills/cds-deploy-pipeline/SKILL.md)；正式发布用 [cds-release](.claude/skills/cds-release/SKILL.md)。技能可读不等于远端权限或依赖已可用。
- API 排查用 [api-debug](.claude/skills/api-debug/SKILL.md)，核心旅程回归用 [stable-smoke](.claude/skills/stable-smoke/SKILL.md)，真实页面取证归档用 [create-visual-test-to-kb](.claude/skills/create-visual-test-to-kb/SKILL.md)，写文档用 [doc-writer](.claude/skills/doc-writer/SKILL.md)。
- 需求、方案、风险、追踪、审查按任务选 `skill-validation/plan-first/risk-matrix/flow-trace/human-verify/scope-check`；无需为每个小改串行执行整套技能。新增规则优先补在适用目录或现有专项文件，根文件只保留必要约束与入口。

生命周期主线（按顺序取用）：需求 `/validate` → 方案 `/plan-first` → 风险 `/risk` → 链路 `/trace` → 实现 → 交叉验证 `/verify` → 边界 `/scope-check` → 部署 `/cds-deploy` → 冒烟 `/smoke` → 预览 `/preview` → `/uat`（仅执行前清单）→ `/验收`（复杂场景先 `/验收设计` → `/验收场景`，标准生成、准入与线上打开验证不可省）→ 交接 `/handoff` → 周报 `/weekly`。常用辅助：`/resolve` 预合并解冲突、`/doc` 写文档、`/doc-sync` 对齐索引、`/entropy` 清理一致性欠债、`/hygiene` 清技术债、`/llm-trace` 排查模型调用不符、`/laowang` 卡住时强制拆解；首次开发 Agent 走 `/help`。
