# CDS Web 迁移运行手册

> 类型：guide（运行手册） | 状态：持续更新 | 更新：2026-04-28
> 适用范围：`cds/web/` React 迁移、`cds/web-legacy/` 退场、CDS 本地验收。

---

## 1. 交接入口

每次接手 CDS Web 迁移时，先读以下文件，不依赖聊天记录：

1. `doc/plan.cds-web-migration.md`：路线图、当前完成状态、下一页迁移计划。
2. `doc/guide.cds-web-migration-runbook.md`：本文件，包含命令、验收清单和防遗忘机制。
3. `cds/CLAUDE.md`：CDS 模块硬约束，尤其是禁止 emoji、主题 token、API label。
4. `cds/src/server.ts`：`MIGRATED_REACT_ROUTES` 和 `installSpaFallback()`。
5. `cds/web/src/App.tsx`：React client 路由表。

---

## 2. 当前状态

React 已接管：

| 路由 | 页面 | 状态 |
|------|------|------|
| `/hello` | 基础验证页 | 已迁移 |
| `/cds-settings` | CDS 系统设置 | 已迁移，GitHub App 与 Device Flow 已在 React 管理，legacy 文件已删除 |
| `/project-list` | 项目列表 | 控制台式首屏已打磨；新建项目 GitHub repo picker、Git URL 快速创建、clone progress、clone 后自动 detect/profile、GitHub repo 自动绑定、技能包下载、全局/项目级 Agent Key 管理、Agent pending import 审批已迁移 |
| `/branches/:projectId` | 分支列表 | 已迁移；旧 `/branch-list?project=<id>` 由 React 兼容；支持远程分支一键创建、部署并打开预览；已补收藏置顶、tag 编辑、调试标记、重置、删除确认、状态快筛、排序、紧凑模式和批量部署/拉取/停止/收藏/重置异常/删除 |
| `/branch-panel/:branchId` | 分支详情 | 已迁移；旧 `/branch-panel?project=<id>` 进入 React 分支选择；支持部署日志、容器日志、单服务重部署、运行时诊断、干净重建确认、profile override 常用字段编辑、预览别名、固定/恢复历史 commit、HTTP 转发日志、Bridge 会话控制与状态读取 |
| `/branch-topology?project=<id>` | 服务拓扑 | 已迁移；用简化 React 拓扑展示应用服务、基础设施、分支运行状态、依赖和跳转入口；粘贴分支预览会跳回 `/branches/:projectId?preview=<branch>` 复用同一条创建/部署/打开预览链路 |
| `/settings/:projectId` | 项目设置 | 基础信息、GitHub、评论模板、缓存诊断、统计、活动日志、危险区删除已迁移；自动部署开关写项目事件策略 |

下一步优先级：

| 顺序 | 路由 | 目标 |
|------|------|------|
| 1 | Week 4.5 收口 | 继续以“一键接仓库、一键预览、自动化”为主线；当前已补部署排错闭环和拓扑轻预览入口，只剩是否升级 React Flow 需要产品判断 |
| 2 | Week 5 清理 | 用户明确确认 React 版能力足够后，才删除 legacy 静态层和重复规则 |

当前总进度：

| 维度 | 粗略进度 | 当前判断 |
|------|----------|----------|
| 路由迁移 | 约 90% | 主要业务 URL 已由 React 接管，根路径和 legacy fallback 仍保留 |
| 核心链路 | 约 89% | GitHub 项目创建、clone、detect/profile、远程分支预览、Agent 自动化、环境变量、系统更新、认证状态和 Mongo 默认存储入口已贯通 |
| 功能对齐 | 约 74% | 分支页已补容量、主机健康、执行器操作和活动流筛选/详情；拓扑已补节点日志/提交入口；更强失败建议仍需继续补 |
| 删除准备 | 0% | 未经用户确认，不进入删除旧代码阶段 |

功能放置规则：

| 层级 | 放置位置 |
|------|----------|
| 快速创建/预览/部署 | 首屏或右侧顶部，不能藏到高级设置 |
| 容量、批量、集群、活动流 | 分支页右侧运维面板或 `/cds-settings`，不要塞进每张分支卡片 |
| 拉取、停止、收藏、调试、标签、重置、删除 | 单卡“更多操作”或详情页，避免干扰预览主链路 |
| 日志、变量、路由、提交历史、runtime verify | 分支详情页或拓扑节点详情 tab |
| 危险操作 | 独立确认弹窗或危险区，禁止直接触发 |

布局规则：

- `/project-list` 首屏固定为控制台层级：标题区展示项目统计和全局操作，紧接 Git URL 快速创建表单，项目以横向操作行展示；不要再为每个入口另造一套孤立卡片。
- 小型统计块统一使用 `MetricTile`；不要在每个页面继续复制 `Metric`、`Stat`、`MetricCard` 这类局部组件，除非确实需要完全不同的信息结构。
- `/branches/:projectId` 首屏固定为分支控制台：顶部是一键预览控制台，标题、粘贴分支表单、统计和项目/设置/拓扑入口必须属于同一个视觉层级；右侧栏从远程分支开始，后面依次是运维状态 → 主机健康 → 执行器 → 批量运维 → 最近活动。
- 默认视图只保留主链路：粘贴/选择分支、预览、部署、详情。筛选、排序、批量、容量、主机、执行器和活动流必须默认折叠；只有异常、容量不足或用户选中分支时才提升可见性。
- 右侧运维栏出现时，分支卡片默认保持单列；卡片在桌面宽度下按“身份 / 指标 / 操作”三栏组织，预览是唯一主按钮，详情/部署是次级按钮组，避免主链路按钮被挤压或换行错位。
- 移动端和窄桌面允许右栏下移，但远程分支仍必须紧跟快速预览。
- 不要用“宽屏自动双列”掩盖空白；如果数据量少，单张卡片必须横向吃满自己的工作区，否则会出现单卡半屏、文本截断和右侧空洞，读起来像未完成调试页。
- `/project-list`、`/branches/:projectId`、`/branch-panel/:branchId`、`/branch-topology`、`/settings/:projectId`、`/cds-settings` 这类控制台页面统一使用居中的控制台工作区：常规页约 `1320px`，需要左右运维栏的页约 `1360px`。禁止贴左的 `max-w-*`，禁止为了“显得宽”把稀疏数据撑到 2K 全屏。
- 不再使用全屏装饰网格背景。稀疏数据页要靠明确的工作区边界、列表表头和行式信息密度成立，不能让背景纹理替代布局。

核心链路约束：

- 创建 Git 项目后，用户不应再手动填写 BuildProfile；`POST /api/projects/:id/clone` 负责 clone → detect stack → create default profile。
- 新建项目时允许只粘贴 Git 仓库 URL；项目名称留空时前端应从仓库 URL 自动推导，不能让“命名”阻塞首次接入。
- GitHub clone URL 创建的项目应自动写入 `githubRepoFullName`，push webhook 第一次到达时回填 `githubInstallationId`。
- 后续迁移必须优先缩短“选择仓库 → 克隆 → 选择分支 → 预览”的路径；边缘设置只在阻塞这条路径时优先做。

存储目标状态：

- 新初始化默认使用 `CDS_STORAGE_MODE=mongo-split`。
- `./exec_cds.sh init` 会自动创建/启动 `cds-state-mongo` 并写入 `CDS_MONGO_URI`、`CDS_MONGO_DB`、`CDS_STORAGE_MODE=mongo-split`、`CDS_AUTH_BACKEND=mongo`；MongoDB 启动失败应直接失败，不静默退回 JSON。
- `state.json` 只允许作为旧数据迁移入口或显式测试/兼容模式，不再作为新业务默认存储。
- 真实运行时未配置 `CDS_MONGO_URI` 时应失败并提示先运行 `./exec_cds.sh init`，不要静默创建新的 `state.json`。
- 启动日志应显示 `State store: MongoDB split (...)`，不要再把 Mongo 模式误写成 `State file`。
- fresh install 不自动创建空 `default` 项目。
- 空 `default` 占位项目应在加载或 cleanup 时被清理，不应出现在新项目列表。
- 需要覆盖 legacy default 行为的测试必须显式 seed `default` 项目；不要让 `StateService.load()` 或 fresh install 隐式制造 default。

---

## 3. 本地命令

首次初始化：

```bash
cd cds && ./exec_cds.sh init
```

本地启动：

```bash
cd cds && ./exec_cds.sh start
```

Codex 桌面内做浏览器验收时，优先用前台模式，避免后台进程被会话清理：

```bash
cd cds && ./exec_cds.sh start --fg
```

`start/restart` 会在 Git HEAD 相同但 `cds/src/` 或 `cds/web/src/` 等源码有未提交改动时重新构建，避免本地预览继续运行旧 `dist/`。

停止和重启：

```bash
cd cds && ./exec_cds.sh stop
cd cds && ./exec_cds.sh restart
```

前端验证：

```bash
pnpm --prefix cds/web typecheck
pnpm --prefix cds/web build
```

后端验证：

```bash
pnpm --prefix cds build
pnpm --prefix cds exec vitest run tests/routes/server-integration.test.ts tests/routes/projects.test.ts tests/routes/legacy-cleanup.test.ts tests/services/state-projects.test.ts
pnpm --prefix cds exec vitest run tests/services/stack-detector.test.ts tests/routes/github-webhook.test.ts tests/integration/multi-repo-clone.smoke.test.ts
```

浏览器验收默认地址：

```text
http://127.0.0.1:9900/project-list
http://127.0.0.1:9900/branches/<projectId>
http://127.0.0.1:9900/branch-panel/<branchId>?project=<projectId>
http://127.0.0.1:9900/branch-topology?project=<projectId>
http://127.0.0.1:9900/cds-settings#storage
http://127.0.0.1:9900/cds-settings#cluster
http://127.0.0.1:9900/cds-settings#maintenance
http://127.0.0.1:9900/cds-settings#global-vars
http://127.0.0.1:9900/settings/<projectId>#env
http://127.0.0.1:9900/settings/<projectId>
```

---

## 4. 每迁一页必须同步

同一个改动必须覆盖这些落点：

| 落点 | 必做内容 |
|------|----------|
| `cds/src/server.ts` | `MIGRATED_REACT_ROUTES` 加路由；必要时加旧 URL redirect |
| `cds/web/src/App.tsx` | 加 `<Route>`；更新注释里的已迁移/待迁移列表 |
| `cds/tests/routes/server-integration.test.ts` | 覆盖 React route、legacy fallback、`/api/*` 不被 shadow |
| `cds/web/src/pages/*` | 新页面源码，API 统一走 `apiRequest()` |
| `doc/plan.cds-web-migration.md` | 更新 Week 章节勾选、进度日志和下一步 |
| `doc/guide.cds-web-migration-runbook.md` | 如命令、路由或验收方式变化，同步更新 |
| `cds/CLAUDE.md` | 如目录结构或迁移边界变化，同步更新 |
| `changelogs/` | 新增日期碎片，写清用户可感知变化和验证 |

---

## 5. 验收清单

功能验收：

- `/api/healthz` 可达，存储后端符合当前目标。
- `/api/projects` 在 fresh install 下返回空项目列表。
- `/project-list` 不显示空 `default` 项目，不显示无意义 legacy banner。
- `/project-list?pendingImport=<id>` 会自动打开 Agent 导入记录；可以预览 YAML，批准后 `pendingCount` 归零并把 profiles/infra/env 写入目标项目，拒绝时只记录原因。
- `/project-list` header 的“下载技能包”指向 `/api/export-skill`，响应应是 `application/gzip` 且带 `Content-Disposition` 附件文件名。
- `/project-list` header 的“全局通行证”能列出 `/api/global-agent-keys`，签发弹窗必须明确跨项目权限，明文只显示一次，吊销前必须弹确认。
- `/project-list` 首屏应展示“项目控制台”、统计、安装技能包、全局 Key、Agent 记录、Git 仓库 URL 快速创建和项目行里的“进入项目 / 设置 / Agent Key”操作；桌面宽度下项目统计与操作不能散成无关卡片堆。
- `/project-list` 默认主链路是“粘贴仓库 URL → 创建并 clone → 进入项目”；安装技能包、全局 Key、Agent 记录、项目设置、Agent Key 和删除属于二级操作，必须折叠或下沉，不能压过项目进入和仓库接入。
- 用 GitHub URL 创建项目时，响应里应带 `githubRepoFullName`；若 repo 未被其它项目绑定，默认 `githubAutoDeploy=true`。
- `/project-list?new=git` 或“新建项目”Dialog 中，只填 Git 仓库 URL 也应可提交，项目名应自动使用 repo 名。
- `POST /api/projects/:id/clone` 成功后应在 SSE 日志中出现 `[detect]` 和 `[profile]`，已识别栈时自动生成项目内默认 profile。
- `/branches/<projectId>` 能列出已跟踪分支和远程分支；点击远程分支“部署”会走创建分支 → 部署 → 打开预览。
- `/branches/<projectId>` 的删除分支必须弹确认；收藏、tag 编辑、调试标记、错误重置必须通过 PATCH/POST 后刷新或乐观更新。
- `/branches/<projectId>` 的搜索应同时作用于已跟踪分支和远程分支；收藏分支应置顶；状态快筛、排序、紧凑模式和批量部署/拉取/停止/收藏/重置异常/删除不应打断一键预览主链路。
- `/branches/<projectId>` 勾选分支后，右侧运维状态必须提前显示预计新增容器和剩余容量；容量不足时可一键停止较旧运行分支腾容量，点击部署仍可二次确认后继续。
- `/branches/<projectId>` 右侧“主机健康”应读取 `/api/host-stats`，展示 CPU、内存和 uptime；轮询请求必须带 `X-CDS-Poll: true`，避免污染最近活动。
- `/branches/<projectId>` 右侧“执行器”应读取 `/api/executors/capacity` 和 `/api/cluster/status`，展示节点列表、CPU/内存/分支数；排空和移除必须弹确认。
- `/branches/<projectId>` 部署动作必须显示耗时和最近步骤；如果 SSE 正常结束但分支状态为异常，UI 必须显示部署失败摘要，不能显示“部署完成”。
- `/branches/<projectId>` 异常分支卡片必须给出可操作失败建议，至少包含详情/日志入口和重置异常入口，不能只显示红色状态。
- `/branches/<projectId>` 右侧“最近活动”应订阅 `/api/activity-stream`，展示最近 CDS/Web/API/AI 事件，支持 API/Web/AI 筛选、按具体分支筛选、内联详情和复制请求摘要；断线应静默重连，不应打断主页面。
- 旧入口 `/branch-list?project=<projectId>` 仍进入 React 分支列表；`/branch-panel?project=<projectId>` 进入 React 分支选择或受控错误。
- `/branch-panel/<branchId>?project=<projectId>` 能展示服务状态、构建日志、容器日志、有效 profile 配置和最近提交。
- `/branch-panel/<branchId>?project=<projectId>` 默认只展示服务状态和主操作；构建日志、容器日志、有效配置、Bridge、最近提交和 HTTP 转发日志必须折叠，除非当前状态需要用户立即处理。
- `/branch-panel/<branchId>?project=<projectId>` 在分支或服务异常时必须显示“失败诊断”；明确配置错误应优先给补命令/补镜像/补端口入口，不能把无关缺失项混成同一批建议。
- `/branch-panel/<branchId>?project=<projectId>` 的运行时诊断必须显示可读摘要；容器不存在、停止或被清理时后端应返回明确错误，页面不能显示“诊断完成”或原始 JSON。
- `/branch-panel/<branchId>?project=<projectId>` 的动作日志必须区分运行中/完成/失败；诊断和 force rebuild 结果应能复制，force rebuild 部分失败要显示下一步建议。
- `/branch-panel/<branchId>?project=<projectId>` 的有效配置卡片能覆写命令、镜像、端口、路径前缀；恢复公共配置前必须弹确认，保存后提示重新部署生效。
- `/branch-panel/<branchId>?project=<projectId>` 能编辑预览别名、搜索历史 commit、区分最新/当前/已固定，并实时查看/筛选当前分支 worker HTTP 转发日志；固定/恢复前必须弹确认。
- `/branch-panel/<branchId>?project=<projectId>` 的 Bridge 卡片能激活/结束会话、显示 Widget 连接状态，并在连接存在时读取页面状态；不要在详情页暴露任意 click/type 命令。
- `/branch-topology?project=<projectId>` 由 React 接管；应展示应用服务、基础设施、分支运行状态。应用服务节点详情默认只展示摘要、状态和主操作；配置、分支、路由、变量、日志、提交等低频信息必须收进统一折叠面板，并能跳到分支详情、项目设置或预览入口。
- `/branch-topology?project=<projectId>&branch=<branchId>` 分支选择必须同步 URL；当前视图状态条应显示分支状态、运行服务覆盖、预览/详情入口，避免用户不知道当前看的是什么环境。
- `/branch-topology?project=<projectId>&branch=<branchId>` 单分支视图中，应用服务节点日志 tab 应读取构建事件、容器日志并支持复制；提交 tab 应读取最近提交，固定/恢复操作仍跳分支详情页承接。
- `/branch-topology?project=<projectId>` 的分支选择器应支持搜索；无匹配时引导回分支列表创建/部署，不在拓扑页复制一套部署流程。
- `/cds-settings#storage` 显示 MongoDB split store 状态正常，并列出 `cds_projects / cds_branches / cds_global_state` 三个集合的运行时计数。
- `/cds-settings#auth` 显示当前认证模式和状态；basic/GitHub 模式应显示退出登录按钮，disabled 模式应明确标记为本地开发模式。
- `/cds-settings#cluster` 显示本机健康、主节点 URL、调度策略、执行器列表；签发连接码、加入/退出集群、排空/移除节点都必须有清晰状态和危险操作确认。
- `/cds-settings#maintenance` 默认聚焦当前 CDS 源码分支、commit、目标分支选择、自更新预检、更新重启和强制同步确认；可复制 SSE 日志、镜像外观和危险操作默认折叠，浏览器验收阶段不要实际点击更新/强制同步。
- `/cds-settings#global-vars` 能新增、编辑、删除、搜索、遮蔽/显示/复制全局环境变量；一键整理变量必须先 dry-run 预览。
- `/settings/<projectId>#env` 能新增、编辑、删除、搜索、遮蔽/显示/复制项目级环境变量，保存后提示重新部署分支生效。
- 设置页 hash 深链必须同步 tab：直接打开或跳转到 `#storage/#maintenance/#global-vars/#env` 时内容与 URL 一致。
- 新迁移页面 dark/light 两主题均无暗色泄漏或低对比文本。
- 浏览器 console 无 React、CORS、proxy、404 静态资源错误。

代码验收：

- `pnpm --prefix cds/web typecheck` 通过。
- `pnpm --prefix cds/web build` 通过。
- `pnpm --prefix cds build` 通过。
- 相关 vitest 测试通过。
- `rg "/v2|web-v2|cds-settings.html|state.json"` 只保留合理历史或兼容引用。
- `tests/routes/branches.test.ts` 这类 legacy API 测试必须通过显式 seed 验证 default 兼容，不应把 default 自动创建带回生产路径。

---

## 6. 防遗忘机制

为避免 agent 在长任务或上下文压缩后丢失要求，采用以下机制：

1. 聊天里的“下一步”和“必跑命令”必须落到本 runbook 或计划文档。
2. 每完成一个页面，在 `doc/plan.cds-web-migration.md` 的“进度日志”追加一行。
3. 每次开始新页面前，先更新本文件的“下一步优先级”。
4. 每次 final response 只汇报本轮事实；长期交接信息以仓库文档为准。
5. 若用户临时给了验收参数、端口、账号或环境约束，优先写入本文件中不含密钥的部分；密钥只留在 `.cds.env` 或用户本地环境。

---

## 7. 当前下一步

A/B/C/D 阶段已收口。**当前进入 Week 4.6 视觉与主链路重构（向 Railway 看齐）**。详见 `doc/plan.cds-web-migration.md` Week 4.6 章节。

进入这一阶段的原因：用户验收明确表态满意度只有 50%——"大气是大气，但比旧版臃肿、破碎感强、心智负担重"。继续删除 legacy 等于把 50% 满意度定型，所以删除阶段推迟到本阶段完成后。

执行步骤（按顺序推进，每完成一项立即更新 plan / runbook / changelog）：

1. [x] 抽 `AppShell` + `TopBar` + `Workspace` + `Crumb` 共享布局组件（`cds/web/src/components/layout/AppShell.tsx`）；所有页面共用左侧 56px 导航条、顶部面包屑、居中 1240/1360px 工作区。
2. [x] 扩展 `cds/web/src/index.css` 引入 surface 三档（base/raised/sunken）+ hairline 边框 token + `.cds-hero` / `.cds-stat` / `.cds-crumb` utility class。
3. [x] ProjectListPage 切片：hero 表单收敛 + 项目卡极简化 + 工具入口折叠。
4. [x] BranchListPage / BranchDetailPage / BranchTopologyPage / ProjectSettingsPage / CdsSettingsPage 5 个页面全部套用 AppShell + TopBar + Workspace + Crumb；删除每页重复的自建 nav + breadcrumb；项目设置/系统设置 TabsList 与内容区改用 surface-raised + hairline。
5. [x] BranchListPage service-canvas 重组：引入 `selectedBranchId` + 自动选中策略（运行中 → 收藏 → 最近活跃）；左侧 320px 资源列表（跟踪 + 远程合并）；右侧主工作区显示选中分支的状态、服务、操作和日志；运维栏完整下沉为 `OpsDrawer` 右侧滑入抽屉，TopBar 「运维」按钮触发，Esc / 点遮罩关闭。
6. [x] BranchDetailPage 内容重组：6 个并列 DisclosurePanel 折叠为「日志（容器日志 + HTTP 转发日志）/ 配置（有效配置）/ 历史（最近提交）/ Bridge」4 个 tab；首屏只剩状态卡 + 服务卡 + 主操作 + 预览别名。
7. [x] ProjectSettingsPage + CdsSettingsPage 内容重组：TabsList 渲染 3 大类分组标题（接入 / 运行时 / 危险区或维护），把 7-8 并列 tab 重组成 3 大类。
8. [ ] BranchTopologyPage：React Flow 升级仍待用户确认。
9. [x] 全局视觉残留清理：所有页面 `rounded-md border border-border bg-card` / `bg-muted/{20,30,40}` 堆叠批量替换为 `cds-surface-raised cds-hairline` / `cds-surface-sunken cds-hairline`。按钮颜色权重审计留作后续。

完成 Week 4.6 后才进入：
- 用户确认是否升级简化拓扑为 React Flow（独立动作，不阻塞 Week 5）。
- 用户确认是否进入 Week 5 删除 `cds/web-legacy/`。
