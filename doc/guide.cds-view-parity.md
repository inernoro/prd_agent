# CDS 列表视图 ↔ 拓扑视图 功能对齐 · 指南

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

> **2026-04-16 v2**:用户反馈原清单"模糊 · 无失败判定 · 没有回报模板",本次重写,每步都带**操作 · 预期 · 失败判定 · 失败排查**四栏。预计 15-20 分钟可跑完。

### 5.1 自动化(vitest · 必过)

```bash
cd cds
pnpm build  # tsc 必须零 error
pnpm test 2>&1 | tail -6  # 当前 602 tests pass · 不允许退步
```

**失败判定**:tsc 有任何 error · 或 vitest 任一 failed · 或 test 总数 < 600。

**失败排查**:

- `pnpm build` 报 `Cannot find module` → 执行 `pnpm install`
- `pnpm test` 卡住超过 2 min → Ctrl+C,查 `/tmp` 下 leftover state.json lock 文件
- 某个 smoke test 挂 → 先单独跑 `pnpm test tests/integration/xxx.smoke.test.ts` 看具体断言

### 5.2 人工端到端(真浏览器 · **必过**)

**准备** · 3 分钟:

```bash
# 1. 拉代码
cd /path/to/cds && git fetch origin && git checkout main  # 或对应分支

# 2. 配置(首次)
echo 'export CDS_GITHUB_CLIENT_ID="Iv1.xxxxxxxxxxxx"' >> ~/.cds.env   # 必须
echo 'export CDS_SECRET_KEY="'$(openssl rand -hex 32)'"' >> ~/.cds.env # 可选但建议

# 3. 重启
./exec_cds.sh restart

# 4. 浏览器 Cmd+Shift+R 清缓存访问 projects.html
```

### 5.2.1 核心 11 步(每步含失败判定)

| # | 操作 | 预期 ✓ | 失败判定 ✗ | 失败排查 → 回归的 UF |
|---|---|---|---|---|
| 1 | 访问 `projects.html` · 等 2 秒 | 左下角徽章从"加载中…"变成 GitHub 用户名 或 "未配置" | 徽章停留在"加载中…"超过 5 秒 | 检查 `/api/me` 和 `/api/github/oauth/status` HTTP 状态 → **UF-02/UF-02\*** |
| 2 | DevTools Console 页签 | 完全**无**红色 Error | 出现 `SyntaxError: Unexpected end of JSON input` | **UF-14** api() 响应解析 |
| 3 | 如有黄色横幅 · 点"复制环境变量模板" | 出现 toast "已复制环境变量模板" | 没 toast 或报错 | **UF-12** |
| 4 | 点左下角徽章 | 弹出 popover:GitHub 设置 · 使用 GitHub 登录 / 断开连接 | popover 不弹 或 空内容 | **UF-11** 徽章 popover |
| 5 | 点"新建项目"· 粘 `https://github.com/你的/公开仓库.git` · 提交 | Clone SSE modal 打开 · progress 逐行滚动 | modal 无日志 / 报 HTTP 400 | **UF-14** 或网络问题 |
| 6 | 进入 index.html · 搜索框粘 `smoke/parity-test` · Enter | 分支卡片 optimistic 出现 · deploy 按钮可点 | 卡片不出现 / Enter 无反应 | **UF-04** 搜索框手动添加 |
| 7 | 点"部署" · 观察 | 按钮**立即**变 spinner + "部署中…" · 卡片 inline log 滚动 | 按钮文字不变 / 没有 log | **UF-16** deploy 反馈 |
| 8 | 顶栏点"拓扑" | 切到拓扑视图 · 无重叠 toggle ghost UI | 同时出现**两套** `列表 \| 拓扑` toggle | **UF-17** topbar ghost |
| 9 | 点某服务节点 | Details 面板滑出 · + Add 按钮**暂隐藏** · 右上有清晰的关闭 X | + Add 盖住关闭 X | **UF-19** |
| 10 | 按 ESC | 面板关闭 · + Add 重现 | ESC 无反应 | **UF-19** ESC 监听 |
| 11 | 再点节点 · 点"环境变量" tab · 点某行左侧眼睛 | 眼睛变绿 · value 变可编辑 input · 改后 400ms 自动保存(或 toast) | 眼睛不响应 / value 不变 input | **UF-09** 继承覆盖 |

### 5.2.2 附加 6 项(每项 20 秒)

| # | 操作 | 预期 | 失败回归 |
|---|---|---|---|
| 12 | Details 切"部署日志" tab | 真实容器 stdout | 显示 `<div class="modal-header">` → **UF-20** GET/POST 错配 |
| 13 | 拓扑节点图标 | Redis 是立方体 · MongoDB 是绿叶 · app 是 GitHub 猫 | 仍是 emoji → **UF-21** |
| 14 | Deploy 中观察节点卡片 | 琥珀色脉冲呼吸 + drop-shadow 光晕 | 卡片无动画 → **UF-22** |
| 15 | Mac 触控板两指滑动 | 画布**平移** | 画布**缩放** → **UF-06** |
| 16 | Mac 触控板捏合 | 画布**缩放** | 无反应 → **UF-06** |
| 17 | 已配置 `CDS_SECRET_KEY` · 查 `state.json` | `githubDeviceAuth.token` 是 `{__sealed:true, iv:"...", tag:"...", data:"..."}` | 仍是明文字符串 → **FU-05** |

### 5.3 DevTools 期望基线

**允许的 Console 输出**:

| 级别 | 内容 | 来源 |
|---|---|---|
| `debug` | `[projects] /api/me network error: ...`(偶发,proxy 抽风) | bootstrapMeLabel `.catch` |
| `debug` | `[projects] /api/github/oauth/status network error: ...` | 同上 |
| `warn` | `[state] failed to unseal github device token ...`(仅 key 轮换时) | secret-seal.ts |
| `log` | `[scheduler] ...` 各种调度日志 | scheduler 正常输出 |

**不允许**:

- 任何 `Uncaught SyntaxError` · `TypeError` · `ReferenceError`
- `loadBranches: Error: HTTP ...`(非 isTransient 的持续报错)
- `Uncaught (in promise)` 任何形式

**判定**:F12 → Console → 点红色 Error 过滤 · 如果为空就是通过。

### 5.4 关键 API 端点(直接 curl · 纯后端验证)

```bash
BASE=http://localhost:9900

# Health(所有 GET 应 200)
curl -sf $BASE/api/config > /dev/null && echo "config OK"
curl -sf $BASE/api/branches > /dev/null && echo "branches OK"
curl -sf $BASE/api/build-profiles > /dev/null && echo "profiles OK"
curl -sf $BASE/api/infra > /dev/null && echo "infra OK"
curl -sf $BASE/api/routing-rules > /dev/null && echo "routing OK"
curl -sf $BASE/api/executors/capacity > /dev/null && echo "capacity OK"
curl -sf $BASE/api/github/oauth/status > /dev/null && echo "github OK"
curl -sf $BASE/api/storage-mode > /dev/null && echo "storage OK"

# UF-20 regression guard:container-logs 必须支持 POST 不是 GET
# GET 应落到 SPA fallback(返 HTML 200,但 Content-Type 是 text/html)
curl -sI $BASE/api/branches/smoke/container-logs | grep -i content-type
# 期望看到 text/html(说明 GET 落到 index.html);
# 然后 POST 应该返 JSON:
curl -s -X POST $BASE/api/branches/smoke/container-logs \
  -H 'content-type: application/json' \
  -d '{"profileId":"api"}' | head -c 200
# 期望看到 {"error":"..."}(可能是 404 因为分支不存在,但是 JSON)
```

### 5.5 出错时的回报模板(给下一棒)

发现任一步失败,复制以下模板填空后给下一棒 agent:

```
## Smoke 回归报告

- 日期:YYYY-MM-DD
- 分支:claude/xxx
- 失败步骤:§5.2.1 第 N 步 / §5.2.2 第 N 步 / §5.3 / §5.4
- 症状:(一句话)
- 浏览器:Chrome 版本号 · Safari 版本号 · Mac Intel/M1
- DevTools Console 完整截图:(贴)
- Network 页签相关请求的 status + response preview:(贴)
- 我怀疑是:(UF-N / 其他)
```

下一棒看到这个模板就有足够信息复现 bug。

### 5.6 本 session 已知未覆盖的角落(非阻塞但存在)

- **iPad / 移动端触屏**:UF-06 手势代码是 Mac 触控板契约,触屏未测
- **Windows 宿主**:FU-04 worktree per-projectId 用 symlink,Windows 权限可能失败(回退到 rename 未测)
- **大仓库(>100 repos)**:FU-01 分页理论上能,但无 >300 repos 账号的实测
- **AES key 轮换**:FU-05 换 `CDS_SECRET_KEY` 后能优雅失败,但批量迁移旧 token 路径未实现

这些都**不是 smoke 必过项**,但下次某条报回来了知道从这里开始查。

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
