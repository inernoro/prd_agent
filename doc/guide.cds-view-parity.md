# CDS 列表视图 ↔ 拓扑视图 功能对齐指南

> **类型**:guide | **创建**:2026-04-15 | **适用版本**:commit `eaf0029+`
>
> 用户的架构承诺:**拓扑面板未来继承列表面板功能**。本文档是两个视图的功能映射全表,每次改动任意一个视图,都要回来对照本表,确保不会漂移。

---

## 1. 本文档是什么

- **不是** design 文档(那是 `design.cds.md`)
- **是** 一份"该有的功能都在哪?"的速查表
- 每一行都指向具体代码位置,便于改一方时同步另一方
- 附带一套自测冒烟流程(`§5 冒烟测试清单`),提交前过一遍

---

## 2. 列表视图功能全集

> 源文件:`cds/web/app.js` 中 `renderBranches()` 的分支卡片,约 `3225-3500` 行。

### 2.1 核心动作(按分支粒度)

| # | 动作 | 触发位置 | 底层函数 | 状态 |
|---|---|---|---|---|
| L1 | 部署 / 重新部署 | 卡片左侧 split-button 主体 | `deployBranch(id)` | ✓ |
| L2 | 重新部署单个服务 | deploy dropdown → 选择服务 | `deploySingleService(id, profileId)` | ✓ |
| L3 | 切换部署模式 | deploy dropdown → 部署模式 | `switchModeAndDeploy(id, profileId, modeId)` | ✓ |
| L4 | 指定集群派发节点 | deploy dropdown → 派发到 | `deployToTarget(id, executorId)` | ✓ |
| L5 | 停止所有服务 | deploy dropdown → 停止 | `stopBranch(id)` | ✓ |
| L6 | 查看部署日志 | deploy dropdown → 部署日志 / 卡片内 inline | `viewBranchLogs(id)` / `openFullDeployLog(id)` | ✓ |
| L7 | 容器配置(继承/覆盖) | deploy dropdown → 容器配置 | `openOverrideModal(id)` | ✓ |
| L8 | 删除分支 | deploy dropdown → 删除分支 (danger) | `removeBranch(id)` | ✓ |
| L9 | 预览 | 右上角 preview 按钮(running 时) | `previewBranch(id)` | ✓ |
| L10 | 错误重置 | stopped/error 时右侧按钮 | `resetBranch(id)` | ✓ |
| L11 | 查看单服务容器日志 | 端口 chip 点击 | `viewContainerLogs(id, profileId)` | ✓ |
| L12 | 添加标签 | 分支标签行 "+ 标签" | `addTagToBranch(id)` | ✓ |
| L13 | 删除标签 | 标签 `×` 按钮 | `removeTagFromBranch(id, tag)` | ✓ |
| L14 | 编辑标签 | 标签行 ✏ 图标 | `editBranchTags(id)` | ✓ |
| L15 | 按标签筛选 | 标签本体点击 | `filterByTag(tag)` | ✓ |
| L16 | 查看提交日志 | commit area 点击 | `toggleCommitLog(id)` | ✓ |

### 2.2 全局 / 导航

| # | 动作 | 位置 | 底层函数 |
|---|---|---|---|
| LG1 | 添加分支 | 搜索框 Enter / 下拉"+ 手动添加" | `addBranch(name)` |
| LG2 | 刷新远端分支列表 | 搜索框右侧 🔄 | `refreshAll()` |
| LG3 | 构建配置管理 | ⚙ 菜单 → 构建配置 | `openProfileModal()` |
| LG4 | 路由规则管理 | ⚙ 菜单 → 路由规则 | `openRoutingModal()` |
| LG5 | 基础设施管理 | ⚙ 菜单 → 基础设施 | `openInfraModal()` |
| LG6 | 项目导出 | ⚙ 菜单 → 导出 | `showExportDialog()` |
| LG7 | 切换视图 | header `.view-mode-btn` | `setViewMode('list'|'topology')` |

---

## 3. 拓扑视图功能全集

> 源文件:`cds/web/app.js` 中 `_ensureTopologyFsChrome()` + `_topologyRenderPanelTab()`,约 `8043-10090` 行。

### 3.1 全屏外壳(Full-screen chrome)

| # | 位置 | 元素 | 功能 |
|---|---|---|---|
| T1 | 左侧 sub-nav | 拓扑图标 | 当前视图标记 |
| T2 | 左侧 sub-nav | ⚙ 项目设置 | 跳 `settings.html` |
| T3 | 左侧 sub-nav | 项目列表返回 | 跳 `projects.html` |
| T4 | 顶栏 | 面包屑 + 分支选择器 combobox | 切分支 / 添加分支(UF-07) |
| T5 | 顶栏右侧 | 列表 / 拓扑 segmented toggle(UF-08) | `setViewMode` |
| T6 | 浮动 + Add 按钮 | 弹出 `topologyFsAddMenu` | 新增服务入口 |
| T7 | + Add 菜单项 | GitHub 仓库 / 数据库 / Docker 镜像 / 路由规则 / 空服务 | `_topologyChooseAddItem(kind)` |
| T8 | 右侧滑入面板 | 9 个 tab(见 §3.2) | 节点点击触发 |
| T9 | 画布工具栏 | 放大 / 缩小 / 自适应 / 1:1 复位 | `_topologyZoomIn/Out/Fit/Reset` |
| T10 | 节点 | 端口 pill(GAP-08) | 单击复制 · 双击预览 |
| T11 | 节点 | 卡片整体 | `_topologyNodeClick` / `_topologyInfraClick` |

### 3.2 Details 面板 9 个 tab

| # | Tab | 内容 | 对应列表视图动作 |
|---|---|---|---|
| D1 | **详情** | 状态横幅 + Deploy / Stop / Delete 按钮(UF-05,GAP-01/02) + 公开 URL + 端口 | L1, L5, L8, L9 |
| D2 | **构建日志** | `/api/branches/:id/logs` | L6 |
| D3 | **部署日志** | `/api/branches/:id/container-logs?profileId=…` | L11 |
| D4 | **HTTP 日志** | SSE `/api/activity-stream` | — |
| D5 | **网络流** | 容器间依赖流 | — |
| D6 | **环境变量** | 继承/覆盖表,眼睛 toggle(UF-09) | L7(inline 版本) |
| D7 | **路由**(GAP-04) | 按 profileId 过滤 routingRules + 编辑按钮 | LG4(只读摘要) |
| D8 | **备注**(GAP-07) | notes + tags 只读展示 | L12-L14(只读) |
| D9 | **设置** | SERVICE INFO + 连接串(infra) + 部署模式(GAP-05) + 集群派发(GAP-06) | L3, L4(只读摘要) |

### 3.3 已对齐 / 缺失 / 有意不对齐

| # | 列表视图 | 拓扑视图 | 对齐? |
|---|---|---|---|
| L1 | deployBranch | Details Deploy 按钮 | ✓ 一致 |
| L2 | deploySingleService(单服务) | — | ✗ 拓扑不支持多服务内部选一个(可 future) |
| L3 | switchModeAndDeploy | Settings tab 部署模式展示 | ⚠ 只展示 · 不切换 |
| L4 | deployToTarget | Settings tab 集群派发展示 | ⚠ 只展示 · 不指定 |
| L5 | stopBranch | Details Stop 按钮 | ✓ 一致 |
| L6 | viewBranchLogs / openFullDeployLog | 构建日志 / 部署日志 tab | ✓ 一致 |
| L7 | openOverrideModal | Variables tab inline + "编辑全部"按钮 | ✓ 一致(inline 更方便) |
| L8 | removeBranch | Details Delete 按钮 | ✓ 一致 |
| L9 | previewBranch | Details Public URL 卡片 · 节点端口双击 | ✓ 一致 |
| L10 | resetBranch | — | ✗ 错误状态重置没入口(可 future) |
| L11 | viewContainerLogs(单 profile) | 部署日志 tab | ✓ 一致 |
| L12-L15 | 标签 CRUD + 筛选 | 备注 tab(只读) | ⚠ 只读 · 不能 inline 改 |
| L16 | toggleCommitLog | — | ✗ 拓扑没有 commit 历史入口 |
| LG1 | addBranch | 分支 combobox + Enter(UF-07) | ✓ 一致 |
| LG2 | refreshAll | — | ✗ 拓扑没刷新按钮(轮询自动刷新) |
| LG3 | openProfileModal | Details"编辑"按钮 in-place(UF-10) | ✓ 一致 |
| LG4 | openRoutingModal | 路由 tab "编辑路由"按钮 in-place(UF-10) | ✓ 一致 |
| LG5 | openInfraModal | + Add → Docker/Database 入口(UF-10) | ✓ 一致 |
| LG7 | setViewMode | 顶栏 toggle pill(UF-08) | ✓ 一致 |

---

## 4. 缺口列表(等 future sync)

| 缺口 | 描述 | 优先级 | 推荐位置 |
|---|---|---|---|
| **GAP-11** | 拓扑缺 deploy-single-service(多服务分支只能整体部署) | P2 | Details 面板 Deploy 按钮改为 split-button,右侧下拉选 profile |
| **GAP-12** | 拓扑缺 resetBranch 入口 | P3 | Details 状态栏错误态时显示 Reset 按钮 |
| **GAP-13** | 拓扑 Tags tab 只读,不支持 inline add/remove/edit | P2 | 借用列表视图的 `addTagToBranch` 等函数,inline 化 |
| **GAP-14** | 拓扑缺 commit 历史查看 | P3 | Details 面板加"提交历史"tab 或折叠区 |
| **GAP-15** | 拓扑 Settings tab 的部署模式/集群派发是只读的 | P2 | 加可点的下拉菜单,调用 `switchModeAndDeploy` / `deployToTarget` |
| **GAP-16** | 拓扑缺手动刷新按钮 | P3 | 顶栏加 🔄 图标调 `refreshAll` |

> 这些缺口都**不阻塞主流程**——用户可以临时回到列表视图使用。但用户的架构承诺是"继承列表功能",所以这些应该在下一轮 parity sweep 清掉。

---

## 5. 冒烟测试清单(提交前必跑)

### 5.1 自动化(vitest)

```bash
cd cds
pnpm build  # tsc 零 error
pnpm test   # 全部 560+ tests 通过
```

如 `tests/integration/view-parity.smoke.test.ts` 存在,会自动跑端到端 API 覆盖,详见 §6。

### 5.2 人工端到端(真浏览器)

**准备**:
```bash
export CDS_GITHUB_CLIENT_ID="Iv1.xxx"  # 可选,测 GitHub 流程
./exec_cds.sh restart
```

然后按**两列同时验**清单逐条打勾:

#### 5.2.1 列表视图 → 每行都要点

| 步骤 | 列表视图 | 拓扑视图对应验证 |
|---|---|---|
| 1 | 打开 `projects.html` · 点项目卡片进入 `index.html` | 顶栏右侧点"拓扑" → 切换到 topology |
| 2 | 左下角徽章显示用户名(UF-02) | 同上 |
| 3 | 分支搜索框输入 `test/new-branch` 按 Enter | 拓扑顶栏分支 combobox 输入 `test/new-branch-2` 按 Enter |
| 4 | Deploy 新分支 · 观察 inline log | 拓扑切到新分支 · 点节点 → Details → Deploy |
| 5 | Deploy 成功后点 preview 图标 | 节点端口 pill 双击 |
| 6 | 点容器配置 → 修改 env → 保存 | 节点 → Variables tab → 点眼睛 → 改值 → 自动保存 |
| 7 | 点"停止所有服务" | 节点 → Details → Stop 按钮 |
| 8 | 点"删除分支" | 节点 → Details → Delete 按钮 |
| 9 | ⚙ → 构建配置 → 新增 profile | + Add → Empty 空服务 |
| 10 | ⚙ → 路由规则 → 新增规则 | + Add → 路由规则 |
| 11 | ⚙ → 基础设施 → 新增 MongoDB | + Add → 数据库 → MongoDB |

**期望**:步骤 1-11 两边都能成功,状态变化在两边都能看到(因为用的是同一后端)。

### 5.3 DevTools 检查

- 打开 `index.html` 和 `projects.html` 两个页面
- Console 页签应该**完全没有红色错误**
- 如果有错误,UF-13 的 `window.onerror` 会自动弹 toast 提示

### 5.4 关键 API 端点(直接 curl)

```bash
BASE=http://localhost:9900

# Health
curl -s $BASE/api/config | jq .
curl -s $BASE/api/branches | jq '.branches | length'
curl -s $BASE/api/build-profiles | jq '. | length'
curl -s $BASE/api/infra | jq '. | length'
curl -s $BASE/api/routing-rules | jq '.rules | length'
curl -s $BASE/api/executors/capacity | jq .
curl -s $BASE/api/github/oauth/status | jq .
curl -s $BASE/api/storage-mode | jq .

# Branch CRUD
curl -s -X POST $BASE/api/branches -H 'content-type: application/json' -d '{"branch":"smoke/test","projectId":"default"}'
curl -s $BASE/api/branches/smoke-test/profile-overrides | jq .
curl -s -X DELETE $BASE/api/branches/smoke-test
```

全部应返回 200(或 404 for 明确不存在的分支)。

---

## 6. 自动化 smoke 测试文件说明

> 实现:`cds/tests/integration/view-parity.smoke.test.ts`

该测试以 supertest 风格直接启动 Express app,跑过两个视图共用的所有 API 路径。新增一个新路径或修改现有路径时,本测试应该同步更新。

---

## 7. 更新规则

任何人改 `cds/web/app.js` 的下列函数时,必须同步更新本表:

| 你改了… | 你要同步更新的 |
|---|---|
| `renderBranches()` 中的动作按钮 | §2.1 / §3.3 |
| `_topologyRenderPanelTab()` 任一 tab | §3.2 / §3.3 |
| `_ensureTopologyFsChrome()` | §3.1 |
| 新增全局 modal(`openXxxModal`) | §2.2 + §3.1 T7 |
| 新增 `window.xxx` 导出 | `Block B` 审计里补 |

---

## 8. 关联文档

- `doc/design.cds.md` — CDS 架构设计
- `doc/plan.cds-backlog-matrix.md` — 问题矩阵 SSOT
- `doc/plan.cds-multi-project-phases.md` — P0-P6 里程碑
- `doc/design.cds-resilience.md` — 服务器权威 / SSE 重连
