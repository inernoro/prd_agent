# CDS Web 前端迁移计划与交接

> **类型**：plan（实施计划） | **状态**：Week 2-4 路由迁移完成，Week 4.5 功能差距收敛收口，**Week 4.6 视觉与主链路重构进行中（向 Railway 看齐）**
> **作者**：Claude (Opus 4.7) · **更新**：2026-04-29
> **下棒**：可委托其他 AI / 开发者按本文 Week 4.6 + Week 5 路线图继续

---

## 一、为什么做这件事（30 秒读懂）

CDS 当前前端是 12k 行 `app.js` + 7.5k 行 `style.css` 的原生 HTML/JS/CSS 项目，每个新弹窗都要重写一遍：portal、focus trap、ESC 键、`min-h-0`、白天暗色 fallback、emoji 渗漏、`var(--xxx, #fallback)` 兜底色、按钮图标比例。最近 3 个月用户在同一类问题上反复反馈 10+ 次。

**根因**：没有组件抽象层，所有视觉规则都靠 markdown 规则文档手动 enforce。规则越多 → 漏掉的越多 → 越反复调试。

**方案**：把 4 个 HTML 页面（`cds-settings` / `settings` / `project-list` / `index`）渐进式迁移到 React + Vite + TypeScript + Tailwind + shadcn/ui。新栈与 prd-admin 同栈，可复用知识与代码。**URL 永远干净**——每个页面用最直观的语义路径（`/cds-settings` / `/projects` / `/settings/:id`），不带任何过渡期前缀。

---

## 二、当前架构（基础设施 + 大重命名后的状态）

### 目录布局

```
cds/
├── src/                    # Express 后端
│   └── server.ts          # 路由 + installSpaFallback + MIGRATED_REACT_ROUTES
├── web/                   # ★ React 工程（Vite + TS + Tailwind + shadcn/ui）
│   ├── src/
│   │   ├── App.tsx        # BrowserRouter（无 basename）
│   │   ├── pages/HelloPage.tsx
│   │   ├── components/ui/ # shadcn 组件（Button / Card / Dialog ...）
│   │   └── lib/           # api / theme / utils
│   ├── package.json
│   ├── vite.config.ts     # base: '/', outDir: './dist'
│   └── dist/              # 构建产物（gitignored）
└── web-legacy/            # 老的原生 HTML/JS/CSS（逐页迁移完后整体删除）
    ├── index.html         # 分支/拓扑 legacy reference（React 已接管 /branches、/branch-list、/branch-panel、/branch-topology）
    ├── project-list.html  # 项目列表 legacy fallback/reference（React 已接管 /project-list）
    ├── settings.html      # 项目设置 legacy reference（React 已接管 /settings/:projectId 多数分区）
    └── ...
```

### URL 路由的三层结构

server.ts 的 `installSpaFallback()` 维护三层优先级，由高到低：

| 优先级 | 范围 | 谁负责 |
|------|------|------|
| 1 | `/api/**` | Express 后端路由（包括 `POST /api/factory-reset` 复活接口） |
| 2 | React 已迁移路由 + `/assets/**` | `cds/web/dist/` 静态服务，路由清单是 `MIGRATED_REACT_ROUTES`（目前 `['/hello', '/cds-settings', '/project-list', '/branches', '/branch-list', '/branch-panel', '/branch-topology', '/settings']`） |
| 3 | 老路径（`/`、`/settings.html` 等） | `cds/web-legacy/` 静态文件 + SPA fallback |

每迁移一个页面 = 在 `MIGRATED_REACT_ROUTES` 加一行 + 在 `cds/web/src/App.tsx` 加一个 `<Route>` + 通常会同步删一份 legacy 文件。每次合入互不影响，零 downtime。

### 边界保证

| 受保护对象 | 保证机制 |
|-----------|----------|
| `POST /api/factory-reset`（复活接口） | `/api/*` 永远在 React + legacy 之上，`server-integration.test.ts` 集成测试守卫 |
| 未迁移的老页面 | 路径不在 `MIGRATED_REACT_ROUTES` 时 100% 走 `cds/web-legacy/` |
| React 构建产物缺失 | `installSpaFallback` 检测 `dist/index.html` 不存在时 warn + 跳过，老页面继续 work |
| 回滚 | 单个迁移：`git revert` 一个 commit；整体：`git mv cds/web cds/web-react && git mv cds/web-legacy cds/web` |

### 已完成基础设施清单

- [x] Vite 5 + React 18 + TS 5.6 + Tailwind 3.4 + Radix UI primitives
- [x] 主题切换（dark / light）通过 `[data-theme]` 属性 + token 双写
- [x] API proxy（开发模式 `/api` → `localhost:9900`；生产同源）
- [x] HelloPage 4 项验证（Tailwind / 主题 / API / Dialog）
- [x] Express 三层路由（`/api/*` / React 已迁移 / legacy fallback）
- [x] 集成测试守卫迁移路由 + 复活接口不被 shadow
- [x] `exec_cds.sh build_web` 自动 SHA 缓存（HEAD 没动则跳过）
- [x] 大重命名：`cds/web/` = React 工程；`cds/web-legacy/` = 老前端；URL 无 `/v2` 前缀
- [x] 新初始化默认 `mongo-split`，fresh install 不再生成空 `default` 项目

---

## 三、Week 2-5 路线图（下棒执行）

### Week 2：迁移 `/cds-settings`（已完成）

**输入**：原 `cds/web-legacy/cds-settings.html` + `cds/web-legacy/cds-settings.js`，结构是 7 个 tab + 左侧 44px icon-nav

**目标**：
- [x] 新增 `cds/web/src/pages/CdsSettingsPage.tsx`
- [x] 新增 `cds/web/src/components/ui/tabs.tsx`（包装 `@radix-ui/react-tabs`）
- [x] 每个 tab 拆成独立组件 `src/pages/cds-settings/tabs/*Tab.tsx`
- [x] 路由：`/cds-settings`，加到 `src/App.tsx` + `MIGRATED_REACT_ROUTES`
- [x] API 调用全部走 `apiRequest()`，禁止裸 `fetch`
- [x] GitHub App 与 Device Flow 登录都在 React `/cds-settings#github` 管理
- [x] **删除 legacy**：`cds/web-legacy/cds-settings.html` + `cds-settings.js`

**验证**（按 `human-verify` 技能六步）：
1. dark / light 两个主题下，每个 tab 都没有暗色背景泄漏
2. 每个 tab 的「保存」按钮成功后 → 后端 GET 验证已生效
3. `pnpm build` 后 bundle 不超过 120 KB gzipped
4. 浏览器 console 零 warning（特别是 React hydration / proxy / CORS）
5. `/preview` 技能拿预览地址，让用户访问 `/cds-settings` 验收
6. 复活接口（系统设置 maintenance tab 的「恢复出厂」按钮）调用后 `POST /api/factory-reset` 仍可达

**预估工作量**：1.5 天

---

### Week 3：迁移 `settings.html` + `project-list.html`

**项目设置页**（`web-legacy/settings.html` 400 行 + `settings.js` 1973 行）：
- [x] 路由：`/settings/:projectId/*`（projectId 从 path 拿，禁止新代码继续使用 `?project=` query）
- [x] 兼容入口：`/settings.html?project=<id>` 重定向到 `/settings/<id>`
- [x] 复用 Week 2 的 `Tabs` 组件
- [x] 项目级 RESTful API：`GET /api/projects/:id/...` 全部已就位
- [x] 写一个 `useProject(id)` hook 集中拉项目元数据
- [x] 第一阶段迁基础信息、GitHub 绑定与事件策略、评论模板、缓存诊断、统计摘要、活动日志、危险区删除

**项目列表页**（`web-legacy/project-list.html` 1483 行 + `projects.js` 3046 行）：
- [x] 路由：`/project-list` 由 React 接管，保留干净 URL 和旧入口兼容
- [x] 卡片组件：`<ProjectCard>` 基础版，展示分支 / 运行服务 / 最近部署
- [x] 操作：创建 / 删除 / 进入 / 项目设置 / legacy default 迁移与残留清理
- [x] fresh install 空状态：0 项目，不再自动生成空 `default`
- [x] GitHub repo picker 迁入 React 新建项目 Dialog，复用 `/api/github/repos?page=N`
- [x] 新建项目简化：粘贴 Git 仓库 URL 即可自动推导项目名，减少首次接入仓库的手填步骤
- [x] clone progress 迁入 React Dialog，支持 POST `/api/projects/:id/clone` SSE 日志
- [x] clone 成功后后端自动 detect stack 并创建项目内默认 BuildProfile，前端只展示流式进度
- [x] GitHub clone URL 创建项目时自动绑定 `owner/repo`，第一次 webhook 回填 installation id
- [x] 项目级 Agent Key 管理迁入 React Dialog，签发/吊销都有确认流程
- [x] Agent pending import 审批迁入 React Dialog：`?pendingImport=<id>` 自动打开、预览 YAML、批准应用、拒绝留痕
- [x] 技能包下载入口迁入 React header，直连 `/api/export-skill`
- [x] 全局 Agent Key 管理迁入 React Dialog，签发/吊销都有确认流程，明文只显示一次
- [x] 首屏信息层级打磨：统计、技能包、全局 Key、Agent 记录、新建项目、Git URL 快速创建和项目行操作统一到 `/project-list` 控制台，不再分散成多个视觉层级

**预估工作量**：3 天

---

### Week 4：迁移 `index.html`（最大、最难）

**输入**：`web-legacy/index.html` 286 行 + `web-legacy/app.js` **13016 行** + 4 个独立 modal JS 文件

**结构拆分**：
- [x] 路由：`/branches/:projectId`，旧 `/branch-list?project=xxx` 由 React 兼容
- [x] `BranchListPage` 基础版（左 sidebar + 已跟踪分支 + 远程分支）
- [x] `BranchCard` 基础版（status / services / preview / deploy / pull / stop）
- [x] 远程分支一键预览：创建分支 → SSE 部署 → 按预览模式打开 URL
- [x] SSE 流处理：订阅 `/api/branches/stream?project=<id>`，跟踪 created/status/removed
- [x] `BranchDetailPage` 基础版：`/branch-panel/:branchId` 展示部署日志、容器日志、有效配置、最近提交
- [x] 单服务重部署、运行时诊断、强制干净重建（带确认）迁入 React 详情页
- [x] 分支级 BuildProfile override 常用字段编辑：命令、镜像、端口、路径前缀、恢复公共配置
- [x] 分支详情页预览别名、固定/恢复历史 commit、HTTP 转发日志
- [x] Bridge 会话控制和状态读取面板：激活、读取状态、结束；不暴露任意 click/type 命令入口
- [x] 删除 / 重置 / 收藏 / tag 编辑 / 调试标记等高频操作
- [x] 批量部署 / 拉取 / 停止 / 收藏 / 重置异常 / 删除、更密集的筛选/排序、紧凑模式
- [x] `TopologyView` 简化版：`/branch-topology?project=<id>` 展示应用服务、基础设施、分支运行状态、依赖和跳转入口
- 5 种弹窗 → 1 种 `<Dialog>`：
  - `settings-menu` → `<DropdownMenu>`（在 header 右上角）
  - `cds-user-popover` → `<Popover>`（点头像）
  - `config-modal` → `<Dialog>`（构建配置）
  - `topo-sys-popover` → `<Dialog>`（拓扑系统设置）
  - `agent-key-modal` → `<Dialog>`（已 Week 3 做掉）
- SSE 流处理：基础分支 stream 已接入；后续抽 `useEventSource(url)` hook 复用 `/api/proxy-log/stream`
- Bridge 操作面板：右下角 widget，调 `/api/bridge/command/:branchId`（端点见 `bridge-ops.md`）
- Activity Monitor：左上角面板，订阅 `/api/activity-stream`

**关键替换**：
- 全局 SSE EventSource 管理（`app.js` 里散落 4-5 处）→ 统一封装成 `useEventSource` + 自动断线重连 + `afterSeq` 续传
- 若后续把简化拓扑升级为 React Flow，配置必须遵守 `.claude/rules/gesture-unification.md`：`panOnScroll`, `zoomOnPinch`, `zoomActivationKeyCode=['Meta','Control']`, `zoomOnDoubleClick=false`

**预估工作量**：7-10 天（这是占总工作量 60% 的页面）

---

### Week 4.5：功能差距收敛（新增，删除 legacy 前必须完成）

当前不是“已经可以删旧代码”的状态。路由迁移基本完成，但 `web-legacy/app.js` 里仍有一批高密度运维能力值得借鉴。目标不是一比一复刻旧 UI，而是把核心链路需要的能力用 React 方式重新组织。

**总进度判断（2026-04-28）**：

| 维度 | 进度 | 说明 |
|------|------|------|
| 路由迁移 | 约 90% | `/cds-settings`、`/project-list`、`/settings/:projectId`、`/branches`、`/branch-panel`、`/branch-topology` 均已由 React 接管；根路径 `/` 仍保留 legacy fallback |
| 核心链路 | 约 89% | 创建项目、clone、detect/profile、远程分支一键预览、Agent import、技能包、Agent Key、环境变量、系统更新和认证状态入口已贯通；运行时默认存储不再静默落回 JSON |
| 分支页功能密度 | 约 77% | 基础操作、容量预警、主机健康、执行器操作和活动流筛选/详情已完成；分支页宽屏假双列已取消，拓扑详情已补日志/提交入口，更强部署失败建议仍需继续收敛 |
| legacy 删除准备 | 0% | 未经用户确认不得删除 `web-legacy/`，也不得删除旧 `app.js` 作为功能对照 |

**必须补齐或明确放弃的差距清单**：

**功能层级原则（2026-04-28 追加）**：

| 层级 | 应放位置 | 当前决策 |
|------|----------|----------|
| 主链路 | 页面标题区、右侧顶部、卡片首行动作 | 创建/粘贴分支、预览、详情、部署；任何会拖慢这条链路的功能都下沉 |
| 项目运维 | 分支页右侧面板或 `/cds-settings` 对应 tab | 容量、批量操作、集群/执行器、host stats、活动流 |
| 单分支低频操作 | 分支卡片“更多操作”或分支详情页 | 拉取、停止、收藏、调试标记、标签、错误重置、删除 |
| 深度诊断 | 分支详情页和拓扑节点详情 tab | 容器日志、构建日志、HTTP 日志、变量、路由、提交历史、runtime verify |
| 危险操作 | 独立危险区或确认弹窗 | 删除分支/项目、factory-reset、强制同步、清缓存；必须保留确认 |

本轮已按该原则调整 `/branches/:projectId`：首屏变成“分支控制台”，顶部直接承载粘贴分支预览入口，右侧栏从远程分支开始承接“一键预览”主链路，容量、主机健康、执行器、批量操作和活动流下沉到右侧运维区。分支卡片只保留预览/详情/部署，拉取/停止/标签/删除等低频操作收进“更多操作”。桌面布局从 `lg` 起固定右侧运维栏，分支卡片在该宽度保持单列，避免右栏和双列卡片互相挤压。

1. 分支列表运维密度
   - [x] 第一版层级调整：快速预览、容量状态、批量运维移到右侧上下文面板；单分支低频操作收进更多操作。
   - [x] 右侧顺序调整：快速预览 → 远程分支 → 运维状态 → 执行器 → 批量运维 → 最近活动，保证“点分支预览”不被运维信息压到下面。
   - [x] 快速预览：右侧顶部支持粘贴任意分支名创建、部署并打开预览。
   - [x] 容量预警第一版：部署前按预计新增容器数和容量槽做超限确认。
   - [x] 桌面信息架构：`lg` 宽度起固定右侧运维栏，分支卡片保持单列，`2xl` 才恢复双列卡片。
   - [x] 部署计时和失败摘要第一版：分支卡片展示动作耗时、最近 SSE 步骤；部署 SSE 成功结束但分支进入异常时，显示“部署失败”而不是误报“部署完成”。
   - [x] 分支卡片失败建议第一版：异常分支突出失败服务，直接给“看详情/日志”和“重置异常”入口，减少排错路径跳转成本。
   - [x] Activity Monitor 第一版：分支页右侧订阅 `/api/activity-stream`，展示最近 CDS/Web/API 事件，减少对 legacy 悬浮面板的依赖。
   - [x] 容量预警增强第一版：勾选分支后在右侧运维状态提前显示预计新增容器与剩余容量，容量不足时提示批量部署会二次确认。
   - [x] 集群/执行器入口第一版：右侧面板读取 `/api/executors/capacity` 与 `/api/cluster/status`，展示模式、在线节点、空闲容量和主执行器。
   - [x] 容量预警增强第二版：容量不足时可一键停止较旧运行分支腾出容量；批量部署仍保留二次确认。
   - [x] 集群/执行器入口增强第一版：分支页与 `/cds-settings#cluster` 补执行器排空/移除、节点详情和失败提示；破坏性动作必须确认。
   - [x] Activity Monitor 增强第一版：补 API/Web/AI 筛选和可复制请求摘要。
   - [x] Activity Monitor 增强第二版：补按具体分支筛选和内联详情面板，详情里展示 method/path/status/duration/source/branch/profile/body，避免排错时回到 legacy 悬浮面板。
   - [x] 分支页视觉层级打磨：顶部改为分支控制台，粘贴分支预览表单前置，远程分支成为右侧栏第一块，分支卡改为行式操作卡并复用统一 `MetricTile`。
   - [x] 分支页视觉第二轮：顶部合并为一键预览控制台，分支卡固定为“身份 / 指标 / 操作”三栏，预览主按钮在桌面窄宽下不再错位换行。
   - [x] 跨页“未完成品感”修正第一轮：移除全屏网格背景，取消分支页宽屏双列假响应式；项目页、分支页、分支详情、拓扑、项目设置和系统设置页改用居中工作区、统一深色表面和更完整的工具区层级。
   - [x] 分支页心智负担减负第一轮：默认只展示粘贴/选择分支、预览、部署、详情；筛选/排序/批量、容量、主机、执行器和活动流折叠到二级入口。
   - [x] 部署计时和内联日志增强：分支部署动作展示阶段、耗时、最近步骤、失败建议和可复制排错摘要；分支详情动作日志失败时也输出下一步建议。
2. 分支详情能力
   - [x] 失败诊断第一版：分支异常时在详情页首屏汇总失败服务、缺失配置和最近错误步骤；对 command/image/port 等明确配置错误提供直接修复入口。
   - [x] 运行时诊断摘要：`verify-runtime` 结果显示为可读摘要；容器不存在/未运行时后端直接返回明确错误，前端不再显示“诊断完成”的假成功。
   - [x] 提交历史体验：支持搜索提交，标记最新/当前/已固定；固定状态下最新提交提供“恢复最新”，当前提交不可重复固定。
   - [x] 单服务操作结果：动作日志区分运行中/完成/失败；运行时诊断和 force rebuild 结果可复制，force rebuild 部分失败会显示失败状态和下一步建议。
   - [x] HTTP 转发日志：详情页订阅 `/api/proxy-log/stream`，按当前分支实时追加；支持筛选、异常/慢请求摘要和 upstream/耗时/提示展示。
3. 拓扑页能力
   - [x] 保留简化拓扑为默认，应用服务节点详情补 `详情 / 分支 / 路由 / 变量` tab；不引入重型画布。
   - [x] 拓扑页视觉第一版：顶部补服务/基础设施/分支/视图/预览模式摘要，分支上下文独立成工具条，节点卡补状态图标、运行计数和密集元信息，详情面板默认选中首个节点并 sticky。
   - [x] 拓扑节点日志/提交入口第一版：右侧详情补 `日志 / 提交` tab；单分支视图读取 `/logs`、`/container-logs`、`/git-log`，日志可复制，提交固定/恢复仍跳分支详情页承接。
   - [x] 分支选择器支持搜索和共享视图/单分支视图切换；无匹配时给出“创建/部署分支”入口回到分支列表主链路。
   - [x] 拓扑页视觉第二版：分支选择同步 URL，新增当前视图状态条和预览/详情入口，服务节点补运行覆盖条，详情 tabs 在窄栏下保持规整。
   - [x] 拓扑页直接粘贴创建远程分支：`/branch-topology` 只提供轻入口，提交后跳回 `/branches/:projectId?preview=<branch>` 复用分支控制台的一键预览链路，避免另起一套部署流程。
   - [ ] 若升级 React Flow，再实现缩放/拖拽/fit/reset；否则保持当前低复杂度拓扑，不引入画布维护成本。
4. 系统级辅助入口
   - [x] settings-menu 中旧的 self-update / force-sync / factory-reset 迁到 `/cds-settings#maintenance`：支持源码分支选择、自更新预检、SSE 进度日志、更新重启和强制同步确认。
   - [x] `exec_cds.sh start/restart` 构建缓存兼容本地 dirty worktree：HEAD 相同但 `src/` 或 `web/src/` 等源码有未提交改动时必须重新构建，避免预览服务继续跑旧 dist。
   - [x] `exec_cds.sh init` 不再把 MongoDB 作为可选项；新初始化自动启用 `mongo-split`，Mongo 启动失败直接失败，不静默退回 JSON/state.json。
   - [x] CDS 真实运行时默认 `mongo-split`：未配置 `CDS_MONGO_URI` 会要求先跑 `./exec_cds.sh init`；仅 `NODE_ENV=test` 或显式 `CDS_STORAGE_MODE=json/auto` 保留 JSON 兼容入口。
   - [x] `/cds-settings#storage` 展示 mongo-split 目标状态、Mongo 健康、`.cds.env` 注入诊断，以及 `cds_projects / cds_branches / cds_global_state` 三个集合的运行时计数。
   - [x] `/cds-settings#global-vars` 与 `/settings/:projectId#env` 补齐环境变量编辑器：新增、编辑、删除、搜索、密钥遮蔽/显示/复制，并保留全局变量一键整理到项目的 dry-run 方案。
   - [x] 设置页 hash 同步修复：同一 React 页面内直接跳转 `#storage/#maintenance/#env` 时 tab 会跟随 URL 切换，不再出现 URL 变了但内容停在旧 tab。
   - [x] logout 入口：`/cds-settings#auth` 读取 `/api/auth/status`，basic/GitHub 模式显示明确退出按钮；disabled 模式显示本地开发状态。
   - [x] Host stats / capacity popover 第一版：分支页右侧与 `/cds-settings#cluster` 展示主机 CPU、内存、uptime 和执行器容量。
5. 验收前提
   - [ ] 每补一个 legacy 借鉴能力，都必须有浏览器验收和对应测试/文档更新。
   - [ ] 用户确认“React 版能力足够”之前，`web-legacy/` 只作为 reference 保留，不进入删除阶段。

### Week 4.6：视觉与主链路重构（向 Railway 看齐）

**为什么**：路由迁移已经达到 90%，但用户验收明确表态满意度只有 50%——"看起来大气，但实际比旧版臃肿、破碎、心智负担重"。继续往 Week 5 删 legacy 等于把"50% 满意度"定型。这一阶段的目标是把视觉语言、主链路聚焦度、信息层级一次性升级到 Railway/Linear 级别，再进入删除阶段。

**核心约束**：
- 所有改动局限在 `cds/web/src/`，`cds/web-legacy/` 一字不动，方便随时对比效果回滚。
- 主链路必须收敛到一句话：项目页 = "粘贴 Git URL → 进入项目"，分支页 = "选分支 → 预览 / 部署"。
- 任何"运维栏 / 批量操作 / 高级配置"默认折叠或下沉到二级页面，绝不在首屏占据视觉权重。
- 视觉权重统一：primary 强色仅给真正的主操作；其它一律 outline / ghost。
- 边框层级用 surface（base/raised/sunken）+ hairline token 替代 `bg-card border-border` 堆叠，消除"灰底灰边"破碎感。

**执行步骤**：

1. [x] 抽 `AppShell` + `TopBar` + `Workspace` + `Crumb` 组件，集中左侧 56px 导航条、顶部面包屑、居中工作区。所有页面只负责工作区内容，不再各自实现。
2. [x] 扩展 `index.css` 引入 surface 三档（base / raised / sunken）+ hairline 边框 token + `.cds-hero` / `.cds-stat` / `.cds-crumb` utility，作为新视觉语言的 SSOT。
3. [x] **ProjectListPage 切片**：使用 AppShell；TopBar 承载面包屑 + 内联统计 + 全局动作；首屏 hero 收敛为一行「粘贴 Git URL → 创建并克隆」；项目卡改为 Railway-style 极简卡（状态点 / 标题 / 仓库 / 内联指标 / 进入按钮 + 底部 ghost 工具栏）；自动化工具（技能包 / 全局 Key / Agent 申请）整体下沉到工作区底部折叠面板。
4. [x] **BranchListPage 套壳 + service-canvas 重组**：使用 AppShell + TopBar；首屏 hero 收敛为「粘贴分支名 → 预览」；引入 `selectedBranchId` 状态 + 自动选中策略；左侧 320px 资源列表（跟踪 + 远程合并）；右侧主工作区显示选中分支的状态、服务、操作和日志；新增 `OpsDrawer` 组件承载容量 / 主机 / 执行器 / 批量 / 活动流等低频运维，TopBar「运维」按钮触发右侧滑入面板；Esc / 点遮罩关闭。
5. [x] **BranchDetailPage 套壳 + 4 二级 tabs**：使用 AppShell + TopBar；6 个并列 DisclosurePanel 折叠为「日志 / 配置 / 历史 / Bridge」4 个 tab；首屏只剩状态卡 + 服务卡 + 主操作 + 预览别名。
6. [x] **ProjectSettingsPage + CdsSettingsPage 套壳**：使用 AppShell + TopBar；TabsList 与内容区改用 surface-raised + hairline。**剩余**：把 7+ tab 重组成 3 个语义组（接入 / 运行时 / 危险区）。
7. [x] **BranchTopologyPage 套壳**：使用 AppShell + TopBar + surface tokens；统计内联到 TopBar。React Flow 升级仍待用户确认。
8. [ ] **全局视觉残留清理**：grep 所有 `bg-card border-border` / `bg-muted/30 border-border` 堆叠，统一替换为 `cds-surface-raised cds-hairline` 等语义类；按钮颜色权重审计（primary 仅给主操作）。

**完成判定**：
- 用户在浏览器验收时不再说"大面积空白 / 像没 CSS / 破碎感 / 心智负担重"。
- 主链路用户操作步数：「打开 CDS → 粘贴仓库 URL → 进入项目 → 部署预览」≤ 4 次点击 / 1 次粘贴。
- 满意度 ≥ 80% 后才进入 Week 5。

---

### Week 5：清理 + 切流（用户确认后才执行）

进入 Week 5 的前置条件：

1. Week 4.5 差距清单完成，或每个未迁移项都有明确“放弃/推迟”记录。
2. 用户在聊天里明确确认可以删除旧代码。
3. 删除前最后一次运行并记录：`pnpm --prefix cds/web typecheck`、`pnpm --prefix cds/web build`、`pnpm --prefix cds build`、重点 Vitest、浏览器验收。

确认后才允许：

1. `MIGRATED_REACT_ROUTES` 长度等于全部业务路由，老 `/` redirect 改为直接 React `/`。
2. 删除 `cds/web-legacy/` 或先移动到 `cds/web-legacy-archive/` 做短期回滚缓冲，具体方式由用户确认。
3. server.ts 删除 legacy 静态 mount + SPA fallback 第二层。
4. 清理已经被 React/shadcn 兜住的旧 UI 规则。
5. 保留 `scope-naming.md`、`bridge-ops.md`、`cds-auto-deploy.md`、`quickstart-zero-friction.md` 等业务规则。

**新的总工时预估**：路由迁移已接近完成；功能差距收敛预计 2-4 天，Week 5 删除/切流预计 1-2 天。

---

## 四、迁移期间的硬约束

### 不能做的

- 不要给 `cds/web-legacy/*.js` 加新功能（只 bug fix）
- 不要再写 `.claude/rules/cds-*-token.md` 这种 UI 规则（直接在新栈里规范）
- 不要直接改 `cds/web-legacy/style.css`
- 不要触碰 `POST /api/factory-reset` 路由（复活接口）
- 不要在 `cds/web/` 用 `localStorage`（违反 `no-localstorage.md`）
- 不要在 `cds/web/` 用 emoji（违反根 `CLAUDE.md` §0）
- 不要在 `cds/web/` 写 `var(--xxx, #darkColor)` fallback（违反 `cds-theme-tokens.md`）
- 不要重新引入 `/v2/` 之类的 URL 前缀——干净 URL 是这个项目的核心承诺
- 不要删除 `cds/web-legacy/`、`web-legacy/app.js` 或旧页面文件，除非用户在当前对话里明确确认可以删除。当前旧代码是功能对照，不是垃圾文件。

### 必须做的

- 业务 API（`cds/src/`）继续按需迭代，**不动迁移**
- 新功能直接写在 `cds/web/src/`，**不要写**在 `cds/web-legacy/`
- 每周交付一个完整页面（独立 commit），出问题 `git revert` 零 downtime
- 每个 PR 必须包含：
  1. 新页面的所有源码
  2. 在 `MIGRATED_REACT_ROUTES` 加一行
  3. 路由契约测试；legacy 删除只在 Week 5 且用户确认后执行
  4. 至少一个 `cds/tests/` 集成测试覆盖核心路径
  5. `pnpm build` 后的 bundle size 报告（控制 < 500 KB gzipped）
  6. 在 dark + light 两主题下的截图（贴 PR 描述）
  7. `changelogs/` 碎片记录

---

## 五、关键决策记录

### 为什么是 React + Vite + Tailwind + shadcn/ui？

| 维度 | 老栈 | 新栈 |
|------|------|------|
| 主题切换 | 每组件手动写 `:root / [data-theme="light"]` | `dark:` 类 + tokens 一处定义 |
| 弹窗 | 5 种实现各踩一遍坑 | shadcn `<Dialog>` 一个组件全用 |
| 按钮图标比例 | 手动检查 ≥55% | cva `size-*` variants 自动 |
| 与 prd-admin 一致性 | 完全两套 | **同栈**，代码可复用 |
| 文件组织 | 12k 行单文件 | 每页一个 `.tsx`，每组件 100-200 行 |

shadcn/ui 是源码 copy 进项目（不是 npm 黑盒），自己改样式不需要 wrap 第三方组件。这点是选 shadcn 而不是 MUI / Ant Design 的决定性原因。

### 为什么用 `MIGRATED_REACT_ROUTES` 显式枚举，而不是 React 接管整个根路径？

如果 React 直接接管 `/`，未迁移的页面（`/project-list.html`、`/settings.html` 等）就需要 React 的 router 知道它们是"应该 fallback 到 legacy"的特殊路径——这把决策从服务器拉到了客户端，需要双向同步。

显式列表保留了「服务器是路由权威」的清晰边界：每迁移一个页面，加一行就接管；不在列表里的就走 legacy。Week 5 切流时，列表加上 `/` 等通配，legacy 整体退场。

### 为什么 `cds/web/` 是 React 而 `cds/web-legacy/` 是老前端，不是反过来？

「`cds/web/`」永远代表「当前的 web 应用」。半年后的开发者不需要记得"v2"是什么、"为什么有两个 web 目录"——他们只需要知道：默认在 `web/` 里写代码，`web-legacy/` 是临时存活的迁移过渡。Week 5 删除 `web-legacy/` 后只剩一个 `web/`，没有任何"versioned naming"残留。

### 为什么 React build 输出在 `cds/web/dist/`（Vite 默认）而不是 `cds/web-dist/`？

之前过渡阶段把 dist 放到外部目录是为了"单步回滚"。重命名到 `cds/web/` 后，回滚单位变成单个迁移 commit（`git revert`），dist 跟随 `web/` 走 Vite 默认布局最自然，`.gitignore` 的全局 `dist/` 通配自动覆盖。

---

## 六、给下棒 AI 的执行提示

1. **先读这些文件**（按顺序）：
   - 本文（路线图）
   - `cds/CLAUDE.md`（CDS 模块规则速查）
   - `.claude/rules/cds-theme-tokens.md`（颜色规则）
   - `.claude/rules/frontend-modal.md`（弹窗 3 硬约束）
   - `cds/web/src/pages/HelloPage.tsx`（参考实现）

2. **每页迁移的标准流程**：
   ```
   读老页 HTML+JS → 列 API 端点清单 → 拆组件树 → 写 React 版 →
   pnpm tsc --noEmit → pnpm build → 浏览器自测 dark+light →
   写测试 → /cds-deploy → /preview → /uat 真人验收 →
   把对应 web-legacy/ 文件删掉，加进 MIGRATED_REACT_ROUTES
   ```

3. **遇到不确定**：
   - shadcn 组件用法 → https://ui.shadcn.com/docs/components/{name}
   - Radix primitives → https://www.radix-ui.com/primitives/docs
   - Tailwind 类 → https://tailwindcss.com/docs

4. **禁止做的事情（再次强调）**：
   - 不动 `POST /api/factory-reset`（复活接口）
   - 不删 `cds/web-legacy/`（直到 Week 5 切流完成）
   - 不写 emoji
   - 不用 `localStorage`
   - 不写 `var(--x, #darkColor)` fallback
   - 不引入 `/v2/` 之类的 URL 前缀

5. **每完成一个页面，更新本文「Week X」 章节标记完成，并在「七、进度日志」追加一行**。

---

## 七、进度日志

| 日期 | Phase | 提交者 | commit | 备注 |
|------|-------|--------|--------|------|
| 2026-04-27 | 基础设施（Vite + React + Tailwind + HelloPage） | Claude (Opus 4.7) | 2017eb9 → PR #515 | 4 项验证全绿，860 tests pass，`/v2/*` 前缀挂载 |
| 2026-04-28 | 大重命名（`web/` ↔ `web-legacy/`，去 `/v2/`） | Claude (Opus 4.7) | 待填 | URL 永远干净，`MIGRATED_REACT_ROUTES` 显式枚举 |
| 2026-04-28 | `/cds-settings` React 迁移 | Codex | 本地未提交 | CDS 系统设置已接管，legacy `cds-settings.html/js` 删除 |
| 2026-04-28 | `/cds-settings#github` Device Flow | Codex | 本地未提交 | GitHub App 与 OAuth Device Flow 同页管理，保留设备码登录、状态显示和断开确认 |
| 2026-04-28 | Mongo split 默认化 + `/project-list` React 基础版 | Codex | 本地未提交 | fresh install 0 项目，不再显示空 `default`；项目列表由 React 接管 |
| 2026-04-28 | `/project-list` GitHub repo picker | Codex | 本地未提交 | 新建项目 Dialog 支持从 Device Flow 账号选择 GitHub 仓库，未连接时跳到 `/cds-settings#github` |
| 2026-04-28 | `/project-list` clone progress | Codex | 本地未提交 | 项目卡片支持开始/重新克隆，新建 Git 项目后自动打开流式 clone 进度 Dialog |
| 2026-04-28 | `/project-list` Agent Key | Codex | 本地未提交 | 项目卡片支持项目级 Agent Key 管理，签发明文只显示一次，吊销前弹窗确认 |
| 2026-04-28 | clone 后自动 profile | Codex | 本地未提交 | `POST /api/projects/:id/clone` 成功后后端执行 detect stack，并在可识别栈时创建默认 BuildProfile |
| 2026-04-28 | GitHub URL 自动绑定 | Codex | 本地未提交 | GitHub clone URL 创建项目时写入 `githubRepoFullName`，webhook 首次到达时回填 installation id |
| 2026-04-28 | 迁移运行手册 | Codex | 本地未提交 | 新增 `doc/guide.cds-web-migration-runbook.md` 固化命令、验收和下一步 |
| 2026-04-28 | `/settings/:projectId` React 基础版 | Codex | 本地未提交 | 基础信息保存、GitHub 绑定与事件策略、评论模板、统计摘要、活动日志已迁移；旧 `settings.html?project=<id>` 重定向到新路径 |
| 2026-04-28 | `/settings/:projectId` 缓存诊断 | Codex | 本地未提交 | 迁移 cacheMount 状态、修复、导出、导入和清空确认入口；无副作用验收只检查加载与控制台 |
| 2026-04-28 | `/settings/:projectId` 危险区 | Codex | 本地未提交 | 迁移项目删除危险区，legacy 项目保护，删除前必须弹窗确认 |
| 2026-04-28 | `/branches/:projectId` React 基础版 | Codex | 本地未提交 | 旧 `/branch-list?project=<id>` 兼容到 React；远程分支一键创建、部署并打开预览；详情入口指向 React `/branch-panel/:branchId`；收藏/tag/调试/重置/删除确认已迁移 |
| 2026-04-28 | `/branch-panel/:branchId` React 基础版 | Codex | 本地未提交 | 分支详情页迁移部署日志、容器日志、单服务重部署、运行时诊断、干净重建确认；旧 `/branch-panel?project=<id>` 进入 React 分支选择 |
| 2026-04-28 | legacy 拓扑保留入口 | Codex | 本地未提交 | `/branch-panel` 交给 React 详情页后，旧拓扑视图曾临时保留到 `/branch-topology?project=<id>`，后续已被 React 简化拓扑替代 |
| 2026-04-28 | `/branches/:projectId` 收尾 | Codex | 本地未提交 | 分支列表补搜索、状态快筛、排序、紧凑模式和批量部署/拉取/停止；保持远程分支一键预览主链路不变 |
| 2026-04-28 | `/branch-panel/:branchId` 运维能力 | Codex | 本地未提交 | 分支详情页补预览别名、固定/恢复历史 commit、当前分支 HTTP 转发日志；固定/恢复前弹确认 |
| 2026-04-28 | `/branch-panel/:branchId` profile override | Codex | 本地未提交 | 有效配置卡片支持覆写命令、镜像、端口、路径前缀，以及恢复公共 BuildProfile；保存后提示重新部署生效 |
| 2026-04-28 | `/branch-panel/:branchId` Bridge 面板 | Codex | 本地未提交 | 分支详情页补 Bridge 激活/结束、Widget 连接状态和页面状态读取；避免暴露危险遥控命令入口 |
| 2026-04-28 | `/branch-panel/:branchId` 失败诊断 | Codex | 本地未提交 | 分支异常时首屏展示失败诊断，明确缺失 command 等配置错误，并提供补命令、看日志、运行诊断和重部署入口 |
| 2026-04-28 | `/branch-panel/:branchId` 诊断收口 | Codex | 本地未提交 | 运行时诊断改为可读摘要；容器不存在或未运行时后端返回明确 400，前端显示失败状态而不是假成功；`exec_cds.sh` 构建缓存开始识别本地 dirty 源码 |
| 2026-04-28 | `/branch-panel/:branchId` 提交历史体验 | Codex | 本地未提交 | 最近提交卡片补搜索、最新/当前/已固定标识；固定状态下最新提交提供恢复入口，当前提交不可重复固定 |
| 2026-04-28 | `/branch-panel/:branchId` 单服务操作结果 | Codex | 本地未提交 | 动作日志区分运行中/完成/失败并支持复制；force rebuild 部分失败显示失败状态和重试/重部署建议 |
| 2026-04-28 | `/branch-panel/:branchId` HTTP 转发日志 | Codex | 本地未提交 | 详情页订阅 `/api/proxy-log/stream` 实时追加当前分支日志，支持筛选、异常/慢请求摘要和 upstream/耗时/提示展示 |
| 2026-04-28 | `/branch-topology` 节点详情 tab | Codex | 本地未提交 | 应用服务节点详情补 `详情 / 分支 / 路由 / 变量` tab，并加载项目路由规则用于展示服务相关入口 |
| 2026-04-28 | `/branch-topology` 分支选择器 | Codex | 本地未提交 | 拓扑页分支选择器补搜索；无匹配时提供“创建/部署分支”入口回分支列表，保留共享视图/单分支视图切换 |
| 2026-04-28 | `exec_cds.sh init` Mongo 默认化 | Codex | 本地未提交 | 初始化不再询问是否启用 MongoDB；自动创建/启动 `cds-state-mongo` 并写入 `mongo-split` 环境变量，失败时不退回 JSON |
| 2026-04-28 | `/project-list` pending import | Codex | 本地未提交 | Agent 提交的 CDS Compose 申请迁入 React；本地验证 `?pendingImport=<id>` 自动打开、YAML 预览、批准应用后 `pendingCount=0` |
| 2026-04-28 | `/project-list` 自动化入口 | Codex | 本地未提交 | React header 补技能包下载和 Agent 全局通行证管理；本地验证 `/api/export-skill` 附件头、全局 Key Dialog 和签发确认弹窗 |
| 2026-04-28 | `/branch-topology` React 简化拓扑 | Codex | 本地未提交 | 服务拓扑由 React 接管，展示应用服务、基础设施、分支运行状态、依赖和跳转入口；server-integration 更新为 React 契约 |
| 2026-04-28 | 系统更新 + 环境变量闭环 | Codex | 本地未提交 | `/cds-settings#maintenance` 补 self-update/force-sync 控制台；`#global-vars` 与 `/settings/:projectId#env` 补可编辑变量表；`#storage` 展示 mongo-split 集合计数 |
| 2026-04-28 | 分支运维栏 + 集群控制 | Codex | 本地未提交 | `/branches/:projectId` 补 host stats、容量腾挪、执行器排空/移除、Activity 筛选复制；`/cds-settings#cluster` 补连接码、加入/退出和节点操作；运行时默认存储改为 Mongo split |
| 2026-04-28 | 拓扑节点诊断入口 | Codex | 本地未提交 | `/branch-topology` 应用节点详情新增日志和提交 tab；单分支视图复用分支详情 API，可复制日志并跳详情页处理提交固定/恢复 |
| 2026-04-28 | 认证状态 + Activity 详情 | Codex | 本地未提交 | `/cds-settings#auth` 补统一认证状态和退出入口；`/branches/:projectId` 最近活动补分支筛选、详情面板和复制摘要 |
| 2026-04-28 | API label 噪音清理 | Codex | 本地未提交 | 补 host-stats、activity/state stream、cluster/executor、AI pairing、Bridge 等 API 的中文 label，减少启动日志和 Activity Monitor 空标签 |
| 2026-04-28 | 拓扑视觉第二轮 | Codex | 本地未提交 | `/branch-topology` 分支上下文同步 URL，补当前视图状态条、预览/详情入口、服务覆盖条和更规整的详情 tabs |
| 2026-04-28 | 新建项目减步骤 | Codex | 本地未提交 | `/project-list` 新建项目支持从 Git URL 自动推导项目名，粘贴仓库即可创建并进入 clone 流程 |
| 2026-04-28 | `/project-list` 首屏层级打磨 | Codex | 本地未提交 | 项目列表改为控制台式首屏；快速 Git URL 创建、安装技能包、全局 Key、Agent 记录与横向项目操作行完成浏览器验收 |
| 2026-04-28 | React 信息块组件统一 | Codex | 本地未提交 | 抽出 `MetricTile` 统一项目列表、项目设置统计、分支详情和集群设置里的小型统计块，减少局部重复组件 |
| 2026-04-28 | 分支失败建议 | Codex | 本地未提交 | `/branches/:projectId` 异常分支卡片新增失败服务提示、详情/日志入口和重置异常入口 |
| 2026-04-28 | `/branches/:projectId` 高频批量操作 | Codex | 本地未提交 | 收藏分支置顶，补批量收藏/取消收藏、批量重置异常、批量删除一次确认 |
| 2026-04-28 | `/branches/:projectId` 控制台视觉打磨 | Codex | 本地未提交 | 首屏改为分支控制台；粘贴分支预览表单前置，远程分支作为右侧栏第一块，分支卡改为行式操作卡并完成浏览器验收 |
| 2026-04-28 | `/branches/:projectId` 视觉第二轮 | Codex | 本地未提交 | 一键预览控制台和三栏分支卡完成浏览器验收；桌面窄宽下主操作按钮不再错位换行 |
| 2026-04-28 | 控制台宽屏一致性修正 | Codex | 本地未提交 | 项目页、分支页、分支详情、拓扑、项目设置和系统设置页改为居中工作区和统一深色表面；移除全屏网格背景，分支页移除单数据时造成半屏卡片的 `2xl` 双列布局 |
| 2026-04-28 | `/branches/:projectId` 默认视图减负 | Codex | 本地未提交 | 分支页默认只保留主链路；筛选/排序/批量和运维日志折叠，分支卡移除独立指标列，减少首次进入的心智负担 |
| 2026-04-28 | `/branch-panel/:branchId` 默认视图减负 | Codex | 本地未提交 | 分支详情默认只保留状态、服务和主操作；构建日志、容器日志、有效配置、Bridge、提交和转发日志折叠 |
| 2026-04-28 | `/branch-topology` 节点详情减负 | Codex | 本地未提交 | 应用服务节点不再默认暴露六个 tab；摘要和主操作前置，配置/分支/路由/变量/日志/提交统一进入折叠面板 |
| 2026-04-28 | `/cds-settings#maintenance` 维护页减负 | Codex | 本地未提交 | 默认聚焦更新预检和重启；SSE 日志、镜像外观和危险操作折叠，避免维护页首屏堆满低频功能 |
| 2026-04-28 | 折叠面板组件统一 | Codex | 本地未提交 | 新增共享 `DisclosurePanel`，分支详情、拓扑节点详情和维护页复用同一套折叠面板样式 |
| 2026-04-28 | `/project-list` 卡片化减负 | Codex | 本地未提交 | 顶部低频自动化工具折叠，项目列表由横向长行改成卡片网格，项目管理操作默认折叠 |
| 2026-04-28 | `branches.test` default 契约修正 | Codex | 本地未提交 | 分支 API 测试显式 seed legacy `default` 项目，避免测试继续依赖 fresh install 自动创建 default 的旧行为 |
| 2026-04-28 | Week 4.5 功能差距计划 | Codex | 本地未提交 | 删除 legacy 前新增功能对齐阶段：分支页/拓扑页先借鉴旧版容量、集群、活动流、变量、路由、日志等必要能力；旧代码删除必须等用户确认 |
| 2026-04-29 | 分支部署排错闭环 | Codex | 本地未提交 | `/branches/:projectId` 部署动作补阶段、失败建议和复制排错摘要；`/branch-panel/:branchId` 动作日志失败时给出可执行下一步 |
| 2026-04-29 | 拓扑页一键预览入口 | Codex | 本地未提交 | `/branch-topology` 补“粘贴分支并预览”轻入口，跳回 `/branches/:projectId?preview=<branch>` 复用已有创建/部署/打开预览链路 |
| 2026-04-29 | Week 4.6 启动 — AppShell + Surface tokens | Claude (Opus 4.7) | 待填 | 抽出 `AppShell / TopBar / Workspace / Crumb` 共享布局；扩展 `index.css` 引入 surface 三档（base/raised/sunken）+ hairline 边框 token，统一视觉语言 SSOT |
| 2026-04-29 | Week 4.6 — ProjectListPage 切片 | Claude (Opus 4.7) | 6ddee73 | 顶部 hero「粘贴 Git URL → 创建」收敛为唯一主操作；项目卡改 Railway-style 极简卡（状态点 + 标题 + 仓库 + 内联指标 + 进入按钮 + ghost 工具栏）；自动化工具（技能包 / 全局 Key / Agent 申请）下沉到底部折叠面板 |
| 2026-04-29 | Week 4.6 — 全部页面切到 AppShell | Claude (Opus 4.7) | d32f3d0 | BranchListPage / BranchDetailPage / BranchTopologyPage / ProjectSettingsPage / CdsSettingsPage 5 个页面全部使用统一的 AppShell + TopBar + Workspace + Crumb；删除每页重复的 56px nav + 自定义 breadcrumb + 主题切换按钮；项目设置/系统设置的 TabsList 与内容区改用 surface-raised + hairline 替代 bg-card/75 shadow-sm |
| 2026-04-29 | Week 4.6 — BranchListPage service-canvas 重组 | Claude (Opus 4.7) | 待填 | 引入 `selectedBranchId` 状态 + 自动选中（运行中 → 收藏 → 最近活跃）；左侧 320px 资源列表（跟踪 + 远程合并展示）；右侧主工作区显示选中分支的状态、服务、操作和日志；新增 `OpsDrawer` 组件承载容量 / 主机 / 执行器 / 批量 / 活动流等低频运维操作，TopBar 「运维」按钮触发右侧滑入面板；远程分支从 ops 抽屉挪到左侧资源列表，保持一键部署链路最短 |

---

## 八、相关文档

- `doc/rule.doc-naming.md` — doc/ 目录命名规则
- `doc/guide.cds-web-migration-runbook.md` — CDS Web 迁移命令、验收和防遗忘机制
- `cds/CLAUDE.md` — CDS 模块约束
- `.claude/rules/cds-theme-tokens.md` — 颜色 token 规则
- `.claude/rules/frontend-modal.md` — 弹窗 3 硬约束
- `.claude/rules/no-localstorage.md` — 禁用 localStorage
- `.claude/rules/zero-friction-input.md` — 输入零摩擦
- `.claude/rules/guided-exploration.md` — 引导性原则
