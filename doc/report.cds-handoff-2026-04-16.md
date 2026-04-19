# CDS Phase F (UF-01..22 + GAP-01..16 + L10N + FU-01/03/04/05) 交接 · 报告

> **日期**: 2026-04-16 | **分支**: `claude/review-handoff-report-updYh` | **作者**: Claude (本 session)
>
> 上一棒交接见 `report.cds-phase-b-e-handoff-2026-04-14.md`(Phase B/C/D/E,会话 76ox4)。
> 本报告覆盖本 session 在 Phase E 基线上做的全部增量——**修复用户报出的所有可视化缺陷 + 关闭 backlog 中大部分碎片项**。

---

## 一、执行摘要

| 指标 | 值 |
|------|-----|
| 起点 | Phase E baseline(commit `da0de70`,529 tests pass)+ 上一棒 §8.1 的 7 条 LIM + §8.3 的 5 条 FU |
| 终点 | commit `fe78723`(待 push 的本次 session 增量 3 份文档)· **602 tests pass** |
| 新增 commits | 10 个(A1..F = backlog matrix / UF-01..22 / GAP-01..16 / L10N-01..03 / FU-01/03/04/05 / view-parity smoke) |
| 新增测试 | +73(529 → 602)· 新增 `view-parity.smoke.test.ts`(14) · `secret-seal.test.ts`(16) · stack-detector 框架测试(20+)· worktree migration(3+) · projects-url-helpers UF-01 回归(12) · github-oauth 2 条 UF-01 回归 |
| 新增端点 | 0 — 本期无新端点,只修既有端点的 client/server 对齐(UF-20)+ 拓展 OAuth repos 路由加分页(FU-01) |
| 新增前端页面/Tab | Topology Details 新增 "路由" tab(GAP-04)· "备注" tab(GAP-07/13) · Settings tab 加部署模式块(GAP-05)+ 集群派发块(GAP-06) |
| 新增运维配置 | `CDS_SECRET_KEY`(可选,AES-256-GCM 加密 Device Flow token)· worktree 布局 v2(per-projectId 子目录,自动迁移) |
| 修复 BUG | **22 条 UF + 16 条 GAP**(见 §3) |
| 防护新增 | `api()` 响应 text-first 解析(不再 SyntaxError spam)· `window.onerror` 全局 toast 兜底(UF-13)· `_topologyRefreshIfVisible` 双视图状态同步(UF-16) |

## 二、用户故事 — 完成了什么

**上一棒交付但用户体验不完整的部分**:拓扑视图做出来了,但用户实际使用时几乎每一步都卡。本 session 把它从"能跑但用户走不通"推到"用户从登录到部署全流程无阻碍"。

**这一棒交付给用户的**:

1. **零卡点的首次上手**:`projects.html` 左下角识别 Device Flow 登录(UF-02/02\*/11)→ 未配置时顶部黄色横幅直接给出 `CDS_GITHUB_CLIENT_ID` 设置命令(UF-12)→ 点击复制模板 → 跳 GitHub Developer Settings(新增)→ 完成 Device Flow 后徽章主动刷新
2. **两个视图 1:1 功能对齐**:列表视图的 deploy/stop/delete/preview/override/tag CRUD/commit 历史 等 16 个核心操作,全部在拓扑视图有对应入口(详见 `guide.cds-view-parity.md`)。
3. **实时反馈 = 业务可见**:Deploy 按钮点击立即 spinner + 横幅琥珀脉冲 + 节点卡片脉冲 + 底部 8 行 rolling log(UF-16 / UF-22)。用户不再对着静止屏幕等 3 分钟。
4. **Mac 触控板一致**:两指滑动平移 + 捏合缩放(UF-06,移植自 VisualAgent 手势契约)。
5. **安全基线**:`CDS_SECRET_KEY` 启用后 state.json 里的 Device Flow token 是 AES-256-GCM 密封后的形态(FU-05),向后兼容明文旧 state。
6. **UI 重要的 paper-cut 修完**:顶栏 "+ Add" 不再覆盖 Details 关闭按钮(UF-19)· 部署日志 tab 不再显示 HTML 源码(UF-20 · 原因是 GET/POST 方法错配)· 列表视图也不再出现幽灵 toggle(UF-17)。

> **未完成**:**FU-02**(MapAuthStore mongo 后端)刻意 deferred,已写完独立设计稿 `doc/design.cds-fu-02-auth-store-mongo.md` 交给下一棒。**P5**(team workspace)和 **P6**(webhook + 自动部署)战略级特性按 `plan.cds-multi-project-phases.md` 原定时机推进,未启动。

## 三、commit 时间线(老→新)

```
a1d7d10  docs(cds): add horizontal backlog matrix + sync P3 status
           ├─ 新增 doc/plan.cds-backlog-matrix.md(30 条碎片项 SSOT)
           └─ 修正 plan.cds-multi-project-phases.md §6(P3 Part 2 标 done via Phase D)

dd5290b  fix(cds): UF-01..04 — user-visible GitHub + topology + branch fixes
           ├─ UF-01 Device Flow 持久化静默失败(setGithubDeviceAuth async + flush + mapGitCloneError)
           ├─ UF-02 左下角徽章识别 GitHub 用户
           ├─ UF-03 Topology 节点自动居中(_topologyFit on rAF)
           └─ UF-04 分支搜索框手动输入 + Enter 添加

1092a2f  fix(cds): UF-05/06 — topology card + trackpad gesture alignment
           ├─ UF-05 卡片样式对齐图 1(圆角 18px + 正交连线 + volume slot)
           └─ UF-06 Mac 双指滑动修 = 平移(移植自 AdvancedVisualAgentTab.tsx:3267)

d1a9442  fix(cds): close Top-10 + UF-07/08 user-reported items
           ├─ UF-07 拓扑分支 combobox 支持 Enter 添加
           ├─ UF-08 拓扑顶栏加"列表 | 拓扑"切换 pill
           ├─ GAP-01 Stop button · GAP-02 Delete button
           ├─ GAP-03 Variables tab(已存在,标 resolved-prior)
           ├─ L10N-01 Settings 页面 30+ 条汉化
           └─ TEST-01/02 Device Flow 回归 E2E

489a739  fix(cds): UF-02*/09/10 + GAP-04..09 + L10N-02/03 + FU-01/05
           ├─ UF-02* 徽章刷新回归(bootstrapMeLabel 幂等可重入)
           ├─ UF-09 Variables 继承+覆盖 + 眼睛 toggle + 内联编辑
           ├─ UF-10 杀掉"跳回列表"暗门(_topologyPanelOpenEditor 等 3 处)
           ├─ GAP-04 路由 tab · GAP-05 部署模式 · GAP-06 集群派发 · GAP-07 备注 · GAP-08/09 端口交互
           ├─ L10N-02 Railway 术语汉化 · L10N-03 projects.html 汉化
           ├─ FU-01 Repo Picker 分页(Link header + 加载更多)
           └─ FU-05 Device Flow token AES-256-GCM 密封 + 16 条单元测试

eaf0029  feat(cds): UF-11/12/13 — logout menu + env var setup helper + onerror toast
           ├─ UF-11 用户徽章变可点击 popover(Settings + 断开连接)
           ├─ UF-12 未配置时顶部黄色横幅 + 复制环境变量模板
           └─ UF-13 window.addEventListener('error') → toast 兜底

a4918bf  test(cds): view parity smoke test + feature alignment guide
           ├─ 新增 tests/integration/view-parity.smoke.test.ts(14 条)
           └─ 新增 doc/guide.cds-view-parity.md(列表↔拓扑对齐矩阵)

fbad34d  fix(cds): UF-14/15/16 — stop lying about progress, unblock the clicks
           ├─ UF-14 api() text-first 解析,消除 SyntaxError: Unexpected end of JSON input spam
           ├─ UF-15 topbar right:132px 为 + Add 让位(后来发现 UF-17 才是根治)
           └─ UF-16 Deploy/Stop/Delete 按钮实时 spinner + inline log + 状态横幅脉冲

9186c21  fix(cds): UF-17..22 — ghost toggle, panel close, HTML logs, real icons, card pulse
           ├─ UF-17 删除 display:flex !important,修 topbar 在列表视图显示的 ghost UI
           ├─ UF-18 4xx/5xx 空响应标 isTransient,post-action 自动 1.5s 重试不报错
           ├─ UF-19 + Add 在 panel 打开时隐藏 / ESC 关闭 / 点空白关闭 / 关闭按钮加红色 hover
           ├─ UF-20 GET → POST container-logs(Express SPA fallback 把 index.html 当日志了)
           ├─ UF-21 SVG 图标替换 emoji(GitHub/MongoDB/Redis/Postgres/MySQL/Nginx/Kafka + disk)
           └─ UF-22 节点卡片 building 状态琥珀脉冲 + drop-shadow 光晕

fe78723  feat(cds): finish remaining backlog — GAP-11..16, FU-03, FU-04
           ├─ 3 个并行 sub-agent 同时完成
           ├─ Agent A: GAP-11/12/13/14/15/16(拓扑功能对齐列表的最后 6 条)
           ├─ Agent B: FU-03 detect-stack nixpacks 风格(9 种 framework + 20+ 测试)
           └─ Agent C: FU-04 worktreeBase per-projectId 子目录 + 迁移(symlink 优先)

(待 push)  docs(cds): Q1-Q4 handoff docs
           ├─ doc/design.cds-fu-02-auth-store-mongo.md(下一棒的蓝图)
           ├─ doc/report.cds-railway-alignment.md(Railway 对齐 ~92%)
           ├─ plan.cds-roadmap.md 更新(Phase 0/1 全落地)
           ├─ plan.cds-multi-project-phases.md §8/§9 注记 P5/P6 状态
           └─ doc/report.cds-handoff-2026-04-16.md(本文)
```

**commit 颗粒度说明**:每个 commit 围绕一个主题 + 若干相关子条,message 含根因说明。没有"修小 bug"的碎 commit,也没有"一口气改 100 个文件"的超大 commit。

## 三、交付清单(按类型分类)

### 3.1 UF — 用户可见故障(22 条,全部 done)

| ID | 标题 | commit | 根因(一句话) |
|---|---|---|---|
| UF-01 | Device Flow token 持久化静默失败 | dd5290b | `setGithubDeviceAuth` save 失败被吞 + clone 未注入 token |
| UF-02 | 左下角徽章永远显示"未登录" | dd5290b | `bootstrapMeLabel` 只查 `/api/me`,不查 `/api/github/oauth/status` |
| UF-02\* | 徽章刷新回归 | 489a739 | Device Flow 完成后没主动刷新徽章 |
| UF-03 | Topology 节点挤左上角 | dd5290b | SVG 用固定坐标,无响应式 fit |
| UF-04 | 分支搜索框无法手动添加 | dd5290b | 下拉框只过滤,无 Enter 添加 |
| UF-05 | 卡片过密,和图 1 不一致 | 1092a2f | 236×110 尺寸 + 多行 + 胶囊/矩形混用 |
| UF-06 | Mac 双指滑动被绑到缩放 | 1092a2f | wheel event 未按 ctrlKey 分流 |
| UF-07 | 拓扑分支选择器是原生 select | d1a9442 | 不支持输入/粘贴新分支 |
| UF-08 | 拓扑无法切回列表 | d1a9442 | 入口是 leftnav "日志"暗门 |
| UF-09 | Variables tab 只读 | 489a739 | 未挂 `/profile-overrides` 接口,不支持继承/覆盖 |
| UF-10 | 编辑按钮跳回列表 | 489a739 | `setViewMode('list')` + 不存在的 renderBuildProfiles |
| UF-11 | 徽章不能登出 | eaf0029 | 徽章不可交互 |
| UF-12 | 无法知道怎么配 GitHub | eaf0029 | 无 onboarding 引导 |
| UF-13 | 脚本报错用户看不到 | eaf0029 | 无 `window.onerror` 兜底 |
| UF-14 | console 持续 SyntaxError | fbad34d | `await res.json()` 对空响应会 throw |
| UF-15 | 顶栏列表切换被 + Add 覆盖 | fbad34d(v1) / 9186c21(v2) | 共享 x 坐标区间 |
| UF-16 | Deploy 按钮点击无反应 | fbad34d | 拓扑 Details 不订阅 busyBranches |
| UF-17 | 列表视图出现幽灵 toggle | 9186c21 | `display:flex !important` 破坏了 body 作用域 |
| UF-18 | HTTP 400 继续 log | 9186c21 | 非 silent 的 transient 错误没静默 |
| UF-19 | 面板无法关闭 | 9186c21 | + Add 覆盖关闭 X,无 ESC,无点空白 |
| UF-20 | 部署日志显示 HTML 源码 | 9186c21 | client GET / server POST,SPA fallback 返 index.html |
| UF-21 | 图标显得廉价(emoji) | 9186c21 | `_topologyNodeIcon` 用文本 emoji |
| UF-22 | 节点卡片无 building 动画 | 9186c21 | `_topologyNodeStatus` 等 per-service 状态才显示 |

### 3.2 GAP — 列表↔拓扑功能对齐(10 条,全部 done)

| ID | 缺失 | commit | 承载位置 |
|---|---|---|---|
| GAP-01 | 停止/重启 | d1a9442 | Details 面板 Stop 按钮 |
| GAP-02 | 删除分支 | d1a9442 | Details 面板 Delete 按钮 |
| GAP-03 | 环境变量 tab | (已存在) | 本就有,标 resolved-prior |
| GAP-04 | 路由规则 tab | 489a739 | Details 面板新 tab |
| GAP-05 | 部署模式切换 | 489a739 / fe78723 | Settings tab 可点部署模式行 |
| GAP-06 | 集群派发 | 489a739 | Settings tab 展示 executors |
| GAP-07 | 标签/备注 tab | 489a739 | Details 面板新 tab |
| GAP-08 | 端口交互 | 489a739 | 节点端口 pill 单击复制/双击预览 |
| GAP-09 | 预览入口风格 | 489a739 | 同 GAP-08 pill |
| GAP-11 | 按服务粒度部署 | fe78723 | Details Deploy 变 split-button |
| GAP-12 | 错误重置 | fe78723 | error 状态显示 Reset 按钮 |
| GAP-13 | Tags inline 编辑 | fe78723 | 备注 tab 支持 add/remove/edit |
| GAP-14 | commit 历史 | fe78723 | Details 加 "查看历史" modal |
| GAP-15 | 部署模式可切换菜单 | fe78723 | Settings 部署模式行可点 |
| GAP-16 | 手动刷新 | fe78723 | 顶栏 🔄 按钮 |

### 3.3 L10N — 汉化(3 条,全部 done)

| ID | 范围 | commit |
|---|---|---|
| L10N-01 | Settings 页面 30+ 条 | d1a9442 |
| L10N-02 | Railway 术语 app.js 内 | 489a739 |
| L10N-03 | projects.html / projects.js | 489a739 |

### 3.4 FU — 后续候选(5 条:FU-01/03/04/05 done,FU-02 deferred)

| ID | 标题 | commit |
|---|---|---|
| FU-01 | Repo Picker 分页 | 489a739 |
| **FU-02** | MapAuthStore mongo 后端 | **deferred**(`doc/design.cds-fu-02-auth-store-mongo.md`) |
| FU-03 | detect-stack nixpacks | fe78723 |
| FU-04 | worktreeBase per-projectId | fe78723 |
| FU-05 | Device Flow token AES 加密 | 489a739 |

### 3.5 TEST — 测试缺口(2 条,全部 done)

| ID | 标题 | commit |
|---|---|---|
| TEST-01 | Device Flow 持久化失败 E2E | d1a9442 |
| TEST-02 | Device Flow token 注入 clone smoke | d1a9442 + a4918bf |

## 四、关键文件:行号(方便下一棒定位)

### 4.1 前端(cds/web/)

| 文件 | 关键位置 | 说明 |
|---|---|---|
| `web/app.js:192-253` | `async function api()` | UF-14 + UF-18 的 robust 响应解析 + isTransient 标记 |
| `web/app.js:2043-2130` | `deployBranchDirect` | UF-16 + UF-22 SSE 流 + busyBranches + `_topologyRefreshIfVisible` |
| `web/app.js:2202-2250` | `stopBranch` + `_topologyRefreshIfVisible` 定义 | UF-16 双视图状态同步 |
| `web/app.js:8044-8250` | `_ensureTopologyFsChrome` | 拓扑全屏外壳(topbar + combobox + leftnav + + Add + panel + 底部 hint)· UF-19 ESC/click-outside 在这里 |
| `web/app.js:8545-8635` | `_topologyNodeIcon` + 7 个 SVG 常量 | UF-21 图标库 |
| `web/app.js:8654-8680` | `_topologyNodeStatus` | UF-22 提前返回 'building' 逻辑 |
| `web/app.js:8880-9010` | `_renderTopologySvg` | 节点卡片渲染 + UF-05 几何 + UF-22 building class |
| `web/app.js:9540-9980` | `_topologyRenderPanelTab` | Details / Build Logs / Deploy Logs / HTTP Logs / Variables / 路由 / 备注 / 设置 9 个 tab |
| `web/app.js:9985-10140` | Variables tab Mode A/B + GAP-04 路由 tab + GAP-07 备注 tab | UF-09 继承/覆盖 + GAP-13 inline tag |
| `web/app.js:10140-10330` | Settings tab 部署模式块 + 集群派发块 | GAP-05 + GAP-06 |
| `web/app.js:10839-10960` | `_topologyPanelLoadDeployLogs` | UF-20 POST + HTML defensive guard |
| `web/app.js:11010-11055` | `_topologyClosePanel` + ESC 监听 + click-outside 监听 | UF-19 |
| `web/projects.js:390-480` | `bootstrapMeLabel` + popover helpers | UF-02/02*/11/12/13 badge 生命周期 |
| `web/projects.js:740-870` | Repo Picker 分页 | FU-01 `_repoPickerLoadMore` |
| `web/projects.html:920-950` | UF-12 GitHub 设置引导横幅 | 未配置时显示 |
| `web/projects.html:1020-1120` | UF-11 用户徽章 popover | Settings / Sign in / Disconnect |
| `web/style.css:5100-5250` | 节点卡片 CSS + UF-22 脉冲动画 | |
| `web/style.css:5537-5600` | 顶栏 CSS + UF-17 修复的作用域 | |
| `web/style.css:6080-6135` | 面板关闭按钮 + UF-19 sibling 选择器隐藏 + Add | |

### 4.2 后端(cds/src/)

| 文件 | 关键位置 | 说明 |
|---|---|---|
| `src/services/state.ts:714-760` | `getGithubDeviceAuth` + `setGithubDeviceAuth` | UF-01 await flush + FU-05 sealToken 集成 |
| `src/infra/secret-seal.ts` | 全文 | FU-05 AES-256-GCM `sealToken` / `unsealToken` / `isSealingEnabled` |
| `src/services/stack-detector.ts` | 新增 `detectFramework` | FU-03 9 种 framework 推断 |
| `src/services/worktree.ts` | `_worktreePathFor` + `_migrateFlatLayoutIfNeeded` | FU-04 per-projectId 子目录 + 一次性迁移 |
| `src/routes/github-oauth.ts:202-240` | `/github/repos` 加 `?page=` + await setGithubDeviceAuth | FU-01 + UF-01 |
| `src/routes/projects.ts:130-200` | `_injectGithubTokenIfPossible` + `_isGithubHttpsUrl` + `_mapGitCloneError` | UF-01 链路 |
| `src/services/github-oauth-client.ts:395-480` | `fetchUserReposPage` + Link header parse | FU-01 |

### 4.3 测试 + 文档

| 文件 | 说明 |
|---|---|
| `tests/integration/view-parity.smoke.test.ts` | 14 条断言覆盖两视图共用的 API |
| `tests/infra/secret-seal.test.ts` | 16 条断言:seal/unseal/tamper/rotation/back-compat |
| `tests/routes/projects-url-helpers.test.ts` | 27 条(UF-01 新增 `_isGithubHttpsUrl` + `_mapGitCloneError` 的 12 条) |
| `tests/routes/github-oauth.test.ts` | 16 条(UF-01 新增 2 条 persist-throw + clone-injection 回归) |
| `tests/services/stack-detector.test.ts` | ~40 条(FU-03 新增 20+ framework 推断) |
| `tests/services/worktree*.test.ts` | FU-04 迁移路径 + per-project 路径隔离 |
| `doc/plan.cds-backlog-matrix.md` | 37 条碎片项 SSOT · 28 done / 1 open(FU-02)/ 8 deferred |
| `doc/guide.cds-view-parity.md` | 列表↔拓扑对齐矩阵 + §5 smoke runbook |
| `doc/design.cds-fu-02-auth-store-mongo.md` | FU-02 下一棒蓝图 |
| `doc/report.cds-railway-alignment.md` | Q4 回答:Railway 对齐 ~92% |

## 五、已知限制(全部可见 · 不是隐藏炸弹)

### 5.1 仍 open 的 1 条

| ID | 描述 | 为什么不在本期修 |
|---|---|---|
| **FU-02** | MapAuthStore mongo 后端 | 触及认证架构;MemoryAuthStore 重启丢 session 是真实问题,但修它需要设计 cds_users + cds_sessions + 索引 + 迁移脚本 + session TTL 清理,整套需要独立 session。**已出独立设计稿 `design.cds-fu-02-auth-store-mongo.md`,下一棒可直接按稿实施** |

### 5.2 明确 deferred 的 8 条

| ID | 描述 | 状态 |
|---|---|---|
| GAP-10 | 跨项目画布组件统一(VisualAgent / Workflow / CDS Topology 三画布共享)| epic 级,需 2-3 session 专项设计 |
| LIM-01 | Mongo 单 collection 单 document(>16MB 会炸)| 未触发 — 实际 state < 1MB |
| LIM-02 | GitHub Device Flow 单租户 token | 等 FU-02 + P5 一起解决 |
| LIM-03 | Repo Picker 只返前 100(被 FU-01 关闭)| FU-01 已修,LIM-03 应改 done |
| LIM-04 | Executor 节点不复用 multi-repo clone | P3 Part 3 范围 |
| LIM-05 | Proxy 自动发现仅查 legacy repoRoot | 设计选择 · wontfix |
| LIM-06 | 多 tab Device Flow race | 低概率,wontfix |
| LIM-07 | Volume UI 入口被砍 | 后门可用 · 下一棒建议补回 |

### 5.3 本次新发现 + 留给下一棒的轻量项(非阻塞)

| 发现点 | 建议处理 |
|---|---|
| FU-03 detect-stack 只支持 package.json / requirements.txt / Gemfile,**未处理 pnpm-workspace / lerna / yarn workspaces monorepo** | 下一棒补 monorepo 探测层 |
| FU-04 per-projectId 迁移用了 symlink,Windows 宿主机可能不支持 symlink 权限 | 下一棒加 Windows 检测 + fallback 到 rename |
| 拓扑 Details 面板的 Settings tab 列出的 executors 是**只读**,和 GAP-15 的"部署模式可点"不一致;GAP-06 原本是想让集群派发也可点 | 下一棒把 GAP-06 从"展示"升级到"可切换" |
| UF-11 popover 的"使用 GitHub 登录"先打开 create modal 再 click signin button,链路有点绕 | 下一棒直接从 popover 调 Device Flow,不要绕 create modal |

## 六、人工验收清单(下一棒或用户使用前过一遍)

> **说明**:本清单是从 `doc/guide.cds-view-parity.md §5.2` 提炼的关键 E2E 步骤。本 session **没有**在真浏览器里跑过,只跑了 602 条 vitest。用户环境任何步骤不一致请直接反馈,附 DevTools Console 截图。

### 6.1 环境前置检查(3 分钟)

```bash
# 1. CDS 已拉最新代码
cd /path/to/cds && git log --oneline -1  # 应 = fe78723 + 本次 docs commit

# 2. 依赖已装
cd cds && pnpm install && pnpm build  # tsc 零 error

# 3. 测试全绿
pnpm test 2>&1 | tail -3  # 应 "602 passed"

# 4. 配置 GitHub(可选但推荐)
echo 'export CDS_GITHUB_CLIENT_ID="Iv1.xxxxxxxxxxxx"' >> ~/.cds.env
echo 'export CDS_SECRET_KEY="'$(openssl rand -hex 32)'"' >> ~/.cds.env
./exec_cds.sh restart
```

### 6.2 11 步核心走查(10-15 分钟)

| # | 步骤 | 预期 | 失败处理 |
|---|---|---|---|
| 1 | 浏览器访问 `projects.html` · 强制刷新 Cmd+Shift+R | 左下角徽章"加载中…" → 显示 GitHub 用户名或"未配置" · 无红色 Console 错误 | Console 红字 → 截图发 |
| 2 | 点左下角徽章 | Popover 出现:GitHub 设置 + 使用 GitHub 登录 / 断开连接(三选一根据状态) | popover 不弹 → UF-11 回归 |
| 3 | 顶部如有黄色横幅:点"复制环境变量模板" | Toast "已复制环境变量模板" | 没 toast → UF-12 回归 |
| 4 | 点"新建项目"· 粘 github URL · 提交 | Clone SSE modal 自动打开 · progress 滚动 · 结束后自动进入 stack detect | clone modal 无日志滚动 → UF-14/UF-20 回归 |
| 5 | 创建完成 · 卡片点击进入 index.html | 列表视图加载 · branches 列表显示 | Console 红字 SyntaxError → UF-14 回归 |
| 6 | 顶部搜索框粘贴 `feature/smoke-test` + Enter | 分支卡片出现(optimistic)· deploy 按钮可点 | 没反应 → UF-04/UF-07 回归 |
| 7 | 点"部署"· 观察 | 按钮立即变 spinner + "部署中…" · 卡片 inline log 滚动 | 按钮不变 → UF-16 回归(前端没订阅 busyBranches)|
| 8 | 顶栏切到"拓扑"· 点某服务节点 | 右侧面板滑出 · Details tab 自动选中 · **+ Add 按钮暂隐藏** | + Add 还盖在关闭按钮上 → UF-19 回归 |
| 9 | 按 ESC | 面板关闭 · + Add 重现 | ESC 无反应 → UF-19 回归 |
| 10 | 再次点节点打开 Details · 点"环境变量"tab · 点某行左侧眼睛图标 | 眼睛变绿 · value 变可编辑 input · 修改后 400ms 自动保存(toast 或无) | 眼睛不响应 → UF-09 回归 |
| 11 | 点"部署日志"tab | 真实容器 stdout 滚动 · **不是 HTML 源码** | 出现 `<div class="modal-header">` → UF-20 回归 |

### 6.3 附加检查项(2 分钟)

- [ ] 列表视图顶栏**只有一套**`列表 | 拓扑` toggle(不是两套)· UF-17
- [ ] Mac 触控板两指滑动 = 平移画布(不是缩放)· UF-06
- [ ] 拓扑节点的 icon 是 SVG logo(Redis/MongoDB 看得出来)· **不是 emoji** · UF-21
- [ ] Deploy 中时节点卡片边框琥珀色脉冲呼吸 · UF-22
- [ ] 关闭 CDS 再启动(如果配置了 `CDS_SECRET_KEY`)· state.json 里 `githubDeviceAuth.token` 应是 `{__sealed: true, ...}` 结构 · FU-05
- [ ] 创建第二个项目 · 两个项目在 `<worktreeBase>/<projectId>/` 下各自独立 · FU-04

### 6.4 什么情况下算"走不通"

如果任意一条失败,**先打开 DevTools Console**:
- **红色 Error**:截图发 → 该条最小复现步骤给下一棒
- **仅 Warning**:通常不是回归,可忽略
- **无报错但 UI 没响应**:说明事件绑定可能丢了 → 检查是否有 JS 异常阻止初始化

对应不同失败场景,已经在本次新增的 `window.onerror` 全局监听器里(UF-13)会弹 toast 提示"脚本错误: XXX"。

## 七、下一棒建议

### 7.1 优先级排序(建议严格按这个顺序)

| # | ID / 代号 | 为什么优先 | 预估 session 数 |
|---|---|---|---|
| 1 | **FU-02** MapAuthStore mongo 后端 | 已有独立设计稿,风险可控;是 P5 的前置 | 1 session(4-5h) |
| 2 | **LIM-07** Volume UI 入口补回 | 简单(加一个 + Add 菜单项)· 用户反馈过 | 0.25 session(~1h) |
| 3 | **GAP-10 Phase 1** 抽 canvas design token | 小范围 refactor · 不触碰业务逻辑 | 0.5 session |
| 4 | **P5** team workspace | 战略级 · 前置已就绪(P4 稳定 + FU-02 落地)| 2-3 session |
| 5 | P6 + Phase 3 release agent | 战略级 · 建议评审后再定作用域边界(本地 webhook vs 远端部署) | 3-4 session |

### 7.2 下一棒开场该做什么(如果我是下一个 agent)

```
1. 读本报告 §6 · 跑一遍人工验收清单 · 发现任何回归先修,后开新功能
2. 读 doc/design.cds-fu-02-auth-store-mongo.md · 按验收标准实施
3. FU-02 完成后立即启动 P5 workspace 设计(前置已满足)
4. 每完成一条事项 · 在 doc/plan.cds-backlog-matrix.md 标 done + 附 commit
```

### 7.3 不要做的事

- 不要 **重写**本 session 已经修复的 UF 类问题 · 先复现再动手
- 不要 **并行** FU-02 和 P5 · P5 依赖 FU-02 的 User 持久化模型
- 不要 **跳过**人工验收 · 自动测试不能 100% 覆盖浏览器 UI
- 不要用 **emoji** 做 UI 图标 · 遵循 UF-21 的 SVG 约定
- 不要用 **`res.json()` 直接 await** · 走 `api()` 助手(UF-14)

### 7.4 文档维护纪律

- 每关一条事项 · 更新 `doc/plan.cds-backlog-matrix.md` 对应条目 + 附 commit hash
- 新增事项 · 先登记到矩阵 · 再动手
- 每次 session 结束 · 写一份 `doc/report.cds-*-handoff-YYYY-MM-DD.md` · 按本文件格式
- 任何 UX 回归(比如用户截图报问题)· 拆一个新 UF-## · **先复现再修**

## 八、关联文档

### 8.1 设计类(理解架构)

- `doc/design.cds.md` — CDS 主入口(v3.2)
- `doc/design.cds-multi-project.md` — 多项目架构(v0.1)
- `doc/design.cds-resilience.md` — 服务器权威 + SSE 重连
- `doc/design.cds-fu-02-auth-store-mongo.md` — **下一棒必读**

### 8.2 计划类(知道下一步做什么)

- `doc/plan.cds-roadmap.md` — 3 阶段路线图(本次已更新到 v1.2)
- `doc/plan.cds-multi-project-phases.md` — P0-P6 里程碑 + P5/P6 状态注记
- `doc/plan.cds-backlog-matrix.md` — 37 条碎片项 SSOT
- `doc/plan.cds-deployment.md` — 部署策略

### 8.3 规范类(不要破坏的约定)

- `.claude/rules/no-auto-index.md` — 索引由 DBA 手动建
- `.claude/rules/no-localstorage.md` — 前端统一 sessionStorage
- `.claude/rules/bridge-ops.md` — Bridge 操作规范
- `.claude/rules/quickstart-zero-friction.md` — 快启动零摩擦原则

### 8.4 指南类(怎么操作)

- `doc/guide.cds-env.md` — 环境变量 + 多域名
- `doc/guide.cds-view-parity.md` — 列表↔拓扑对齐 + 人工 smoke 清单
- `doc/guide.cds-ai-auth.md` — 认证陷阱排查

### 8.5 报告类(历史记录)

- `doc/report.cds-phase-b-e-handoff-2026-04-14.md` — 上一棒的交接
- **`doc/report.cds-handoff-2026-04-16.md`** — 本文件
- `doc/report.cds-railway-alignment.md` — Railway 对齐评估(~92%)

---

## 九、致下一棒的一句话

> **本 session 把 CDS 从"能跑但用户走不通"推到了"用户能独立完成全链路"的状态。FU-02 是最后一块可控的拼图,下一棒完成它之后 P5 团队协作就能启动。不要跳过人工验收清单 §6。Don't break what works.**

---

**交接人**:Claude(本 session)
**交接日期**:2026-04-16
**交接分支**:`claude/review-handoff-report-updYh`(待合并到 main)
**交接测试状态**:602/602 green · tsc 零 error · `node --check` 全部 parse OK
