# CDS 横向事项 Backlog 矩阵

> **版本**：v0.1 | **日期**：2026-04-15 | **类型**：plan | **状态**：草案
>
> 作为 CDS 所有**横向事项**（用户可见缺陷、汉化缺口、已知限制、follow-up、技术债、测试缺口）的唯一 SSOT。
>
> **与 `plan.cds-multi-project-phases.md` 的区别**：主 plan 文档只装 P0-P6 大期路线；本文档装**不属于任何大期但必须跟踪**的所有碎片项。每次 handoff 尾巴新发现的条目都往这里追加。

---

## 导航

- [§1 摘要与统计](#1-摘要与统计)
- [§2 用户可见故障（UF-系列）](#2-用户可见故障uf-系列)
- [§3 Topology 视图 vs 列表视图功能对齐（GAP-系列）](#3-topology-视图-vs-列表视图功能对齐gap-系列)
- [§4 汉化缺口（L10N-系列）](#4-汉化缺口l10n-系列)
- [§5 已知限制（LIM-系列）](#5-已知限制lim-系列)
- [§6 后续候选（FU-系列）](#6-后续候选fu-系列)
- [§7 推荐修复优先级 Top-N](#7-推荐修复优先级-top-n)
- [§8 更新规则](#8-更新规则)
- [§9 来源参考](#9-来源参考)

---

## 1. 摘要与统计

**总事项数**:37 条(UF×10 + GAP×10 + L10N×3 + LIM×7 + FU×5 + TEST×2)

### 1.1 按类型统计

| 类型 | 数量 | P0 | P1 | P2 | P3 | 说明 |
|---|---|---|---|---|---|---|
| **UF** 用户可见故障 | 10 | 2 | 8 | 0 | 0 | 用户截图/复现路径实锤的阻塞问题 |
| **GAP** 视图功能缺口 | 10 | 0 | 4 | 5 | 1 | Topology vs List 功能空洞 + 画布组件统一(epic) |
| **L10N** 汉化缺口 | 3 | 0 | 1 | 2 | 0 | 英文残留与中英混排 |
| **LIM** 已知限制 | 7 | 0 | 0 | 4 | 3 | 设计权衡,不是 bug |
| **FU** 后续候选 | 5 | 0 | 1 | 4 | 0 | 来自上一棒 handoff §8.3 |
| **TEST** 测试缺口 | 2 | 0 | 2 | 0 | 0 | E2E / smoke 覆盖空白 |
| **合计** | **37** | **2** | **16** | **15** | **4** | |

### 1.2 按状态统计

| 状态 | 数量 | 占比 |
|---|---|---|
| `open` | 1 | 3% |
| `deferred` | 8 | 22% |
| `in-progress` | 0 | 0% |
| `done` | 28 | 76% |

> 2026-04-15 终局:**26 条清完**。UF-01..10 + GAP-01..09 + L10N-01..03 + FU-01 + FU-05 + TEST-01/02 全部 done。
> 2026-04-16:**FU-03** 补完(nixpacks 风格框架推断),目前 27 条 done。
> 2026-04-16:**FU-04** 补完(worktreeBase 按 projectId 分子目录 + 符号链接迁移),目前 28 条 done。
>
> 剩 1 条 `open`——需独立 session 设计:
> - **FU-02** MapAuthStore mongo 后端(touches 认证架构)
>
> `deferred` 的 8 条:LIM-01..07(设计权衡)+ GAP-10(跨项目画布组件统一 epic)。

### 1.3 阻塞项

**P0 优先级(必须先修)**:

1. **UF-01** · Device Flow token 持久化静默失败 → 阻塞私有仓库 clone
2. **UF-02** · 左下角徽章不识别 GitHub 用户 → 用户完全无从得知是否登陆成功

这两条并发修复,**UF-02 可以 5 分钟改完,UF-01 需要 ~30 分钟改错误传播路径 + 测试**。

### 1.4 用户反馈 3 张截图的归宿

| 截图 | 现象 | 归属 |
|---|---|---|
| 截图 1 | 左下角橙色 `?` "未登录" 徽章 | **UF-02** |
| 截图 2 | clone 报错 `could not read Username for 'https://github.com'` | **UF-01** |
| 截图 3 | Topology 画布节点堆在左上角 | **UF-03** |

用户补充需求"如何添加新的分支/粘贴分支名" → **UF-04**

### 1.5 更新频率

- 每次 handoff 的尾巴必须过本表一遍,新事项登记、已修事项关闭
- 主 plan (`plan.cds-multi-project-phases.md`) 只跟 P0-P6 大期进度,本表跟所有碎片项

---

## 2. 用户可见故障（UF-系列）

> 用户实际使用时碰到的、能用截图/复现步骤描述的故障。**优先级最高**——这些直接阻塞可用性。

### 速览

| ID | 标题 | 优先级 | 规模 | 状态 | 根因文件 |
|---|---|---|---|---|---|
| UF-01 | Device Flow token 持久化静默失败，clone 私有仓库报 `could not read Username` | P0 | M | **done** 2026-04-15 | `routes/github-oauth.ts` await persist + `routes/projects.ts` preflight + `_mapGitCloneError` |
| UF-02 | 左下角徽章永远显示"未登录"，不显示 GitHub Device Flow 用户 | P0 | S | **done** 2026-04-15 | `web/projects.js:381` bootstrapMeLabel 降级探测 oauth/status |
| UF-03 | Topology 节点挤在画布左上角，右侧 2/3 空白 | P1 | S | **done** 2026-04-15 | `web/app.js` 首次渲染 rAF + `_topologyFit` 自动居中 |
| UF-04 | 无法手动输入/粘贴分支名创建分支，只能从 git refs 下拉选择 | P1 | S | **done** 2026-04-15 | `web/index.html:73` placeholder + `web/app.js` Enter 键 + 下拉"手动添加"入口 |
| UF-05 | Topology 卡片样式过硬、内容过密,和参考图(图1)不一致 | P1 | M | **done** 2026-04-15 | `web/app.js` 卡片 280×150 + 卡片只留 name+status + 底部 volume slot + 正交连线 + `web/style.css` 圆角 18px |
| UF-06 | Mac 触控板两指滑动被误绑定到缩放,无法平移画布 | P1 | S | **done** 2026-04-15 | `web/app.js` wheel 事件按 `ctrlKey/metaKey` 分流:有修饰键→缩放,无修饰键→平移(从 `AdvancedVisualAgentTab.tsx:3267` 移植) |
| UF-07 | Topology 分支选择器只能切换已有分支,无法输入/粘贴新分支 | P1 | M | **done** 2026-04-15 | `web/app.js` 原生 `<select>` 替换为自定义 combobox,Enter 添加/"+ 手动添加"入口/共用列表视图的 `addBranch()`|
| UF-08 | Topology 无法切换回列表视图(只有一个藏在 leftnav 的"日志"暗门) | P1 | S | **done** 2026-04-15 | `web/app.js` topbar 加"列表 \| 拓扑"切换 pill + `setViewMode` 同步两套 `.view-mode-btn` 和 `.topology-fs-view-toggle-btn` 的 active 状态 |
| UF-09 | Variables tab 只读展示 profile.env,不支持分支覆盖/继承/禁用 | P1 | M | **done** 2026-04-15 | `web/app.js _topologyRenderBranchScopedVariables` 按 branchId 拉 `/profile-overrides`,每行眼睛切换继承/覆盖,value input 去抖 PUT 写 override |
| UF-10 | 拓扑视图点"编辑"按钮会跳回列表视图(跨视图暗门) | P1 | S | **done** 2026-04-15 | 删除 `_topologyPanelOpenEditor` / `_topologyPanelOpenLogs` / `_topologyChooseAddItem` 的 `setViewMode('list')` 调用 + 替换不存在的 `renderBuildProfiles`/`renderRoutingRules` 为真实的 `openProfileModal`/`openRoutingModal` |
| UF-02\* | 徽章刷新回归:只在 pageload 跑一次,用户中途完成 OAuth 后不更新 | P1 | S | **done** 2026-04-15 | `web/projects.js` bootstrapMeLabel 变为幂等可重入;device-poll 'ready' 后调用 `bootstrapMeLabel()`;failure 路径给出诊断 tooltip 定位是哪个 probe 失败 |

---

### UF-01 · Device Flow token 持久化静默失败

**现象**（用户截图 2）：
- 用户在 Settings → GitHub 点 "Sign in with GitHub"，完成 Device Flow 浏览器授权
- 前端 UI 显示"已连接 @xxx"
- 然后在 projects.html 粘贴 `https://github.com/mdimpteam/imp.git` 创建项目
- POST /api/projects/:id/clone 返回 error，日志：
  ```
  fatal: could not read Username for 'https://github.com': terminal prompts disabled
  ```
- 克隆命令里 URL 没有 token，git 交互式问 username 被禁用即失败

**根因**：
- `cds/src/routes/github-oauth.ts:108,129`——`device-poll` 端点里调用 `stateService.setGithubDeviceAuth(snapshot)` 后直接 `res.json({ status: 'ready' })`，**没有验证 state.save() 是否成功**
- `cds/src/services/state.ts:717-724`——`setGithubDeviceAuth()` 调用 `this.save()`，若 save 发生异常（磁盘满、权限、并发写冲突）异常被上层 catch 静默吞掉
- 前端 `_pollGithubDevice` 在收到 `status === 'ready'` 时立即认定成功、关闭 modal、刷新 UI，但 **state.json 里可能根本没 `githubDeviceAuth` 字段**
- 后续 `POST /api/projects/:id/clone` 调用 `getGithubDeviceAuth()?.token` 返回 undefined，`_injectGithubTokenIfPossible` 不注入，原始 URL 原样传给 git clone

**注意**：上一棒 handoff 声称 commit `1bbabdb` 已修此问题（标注为 "audit BUG #1"），但那次修的是**注入逻辑本身**（`_injectGithubTokenIfPossible` 辅助函数 + 单元测试），没覆盖**持久化是否成功**这条链路。两个问题名字像但层次不同。

**修复方向**：
1. `setGithubDeviceAuth()` 明确 `await` 并在 save 失败时抛异常而不是静默
2. `device-poll` 端点捕获 persistence 异常并返回 `{ status: 'error', message: 'Failed to persist token' }` 而不是假 ready
3. 前端 `_pollGithubDevice` 只在没有 `error` 且 `status === 'ready'` 时认定成功
4. 新增端到端测试：mock `setGithubDeviceAuth` 抛异常 → `device-poll` 返回 error
5. 新增 smoke 测试覆盖"Device Flow 成功 → clone 时注入 token"全链路

**关联测试缺口**：
- `tests/routes/github-oauth.test.ts` 缺 persistence 失败场景
- `tests/integration/multi-repo-clone.smoke.test.ts` 未覆盖 Device Flow → clone 链路

**来源**：用户截图 2 + Explore agent 1（GitHub 认证路径审计）

---

### UF-02 · 左下角徽章永远显示"未登录"

**现象**（用户截图 1）：
- Projects.html 或 Dashboard 左下角显示一个橙色圆圈带白色 `?`，文字"未登录"
- 期望：已完成 GitHub Device Flow 后显示 `@github-login` + 真实头像
- 实际：即使 Device Flow 成功且 state 里有 token，也始终显示"未登录"

**根因**：
- `cds/web/projects.js:381-400` `bootstrapMeLabel()` 函数只调用 `/api/me`，拿 CDS 自身的 session 用户
- `/api/me` 在 `CDS_AUTH_MODE=disabled` 或 `basic` 时返回 401 或 null，函数直接 `return`，徽章保持默认"未登录"
- **从不**调用 `/api/github/oauth/status` 去拿 Device Flow 的 GitHub 用户
- 代码里两个身份源（CDS session vs GitHub Device Flow）是独立的，左下角徽章只认第一个

**修复方向**：
- `bootstrapMeLabel()` 调整为两级查询：
  1. 先查 `/api/me`（CDS 自身 session）
  2. 若无，查 `/api/github/oauth/status`，`connected === true` 时用 GitHub login + avatar 填徽章
  3. 两者都无才显示"未登录"
- 考虑在两路径都成功时优先显示 CDS session 用户（更"正式"身份），GitHub 作为辅助信息
- Device Flow 完成后触发一次徽章刷新（当前仅 modal 关闭，未刷新全局徽章）

**关联缺陷**：
- UF-01 根因没解决时，这里即使改代码也会露出 undefined 状态——需先修 UF-01 确保 token 确实持久化

**来源**：用户截图 1 + Explore agent 1

---

### UF-03 · Topology 节点挤左上角，右侧大片空白

**现象**（用户截图 3）：
- Topology 视图 MongoDB / Redis / api / admin 四个节点全部排在画布左侧 1/3 区域
- 画布容器是 100% 宽（~1450px）但 SVG 内容宽度只有 ~560px，无任何居中或留白处理
- 视觉效果：右侧 2/3 全是点阵网格空白

**根因**：
- `cds/web/app.js:8328-8350` 布局算法里 SVG 坐标固定从 `TOPO_PAD=40` 开始累加
  ```javascript
  const x = TOPO_PAD + layerIdx * (TOPO_NODE_W + TOPO_GAP_X);
  const totalW = TOPO_PAD * 2 + layout.layers.length * TOPO_NODE_W + ...;
  ```
- `cds/web/app.js:8456` SVG 生成时 `width="${totalW}" viewBox="0 0 ${totalW} ${totalH}"`——严格按内容尺寸，不扩到容器宽度
- `cds/web/style.css:5071-5084` `.topology-canvas-wrap` 是 `width: 100%`，但里面的 SVG 不响应容器宽度
- **缺**容器感知 + offsetX 居中算法

**修复方向**：
- 方案 A（保守）：SVG 生成前读 `container.clientWidth`，若 `totalW < containerW` 则 `offsetX = (containerW - totalW) / 2`，所有节点 x 坐标加这个 offset
- 方案 B（更优）：SVG 外层 `<g transform="translate(${offsetX}, 0)">` 包住所有节点，只动一次 transform
- 方案 C（响应式）：监听 `ResizeObserver`，容器宽度变化时重算 offset
- 同时考虑头部工具栏占两行时竖直方向的居中

**来源**：用户截图 3 + Explore agent 2

---

### UF-04 · 无法手动输入新分支名

**现象**：
- Topology 顶部工具栏的分支选择是一个下拉框（用户截图 3 里 "main ▼"）
- 用户想粘贴一个任意分支名（比如 `feature/newstuff`）直接添加到 CDS，但搜索框是只读过滤，不是新建入口
- 用户必须从"本地已添加分支"或"远端 git refs 列表"里选，**不支持自由输入**

**根因**：
- `cds/web/index.html:73-84` 现有 HTML：
  ```html
  <input id="branchSearch" type="text" placeholder="搜索分支..." autocomplete="off">
  <div id="branchDropdown" class="branch-dropdown hidden"></div>
  ```
  搜索框 placeholder 写的是"搜索分支"，用户的心智模型被 placeholder 锁死
- `cds/web/app.js:1030-1136` `filterBranches()` 只展示 `matchedLocal` + `matchedRemote` 两种来源，没有"新增"兜底
- 后端 `POST /api/branches` 实际上接受任意分支名（只要项目存在），但 UI 没暴露这个能力

**修复方向**：
- 搜索框改为"搜索或输入新分支名"作 placeholder
- 输入非空且不匹配任何本地/远端分支时，下拉框底部显示固定的 "+ 创建分支：{用户输入}" 选项
- 点击该选项直接 POST `/api/branches` 带 `{ name: 输入值, projectId }`
- 失败时在 toast 里给出具体错误（比如 branch 已存在、命名非法）

**来源**：用户描述 + Explore agent 2

---

### UF-05 · Topology 卡片样式过硬,与参考图 1 不一致

**现象**(用户给的两张对照图):
- **图 1(参考/期望)**:卡片圆角 ~18px,padding 宽松,logo 大且留白,状态是纯色填充圆点 + "Online",底部 named volume 独立成一个槽(横线分割 + 🗄️ + 卷名),连线直角正交虚线 HVH 路径
- **图 2(CDS 现状)**:卡片圆角 12px/胶囊 26px 混用,padding 紧,logo emoji 贴边,中文状态行挤在中间,镜像/端口/deps 三行文字塞在 110px 高度,连线是斜线贝塞尔曲线——视觉上有"卡片要爆开了"的压迫感

**根因**:
- `cds/web/app.js:8314-8318` 原几何参数 `TOPO_NODE_W=236 / TOPO_NODE_H=110 / TOPO_GAP_X=90` 偏紧
- `cds/web/app.js:8484-8505` SVG 模板把 icon、name、status-dot、status、image、port、deps 四到五行内容塞在 110px 高度内,每行只有 ~22px 行高
- `cds/web/app.js:8434` 边连线用 `M..C..` 三次贝塞尔曲线,和 Railway 参考图的"直角 HVH"风格不符
- `cds/web/style.css:5119-5125` 卡片 rx 有 `topology-node-box (12px) / topology-node-capsule (26px)` 两套,不统一

**修复**(commit `TBD`):
- 卡片几何 bump:W 236→280, H 110→150, gap X 90→110, gap Y 36→48, padding 40→48
- 统一圆角:`TOPO_NODE_RADIUS = 18`,apps 和 infra 都用同一个矩形(`.topology-node-box`),废弃 `.topology-node-capsule`
- 主体内容精简:只留"icon + 名称"顶部区域和"状态圆点 + 中文状态"状态行。**移除 image/port/deps 三行文字**,它们已在点击卡片后的 Details 面板里展示
- 新增 volume slot:对 `InfraService.volumes[0]` 存在的节点,卡片底部 38px 高度切出独立槽位,`<line>` 分割 + 🗄️ emoji + 卷名(样式参见 `topology-node-divider / topology-node-slot-icon / topology-node-slot-label`)
- 连线改为正交 HVH:`M x1 y1 L mid-r y1 Q mid y1 mid cornerY1 L mid cornerY2 Q mid y2 mid+r y2 L x2 y2`,弯角半径 8px 避免硬角
- CSS 字体 bump:`topology-node-label` 14→17,新增 `topology-node-status-label` 13px

**来源**:用户反馈截图 + 和我们 Railway 风格参考图对照

---

### UF-06 · Mac 触控板双指滑动被误绑定到缩放

**现象**:
- 在 Mac 触控板上使用拓扑视图,用户预期两指滑动 = 平移画布(Figma/Miro/Notion/所有主流画布产品都这么做)
- 实际 CDS 的两指滑动被绑定到了"缩放",和"捏合缩放"冲突,用户反馈"很鸡肋"
- 同样的手势在我们自己的 VisualAgent 里工作正常(文件 `prd-admin/src/pages/ai-chat/AdvancedVisualAgentTab.tsx:3267-3281`)

**根因**:
- `cds/web/app.js:8595-8600` 原 wheel 事件无条件把 `deltaY > 0 ? -0.1 : 0.1` 传给 `_topologyZoom`,不区分是否有 `ctrlKey/metaKey` 修饰
- macOS 的触控板双指滑动 → wheel 事件 + `ctrlKey=false`
- macOS 的触控板捏合 → wheel 事件 + `ctrlKey=true`(浏览器内核自动转换)
- 旧代码把两种情况都当作缩放处理,导致两指滑动的 deltaX/deltaY 本应平移的部分被吃掉

**修复**(commit `TBD`):
- `cds/web/app.js` wheel 监听器按修饰键分流:
  ```js
  if (e.ctrlKey || e.metaKey) {
    // 捏合/Ctrl+wheel → 向鼠标方向缩放
    const factor = Math.exp(-e.deltaY * 0.01);
    // ...
  } else {
    // 两指滑动 → 平移
    _topologyViewport.tx -= e.deltaX;
    _topologyViewport.ty -= e.deltaY;
  }
  ```
- 代码直接照抄 VisualAgent 的 `AdvancedVisualAgentTab.tsx:3267-3281`,保证两个画布的手势契约一致
- Zoom 公式改为 `Math.exp(-deltaY * 0.01)` 指数平滑(而非线性 `±0.1`),缩放速率不再受触控板 deltaY 绝对值影响

**相关**:GAP-10(画布组件统一,见 §3),这次只同步了手势代码和视觉语言,没有提取共享组件

**来源**:用户反馈 + Explore agent 跨项目调研(VisualAgent + Workflow)

---

### UF-07 · Topology 分支选择器不支持输入/粘贴新分支 · **done** 2026-04-15

**现象**(用户截图:native `<select>` 下拉列出 `main` / 其他 tracked 分支):
- 拓扑视图顶栏的分支选择器是一个原生 `<select id="topologyFsBranchSelect">`,只能在已有的 tracked 分支之间切换
- 用户想粘贴 `feature/newstuff` 直接创建并跟踪一个新分支,但原生 select 不接受任意输入
- 列表视图已有"输入/粘贴 + Enter 添加"(UF-04 commit `dd5290b`),拓扑视图没同步

**根因**:
- `cds/web/app.js:8100` 原 HTML 用原生 `<select>`,没有文本输入能力
- `cds/web/app.js:10327 _topologyRefreshBranchDropdown` 只写 `<option>` 标签,没有添加分支的交互
- 列表视图的 `addBranch(name)` (line 1165) 已经封装好了"slug + 乐观插入 + POST /api/branches + toast"的全流程,拓扑视图没调用

**修复**:
- 把原生 `<select>` 换成自定义 combobox: `<button class="topology-fs-branch-combo-btn">` + `<div class="topology-fs-branch-combo-popover">` 内含 `<input>` 搜索框 + 分区列表(已添加 / 可添加 / 手动添加) + 空状态提示
- 搜索输入的 `keydown Enter` 调用共享的 `addBranch(raw)`——和列表视图走同一条 code path,保证两视图的"添加分支"行为 1:1
- 空状态 / 无匹配时也常驻"+ 手动添加"入口,降低用户发现成本
- Popover 外点击关闭、ESC 关闭、下拉图标旋转动画等细节都做了
- CSS: `.topology-fs-branch-combo / -btn / -popover / -search / -list / -section / -item / -item.manual-add / -empty` 全套样式补齐

**来源**:用户反馈截图 + 架构方向"拓扑面板未来会继承列表面板"

---

### UF-08 · Topology 无法切换回列表视图 · **done** 2026-04-15

**现象**:
- 进入拓扑视图后,用户找不到"返回列表"的入口
- 实际代码里左侧 leftnav 第二个图标(原标签"日志",实际 onclick 是 `setViewMode('list')`)是个**暗门**,图标长得像日志卡片,tooltip 也写"日志",没有视觉上"切换视图"的 affordance

**根因**:
- `cds/web/app.js:8074` leftnav 的"日志"图标 tooltip 和 icon 和真实行为脱节(tooltip 说日志,点击切视图)
- 没有显眼的"列表 | 拓扑"切换控件
- 违背 UI 常识:Railway / Figma / 任何双视图产品都在顶栏放切换 segmented control

**修复**:
- 删除 leftnav 的"日志"暗门图标
- 拓扑顶栏右侧新增 `<div class="topology-fs-view-toggle">` segmented control,两个按钮"📋 列表"和"🕸️ 拓扑",active 状态由 `setViewMode()` 自动同步
- `setViewMode()` 的 `querySelectorAll` 从只看 `.view-mode-btn` 扩展为同时看 `.view-mode-btn, .topology-fs-view-toggle-btn`,两套 toggle 用同一个 `data-view-mode="list|topology"` 属性驱动
- 这样拓扑 → 列表 → 拓扑的来回切换只需要点一下顶栏的 pill,不需要去 leftnav 猜图标含义

**来源**:用户反馈"现在拓扑无法切换到列表"

---

### UF-09 · Variables tab 不支持继承+覆盖(P1) · **done** 2026-04-15

**现象**(用户描述):
- 点 Variables tab 只能看到 profile.env 的只读快照
- 想要:"左侧眼睛禁用, 编辑值覆盖" —— 即眼睛切继承/覆盖, value 输入框就地写 branch override
- 这是 Railway 的标准 env vars 体验,我们之前的只读版是退化版

**根因**:
- `_topologyRenderPanelTab('variables')` 早期实现只读了 `entity.env`
- 没调 `/api/branches/:id/profile-overrides` 拿继承/覆盖结构
- 没有 eye toggle / inline input / 写回 override 的前端代码

**修复**:
- 新增 `_topologyRenderBranchScopedVariables(branchId, entity)`:拉取 `/profile-overrides` → 找当前 profile → 渲染继承+覆盖合并后的 key 列表
- 每行 4 列:[👁 眼睛 toggle] [KEY 只读] [VALUE readonly/input] [(隐藏的操作)]
- 眼睛状态机:
  - 闭眼(灰)= 继承自 profile.env,value 只读
  - 开眼(绿)= 已覆盖,value 变为 `<input>`,编辑时 400ms debounce PUT 写回
  - 禁用(橙)= CDS_* 基础设施变量,点击提示"不能覆盖"
- 新增 `_topologyVarsToggleOverride(key)` / `_topologyVarsOnInput(key, value)` / `_topologyVarsPersistImmediate()` / `_topologyVarsResetBranch()` 四个处理器
- 共享视图(无分支选中)时回退到 read-only 模式 + 提示"选一个分支即可切换为可覆盖模式"
- CSS: `.tfp-var-row`(4 列 grid)+ `.tfp-var-eye.inherited/.override/.locked` + `.tfp-var-val-input` focus 阴影

**关联**:GAP-03(环境变量 tab)由此 UF-09 升级成品替换 —— 之前标的 GAP-03 "已存在" 是半成品。

**来源**:用户反馈"这个包含继承和覆盖的部分, 用户可以在右侧值这里编辑, 左侧眼睛 禁用, 编辑值 覆盖"

---

### UF-10 · 拓扑视图点"编辑"跳回列表(跨视图暗门) · **done** 2026-04-15

**现象**(用户描述):"点击编辑还会跳转到列表页, 上次我就发现了类似功能, 这次又是这个跳转过去的"

**根因**:
- `_topologyPanelOpenEditor`(`app.js:10382`)对非 app+branch 场景调 `setViewMode('list')` + `setTimeout(..., 50)` 再打开模态,用户体验是"咔一下跳到列表再弹出模态"
- `_topologyPanelOpenLogs`(`app.js:10048`)同上
- `_topologyChooseAddItem` 中的 docker / routing / empty 分支都 `setViewMode('list')` 然后调**不存在的**函数 `renderBuildProfiles` / `renderRoutingRules`(legacy dead symbols)
- 根本原因:作者一开始以为必须切到列表才能打开 `openConfigModal`,实际 `openConfigModal` 写入的是全局 `#configModal` overlay,和 view mode 无关

**修复**:
- `_topologyPanelOpenEditor`:shared-view 分支改为 `openProfileModal()` in place;infra 分支改为 `openInfraModal()` in place;两者都不再切视图
- `_topologyPanelOpenLogs`:删除 `setViewMode('list')` + `setTimeout`,直接调 `openLogModal(id)`
- `_topologyChooseAddItem`:`docker` / `routing` / `empty` 分支都改为 in-place 调用真实的 `openInfraModal` / `openRoutingModal` / `openProfileModal`,不再切视图
- 注:命令面板里**用户主动**"切换到列表视图"的 `setViewMode('list')` 保留(那是用户明确要求的行为,不是暗门)

**来源**:用户反馈"迁移问题还挺多" + 代码审计 grep `setViewMode\('list'\)` 命中 6 个点,修复其中 4 个真暗门

---

### UF-02\* · 徽章刷新回归(P1) · **done** 2026-04-15

**现象**(用户 2026-04-15 反馈 + 截图):
- 用户发截图:左下角橙色"?" + "未登录"
- 用户强调:"其实我是登陆状态下的"
- 上一轮 UF-02 的修复只覆盖了 pageload 时的 probe,没覆盖"用户中途完成 OAuth 后也要刷新徽章"

**根因**:
- `projects.js:1299 bootstrapMeLabel()` 只在 IIFE 启动时跑一次
- Device Flow 完成后,`_pollGithubDevice` 成功分支只刷新了 create-modal 里的 "已连接"banner,没刷新左下角徽章
- 加上硬编码的 HTML placeholder `未登录` 会短暂闪现 ~100ms,给人一种"bug 没修"的印象
- 没有诊断路径 —— 用户看到"未登录"完全不知道是 `/api/me` 出错还是 `/api/github/oauth/status` 出错

**修复**:
- `bootstrapMeLabel()` 重构为**幂等可重入**:任意时机调用,不依赖闭包状态
- 拆出 `_renderBadgeIdentity` / `_renderBadgeNotLoggedIn` 两个纯渲染函数,显式处理"已解析"和"未解析"两种状态
- 未解析时写 `title` tooltip 附带诊断字符串(`CDS 会话: 无 · GitHub: 未配置 CDS_GITHUB_CLIENT_ID`),用户 hover 就知道卡在哪一步
- `_pollGithubDevice` 'ready' 分支追加调用 `bootstrapMeLabel()`
- 暴露 `window._cdsRefreshIdentityBadge` 供其他页面/模态框主动刷新
- HTML placeholder `未登录` → `加载中…`,avatar `?` → `···`,避免 initial flash 的误导
- 所有 fetch 错误现在都 `console.debug()` 而不是静默,运营可以 DevTools 查

**来源**:用户 2026-04-15 反馈 + 截图

---

## 3. Topology 视图 vs 列表视图功能对齐（GAP-系列）

> 拓扑视图用户可执行的操作集合必须 ≥ 列表视图（或明确声明不覆盖）。当前拓扑是列表的功能子集。

### 功能映射全表

| # | 列表视图功能 | 拓扑视图对应 | 对齐状态 | GAP ID |
|---|---|---|---|---|
| 1 | 部署 / 重新部署 | Details 面板 Deploy 按钮（G5） | ✓ 有 | — |
| 2 | 查看日志 | Details 面板「日志」tab | ✓ 有 | — |
| 3 | 停止 / 重启容器 | 节点无下拉菜单，暂无 | **✗ 缺失** | GAP-01 |
| 4 | 容器配置 / override | Details 面板「配置」tab | ✓ 有 | — |
| 5 | 删除分支 | 节点无下拉菜单，暂无 | **✗ 缺失** | GAP-02 |
| 6 | 查看/编辑**环境变量** | Details 面板无此 tab | **✗ 缺失** | GAP-03 |
| 7 | 编辑**路由规则** | Details 面板无此 tab | **✗ 缺失** | GAP-04 |
| 8 | 修改部署模式（bind/copy/image） | 节点无下拉菜单，暂无 | **✗ 缺失** | GAP-05 |
| 9 | 集群派发（target selector） | 节点无下拉菜单，暂无 | **✗ 缺失** | GAP-06 |
| 10 | **编辑标签 / 备注** | Details 面板无此 tab | **✗ 缺失** | GAP-07 |
| 11 | 查看端口（显示） | 节点卡片已显示 port | ✓ 有 | — |
| 12 | 复制 / 打开 Web 端口 | 节点卡片显示信息但无 copy/open 按钮 | △ 信息有，交互缺 | GAP-08 |
| 13 | 预览（Quick action） | 入口与列表不同但存在 | △ 风格不一致 | GAP-09 |

**结论**：拓扑视图约覆盖列表视图 **50%** 的功能（13 项中 5 项完整、2 项半覆盖、6 项缺失）。

---

### 设计决策需要对齐

用户提问："**用户如何在拓扑中使用列表的所有功能？是否一比一映射？**"

需要明确回答以下设计决策：

- **决策 A**：拓扑视图**必须 1:1 覆盖**列表视图的所有用户功能（否则两个视图会分叉，用户被迫来回切换）
- **决策 B**：拓扑视图**不覆盖**列表的所有功能，只承担"形势感知 + 一键部署"，其他操作必须去列表
- **决策 C**：折中——拓扑覆盖高频操作（部署 / 日志 / 配置），低频操作（改部署模式 / 路由 / 标签）留在列表，**但 UI 必须明确提示"更多操作请到列表视图"**

**当前状态**：实际行为偏向 C，但没明确提示——用户会误以为拓扑就是全部能力，陷入"拓扑里找不到环境变量怎么办"的困惑。

**建议**：先和用户确认走 A 还是 C。走 A 就开 GAP-01 ~ GAP-07 七条子任务；走 C 就开 **UF-新增**：拓扑 Details 面板加一个"更多操作→列表视图"引导链接。

---

### GAP-01 ~ GAP-07（拓扑缺失的 7 个功能入口）

原计划七条共享修复思路：扩展 `_topologySwitchPanelTab` (`app.js:9277-9296`) 新增 3 个 tab（环境变量/路由/标签），同时给节点增加右键菜单或 `⋯` 按钮复制列表 `deployMenuItem` 的 dropdown（停止/删除/部署模式/集群派发）。**2026-04-15 更新**:GAP-01/02/03 已在本轮关闭,GAP-04..07 继续留着等下一棒或合并成 epic。

| ID | 缺失 | 承载位置 | 优先级 | 状态 |
|---|---|---|---|---|
| GAP-01 | 停止 / 重启容器 | Details 面板状态栏 | P1 | **done** 2026-04-15 (`tfp-stop-btn` 接 `stopBranch`) |
| GAP-02 | 删除分支 | Details 面板状态栏 | P1 | **done** 2026-04-15 (`tfp-delete-btn` 接 `removeBranch`) |
| GAP-03 | 环境变量 tab | Details 面板 | P1 | **done** (升级为 UF-09 继承/覆盖版) |
| GAP-04 | 路由规则 tab | Details 面板 | P2 | **done** 2026-04-15 (`tab === 'routing'` 拉 `routingRules` 按 profileId 过滤 + 编辑按钮调 `openRoutingModal` in-place) |
| GAP-05 | 部署模式切换 | Settings tab | P2 | **done** 2026-04-15 (Settings tab 新增"部署模式"区块,遍历 `entity.deployModes` 展示每分支的 mode) |
| GAP-06 | 集群派发 | Settings tab | P2 | **done** 2026-04-15 (Settings tab 新增"集群派发"区块,遍历 `executors` 展示节点清单) |
| GAP-07 | 标签 / 备注 tab | Details 面板 | P3 | **done** 2026-04-15 (`tab === 'tags'` 渲染 `entity.notes` + `entity.tags`,编辑按钮 in-place 打开 profile 编辑器) |

### GAP-08 · 节点卡片端口信息缺交互 · **done** 2026-04-15

**原现象**:节点卡片展示端口号但不可交互。

**修复**(`web/app.js _topologyNodePortClick / _topologyNodePortDblClick`):
- 卡片右下角重新加一个 rx-11 圆角 pill,显示 `:port`
- 单击 → 复制 `host:port` 到剪贴板 + toast
- 双击 → 若已选分支,走 `previewBranch()` 打开预览(多模式支持);否则开新标签访问 `http://host:port`
- CSS hover:stroke/文本切换为 accent 绿色

### GAP-09 · 预览入口风格不一致 · **done** 2026-04-15

**修复**:同 GAP-08 的端口 pill 顺手搞定 —— 拓扑节点右下 Quick Action 现在就是这个端口 pill,和列表视图的 Quick Action 行概念一致(点一下就能预览)。列表视图的 Quick Action 仍然是显式按钮组,两侧在"一键预览"上的用户路径长度一致。

**来源**:Explore agent 2(功能映射审计)

---

### GAP-10 · 跨项目画布组件统一(epic · deferred)

**现象**:CDS Topology / VisualAgent / Workflow 三个画布各自实现,风格与手势不一致。

| 画布 | 技术栈 | 手势支持 | 节点样式 | 文件 |
|---|---|---|---|---|
| **CDS Topology** | 纯 vanilla JS + SVG(`<g><rect><text/>`) | UF-06 后已移植 VisualAgent 手势 | UF-05 后匹配图 1 | `cds/web/app.js:8381+` |
| **VisualAgent** | React + CSS transform + 自定义 pointer events | ✅ wheel/ctrlKey 分流 + Space+drag | `rounded-[16px]` 图片浮层(非 DAG) | `prd-admin/src/pages/ai-chat/AdvancedVisualAgentTab.tsx:3267-3281` |
| **Workflow** | `@xyflow/react` v12 | ✅ xyflow 默认行为 | `rounded-[14px]` + HSL 强调色 + bezier 边 | `prd-admin/src/pages/workflow-agent/WorkflowCanvas.tsx` + `CapsuleNode.tsx` |
| **Emergence** | `@xyflow/react`(沿用 Workflow 模式) | ✅ 同上 | 自定义样式 | `EmergenceCanvas.tsx` |

**根因**:
- VisualAgent 和 Workflow 技术栈不同,**无法直接共享组件**(一个纯 CSS transform + pixel 坐标,一个 React Flow + viewport 坐标)
- CDS 是独立 Node.js 项目,没有引入 React 的构建链,**无法直接 import** prd-admin 里的组件
- 本次(UF-05/06)只做了"手势代码 + 视觉语言"的**表面对齐**,没有提取共享组件

**修复方向**(epic 级,预估 2-3 session):

1. **Phase 1 · 设计 token 抽取**:把卡片圆角、padding、颜色、边连线样式抽成 `canvas-tokens.css`,三处都引用
   - 变量示例:`--canvas-card-radius: 18px` / `--canvas-card-bg: #161a22` / `--canvas-edge-style: stroke-dasharray: 5 4`
   - 优先级:P2 · 规模:S
2. **Phase 2 · 手势代码抽取为 npm 包**:`@prd/canvas-gesture`(或 `cds-canvas-gesture`),导出 `createPanZoomHandlers({ onZoom, onPan })`
   - 三处都调用,保证手势契约一致
   - 优先级:P2 · 规模:M
3. **Phase 3 · CDS 采用 xyflow(或继续维持 SVG)**:评估引入 React Flow UMD 构建到 CDS,让 CDS Topology 和 Workflow 使用同一个渲染器
   - 风险:CDS 打包构建需要改造;xyflow UMD 体积较大
   - 决策分叉:如果 Phase 1+2 已经解决"视觉 + 手势"两个痛点,Phase 3 可能不必做
   - 优先级:P3 · 规模:L

**触发条件**:当 CDS Topology 和另一个画布(Workflow / VisualAgent)再次出现"风格/手势漂移"时启动 Phase 1。

**来源**:用户反馈 + 2026-04-15 跨项目画布 Explore 审计

---

## 4. 汉化缺口（L10N-系列）

> CDS 目标语言是简体中文，除通用技术术语和品牌名外全部汉化。以下是英文/Railway 风格残留热点。

### L10N-01 · Settings 页面英文残留（epic，P1 优先级） · **done** 2026-04-15

**现象**：Settings 页面（`settings.html` + `settings.js`）用户可见文字有 **30+ 条英文残留**，包括 tab 名、区域标题、表单 label、按钮、状态 badge、placeholder。

**规则**：
- **要汉化**：按钮、标题、菜单、提示、表单 label / placeholder、toast、error 消息、对话框
- **不汉化**：通用技术术语（Docker / GitHub / MongoDB / Redis / JSON / HTTP / API / URL / Git / SSH / Dockerfile）、品牌名、shell 输出

**热点文件 + 样本**（前 30 条，按文件定位）：

| 文件 | 行号 | 英文原文 | 位置 | 建议中译 |
|---|---|---|---|---|
| settings.html | 340 | Project Settings | 面包屑 | 项目设置 |
| settings.html | 347 | General | tab 按钮 | 常规 |
| settings.html | 356 | Storage | tab 按钮 | 存储后端 |
| settings.html | 364 | Danger | tab 按钮 | 危险区域 |
| settings.js | 113 | Project Info | 区域标题 | 项目信息 |
| settings.js | 115 | Name | 表单 label | 名称 |
| settings.js | 119 | Description | 表单 label | 描述 |
| settings.js | 120 | Optional description of this project | placeholder | （可选）项目描述 |
| settings.js | 123 | Project ID | 表单 label | 项目 ID |
| settings.js | 132 | Git Repository URL | 表单 label | Git 仓库 URL |
| settings.js | 135 | Update | 按钮 | 保存 |
| settings.js | 139 | Project Stats | 区域标题 | 项目统计 |
| settings.js | 141 | Branches | 数据标签 | 分支数 |
| settings.js | 142 | Created | 数据标签 | 创建于 |
| settings.js | 143 | Updated | 数据标签 | 更新于 |
| settings.js | 144 | Docker network | 数据标签 | Docker 网络 |
| settings.js | 145 | Legacy flag | 数据标签 | 遗留标志 |
| settings.js | 166 | Storage Backend | 区域标题 | 存储后端 |
| settings.js | 181 | Mongo URI | 表单 label | MongoDB URI |
| settings.js | 185 | Database Name | 表单 label | 数据库名 |
| settings.js | 398 | GitHub Integration | 区域标题 | GitHub 集成 |
| settings.js | 418 | Enable Device Flow | 步骤文案 | 启用设备流 |
| settings.js | 437 | NOT CONFIGURED | 状态 badge | 未配置 |
| settings.js | 448 | NOT CONNECTED | 状态 badge | 未连接 |
| settings.js | 474 | CONNECTED | 状态 badge | 已连接 |
| settings.js | 455 | Sign in with GitHub | 按钮 | 使用 GitHub 登录 |

**规模**：预估 50+ 处字符串，约 300 行 diff。**M（中等）**。

---

### L10N-02 · Railway 术语在 app.js 中未本地化(P1) · **done** 2026-04-15

**现象**：CDS 早期抄 Railway 命名，很多术语在 UI 里仍以英文形式出现，即使代码注释/变量已是中文。

| 术语 | 当前状态 | 建议中译 |
|---|---|---|
| Service | 未译，多处 `svc.id` / `infraAction('svc')` | **服务** |
| Build Profile | 部分英文（`app.js` 约 4680 行 template 按钮） | **构建配置** |
| Template | 未译 | **模板** |
| Endpoint | 未译（端口配置区域） | **端点** |
| Infra | 部分英文（`infraId` / `infraDelete()` 函数命名在 UI 里也露出） | **基础设施** 或 **组件** |

**修复方向**：
- 只改用户可见文案（`textContent` / `placeholder` / `title` / button text）
- 不动变量名 / 函数名 / API 路径 / CSS class（那些是内部代号）

**规模**：S-M，分散但每处几行

---

### L10N-03 · projects.html / projects.js 零散英文(P2) · **done** 2026-04-15

**现象**：projects.html 和 projects.js 大部分已汉化，但 "Preview" / "Deploy" 之类按钮文案仍有零散英文硬编码。

**修复方向**：过一遍所有 `textContent` / template literal 里的英文字符串，按规则替换。

---

### L10N 已汉化得好的正面参考（照搬风格）

- `cds/web/index.html` 的分支搜索区：placeholder / title / 模态框标签页全部中文，模态框动态文案用"部署日志 — {id} ({statusLabel})"这种自然拼接
- `cds/web/app.js:2599` 动态文案示范：`` `部署日志 — ${id} (${statusLabel})` ``——动静结合的风格

---

### 汉化 epic 的执行建议

**不要一条一条做**——建议开一个 session 专门刷汉化，按以下顺序：
1. 先过 `settings.js`（30+ 条，L10N-01）
2. 再过 `app.js` 中的 Railway 术语（L10N-02）
3. 最后清 projects 散碎（L10N-03）
4. 提交前肉眼扫所有页面确认无残留

**来源**：Explore agent 3（汉化完整度审计）

---

## 5. 已知限制（LIM-系列）

> 设计权衡导致的限制，不是 bug。是否"修"取决于使用场景。来源：`report.cds-phase-b-e-handoff-2026-04-14.md` §8.1。

### 速览

| ID | 限制 | 影响 | 缓解路径 | 状态 |
|---|---|---|---|---|
| LIM-01 | Mongo 单 collection 单 document（`cds_state.{_id:'state'}` 整存整取） | state > 16MB 时 BSON 拒绝 | 实际 state 通常 < 1MB，超大客户才需拆 collection | deferred（未触发） |
| LIM-02 | GitHub Device Flow 单租户，一个 CDS 实例只存一个 token | 多用户共享 CDS 时谁后登陆谁的 token 生效 | 等 P5 user model + per-user token store | deferred（等 P5） |
| LIM-03 | Repo Picker 只取前 100 个 repos（无分页） | >100 仓库账号看不全 | 加 `Link` header 解析，约 30 行代码 | open（FU-01） |
| LIM-04 | Executor 节点不复用 multi-repo clone，仍用 single `repoRoot` | 不能跨 executor 部署不同仓库 | 需要 P3 改造把 `reposBase` 同步到 executor | deferred（P3 未启动） |
| LIM-05 | Proxy 自动发现仅查 legacy `repoRoot` | `feature.cds.miduo.org` 子域名只能命中默认仓库的分支，新 clone 项目要显式部署 | 设计权衡，显式部署路径不受影响 | wontfix（设计选择） |
| LIM-06 | 多 tab 并发 Device Flow last-write-wins | 两个 tab 同时跑 Device Flow 会 race state.json | 实际场景罕见 | wontfix（已知低概率） |
| LIM-07 | "持久化卷 / Volume" UI 入口被砍 | `+ Add` 菜单不再有该选项 | 卷仍可在 `InfraService.volumes` 字段配置 | deferred（有后门） |

---

### 详细说明

**LIM-01**：Mongo backing store 的设计选择。整个 CDS state 作为一个 BSON document 存一个 collection，换取读写原子性 + 简单代码路径。真实 CDS state 一般 < 1MB，远未到 16MB BSON 限制。如果未来出现大客户 state > 10MB，就需要拆表（`branches` / `projects` / `profiles` 各一个 collection）。**目前无压力**。

**LIM-02**：Phase E Device Flow token 存在 `state.json` 的 `githubDeviceAuth` 字段——单 key 单 value。如果 CDS 被多个开发者共享，第一个人登陆 → 第二个人登陆 → 第一个人的 token 被覆盖。解决方案依赖 P5 的 user model（每个用户自己的 per-user token store），所以这条必须等 P5 启动后才能修。短期缓解：每个开发者开独立 CDS 实例。

**LIM-03**：GitHub API `/user/repos?per_page=100&sort=updated` 只返前 100 条。超过 100 仓库的账号用户体验降级——下拉框看不到自己最老的仓库。修复很小（`Link` header 分页），入 FU-01。

**LIM-04**：G1 多仓库 clone 只在主节点（master）生效，远程 executor 节点仍用 bind-mount 的 single `repoRoot`。意味着如果你把 CDS 集群化，从主节点创建的"新仓库项目"无法调度到其他 executor 节点部署。修复需要 P3 的集群同步机制。

**LIM-05**：Proxy 模块（`feature.cds.miduo.org` 这种子域名路由）启动时扫描 legacy `repoRoot` 的 git refs 自动发现分支，**没扩展到 `.cds-repos/<projectId>/` 下新 clone 的项目**。显式通过 UI 创建分支 + 部署的路径不受影响，只是"零配置自动发现"不跨项目。这是设计选择不是 bug。

**LIM-06**：Device Flow 用 state.json 存 device_code，两个 tab 并发跑会 race。因为 state.json 有原子写保护，不会损坏数据，只是后面的 tab 的 device_code 会覆盖前面的——用户体验上第一个 tab 会拿不到 token。实际很少两个 tab 同时跑授权，标记 known issue。

**LIM-07**：Volume / 持久化卷在 Infra 的 `+ Add` 菜单里被砍了（不知道上一棒什么时候砍的），但 `InfraService.volumes` 字段仍在。后果：想加卷的用户没有 UI 入口，只能手动编辑 state.json 或走 API。建议补回 UI 入口。**可能应该从 deferred 升级到 FU 或 UF**——取决于用户多久才发现。

**来源**：`report.cds-phase-b-e-handoff-2026-04-14.md` §8.1

---

## 6. 后续候选（FU-系列）

> 小工作量的 follow-up，可在任意 session 零散清理。来源：handoff §8.3 + 审计补充。

### 速览

| ID | 标题 | 规模 | 优先级 | 对应限制 |
|---|---|---|---|---|
| FU-01 | Repo Picker 加分页（`Link` header 解析） | S（~30 行） | P2 | LIM-03 |
| FU-02 | `MapAuthStore` 持久化实现替换 `MemoryAuthStore` | M | P2 | — |
| FU-03 | detect-stack 加 nixpacks 风格依赖深度推断 · **done** 2026-04-16 | M | P3 | — |
| FU-04 | worktreeBase 按 projectId 分子目录 | S | P2 | **done** 2026-04-16 |
| FU-05 | GitHub Device Flow token AES 加密后写 state.json | S | P1 | — |
| TEST-01 | Device Flow 持久化失败的 E2E 测试 | S | P1 | UF-01 |
| TEST-02 | Device Flow token 注入 clone 全链路 smoke 测试 | S | P1 | UF-01 |

---

### FU-01 · Repo Picker 加分页 · **done** 2026-04-15

**背景**：LIM-03。当前 `/api/github/repos` 只返前 100 条，大账号用户看不全。

**方案**：解析 GitHub API 响应的 `Link` header，支持 `?page=N`，前端 Repo Picker 加分页控件（或"加载更多"按钮）。

**文件**：`cds/src/routes/github-oauth.ts` 中 `/api/github/repos` 路由 + `cds/web/projects.js` `_openRepoPicker`。

**规模**：~30 行后端 + ~50 行前端。

### FU-02 · MapAuthStore 持久化替换 MemoryAuthStore

**背景**：P2 引入的 `AuthStore` 接口当前只有 `MemoryAuthStore` 实现（进程内存），CDS 重启后所有 session 丢失。handoff 已经设计好了替换路径——只需新增 mongo 后端实现。

**方案**：新增 `cds/src/infra/auth-store/mongo-store.ts`，实现 `AuthStore` 接口，用 `users` + `sessions` 两个 collection。启动时按 `CDS_AUTH_BACKEND=memory|mongo` 环境变量分发。

**注意**：这和 Phase D 的 state backing store 是两套独立系统。Phase D 管 CDS state，这里管用户 session。

### FU-03 · detect-stack 加 nixpacks 风格依赖推断 · **done** 2026-04-16

**背景**：当前 G10 detect-stack 只识别 8 种栈并给出默认 docker image。Railway 用 nixpacks 做更深度的依赖推断（比如检测 `next.config.js` 自动选 Next.js runtime）。

**方案**：给 detect-stack 加"深度检测层"，根据 package.json / requirements.txt / Gemfile 的依赖推断 framework，选更精准的 base image 并给出 `suggestedRunCommand` / `suggestedBuildCommand`。

**交付**：
- `cds/src/services/stack-detector.ts` 新增 `detectFramework()` + `applyFramework()`,在 base detection 之后叠一层;`DetectedFramework` 支持 9 种:`nextjs` / `nestjs` / `express` / `remix` / `vite-react` / `django` / `fastapi` / `flask` / `rails`
- `StackDetection` 新增三个**可选**字段 `framework` / `suggestedRunCommand` / `suggestedBuildCommand`,老调用方零破坏
- 识别优先级:Next.js > NestJS > Remix > Vite+React > Express(确保 Nest 打败 Express,Next 打败 Vite)
- 信号混合:显式 dep 匹配 + `next.config.*` 文件 + `manage.py` 文件 + Gemfile `gem "rails"` 正则
- Python 自己写 requirements 解析(正则抓 `^([a-z0-9][a-z0-9._-]*)`)+ pyproject.toml 子串匹配,**不新增运行时依赖**
- `cds/tests/services/stack-detector.test.ts` +20 条测试(每个 framework 至少 1 条 + 优先级冲突 + 无 framework fallback),19 → 39 条;整仓 574 → 594 通过

**规模**：M。纯 heuristic,无运行时依赖新增。

### FU-04 · worktreeBase 按 projectId 分子目录 · **done** 2026-04-16

**背景**：当前所有项目的 worktree 都在共享 `worktreeBase`，两个项目都用 `master` 分支时会目录冲突。

**方案**：worktree 路径从 `<base>/<slug>` 改为 `<base>/<projectId>/<slug>`。迁移脚本把现有 flat 布局的 worktree 按项目归类到 `default`。

**规模**：S。核心修改在 `WorktreeService`。

**落地实现（2026-04-16）**：
- `WorktreeService.worktreePathFor(base, projectId, slug)` 统一构造路径；`projectId` 缺省回落 `default`。
- 四处调用点全部切换到该 helper：`routes/branches.ts`（创建 + bootstrap）、`executor/routes.ts`、`index.ts` 的 proxy auto-build。
- 启动期一次性迁移 `WorktreeService.migrateFlatLayoutIfNeeded()`：扫描 `worktreeBase` 顶层，把非项目 id 命名的 flat 目录 **symlink** 到 `<base>/default/<slug>`；EPERM/跨设备时回落 `fs.renameSync`。选 symlink 的理由：瞬时、可逆、同 inode（迁移窗口内旧的 bind-mount 不断）。
- 迁移幂等：`state.worktreeLayoutVersion`（新字段）初次设置为 `2`，后续 boot 直接 short-circuit。
- 迁移过程中同步改写每条 `BranchEntry.worktreePath`，避免 `worktreeService.remove()` / `pull()` 指向失效路径。
- 测试：`tests/services/worktree.test.ts` 新增 7 条（25 total）覆盖新路径构造、空 projectId 回落、两项目同名分支不冲突、已迁移状态跳过、base 目录不存在时的 stamp 行为、symlink 迁移 + state 改写、已知 projectId 子目录不会被误判为 legacy slug。`tests/integration/multi-repo-clone.smoke.test.ts` 保持绿色（worktreePath 变成 `<base>/<projectId>/<slug>`，但该测试只检查 `fs.existsSync`）。
- 已知 corner：symlink fallback 到 rename 时，**运行中**的 bind-mount 会短暂指向 stale inode（容器重启后自愈）。Linux 同文件系统下默认走 symlink，所以该 corner 只在 Windows 非开发者模式或跨设备场景出现，生产部署基本不触发。

### FU-05 · Device Flow token AES 加密 · **done** 2026-04-15

**背景**：当前 `state.json` 里的 `githubDeviceAuth.token` 是明文。如果 state.json 被意外提交到 git 或泄漏，token 暴露。

**方案**：启动时读 `CDS_SECRET_KEY` 环境变量（32 字节），用 AES-256-GCM 加密 token 后写 state.json。读时解密。没有 `CDS_SECRET_KEY` 时回退到明文（保留兼容路径）。

**规模**：S。节点自带 `crypto` 库。

### TEST-01 · Device Flow 持久化失败 E2E 测试 · **done** 2026-04-15

**背景**：UF-01 根因是 `setGithubDeviceAuth` 保存失败被静默吞掉。新增测试防回归。

**方案**：`tests/routes/github-oauth.test.ts` 里 mock `StateService.setGithubDeviceAuth()` 抛异常，验证 `device-poll` 返回 `{ status: 'error' }` 而不是假 ready。

### TEST-02 · Device Flow token 注入 clone 全链路 smoke 测试 · **done** 2026-04-15

**背景**：`tests/integration/multi-repo-clone.smoke.test.ts` 当前只测公开仓库 clone。补充私有仓库 + Device Flow token 的端到端路径。

**方案**：mock GitHub OAuth client 返回 token → 调用 `device-poll` → 验证 state 持久化 → 调用 `/api/projects/:id/clone` → 验证 shell 接收的 URL 包含 `x-access-token:`。

**来源**：`report.cds-phase-b-e-handoff-2026-04-14.md` §8.3 + 本次审计补充

---

## 7. 推荐修复优先级 Top-N

> 按"用户阻塞程度 × 修复成本"排序,给下一棒 session 一个可直接按顺序打勾的清单。**不是全部 30 条,而是必须本轮修完的 Top 10**。

### 7.1 修复顺序(推荐)

| # | ID | 标题 | 优先级 | 规模 | 预计耗时 | 依赖 |
|---|---|---|---|---|---|---|
| 1 | **UF-02** | 左下角徽章识别 GitHub Device Flow 用户 | P0 | S | 10 分钟 | 无 |
| 2 | **UF-01** | Device Flow token 持久化失败不静默 | P0 | M | 30 分钟 | 无 |
| 3 | **TEST-01** | 补 Device Flow 持久化 E2E 测试 | P1 | S | 20 分钟 | UF-01 修完 |
| 4 | **TEST-02** | 补 Device Flow → clone 链路 smoke | P1 | S | 20 分钟 | UF-01 修完 |
| 5 | **UF-03** | Topology 画布居中 + 响应式宽度 | P1 | S | 15 分钟 | 无 |
| 6 | **UF-04** | 分支输入框允许手动输入 + 下拉合并 | P1 | S | 20 分钟 | 无 |
| 7 | **GAP-03** | Topology 节点加"环境变量" tab | P1 | M | 30 分钟 | 无 |
| 8 | **GAP-01** | Topology 节点 `⋯` 菜单加"停止/重启"入口 | P1 | M | 30 分钟 | 无 |
| 9 | **GAP-02** | Topology 节点 `⋯` 菜单加"删除分支"入口 | P1 | M | 30 分钟 | 无 |
| 10 | **L10N-01** | Settings 页面 30+ 英文残留汉化 | P1 | S | 20 分钟 | 无 |

**总计预计耗时**:约 4 小时 (适合一次 session 完成)

### 7.2 为什么这样排

| 原则 | 体现 |
|---|---|
| **P0 优先** | UF-01/02 是用户报出的现场故障,先于任何改进 |
| **测试紧跟** | UF-01 修完后立刻补 TEST-01/02,防止再次回归 |
| **先前端后后端** | UF-03/04 和 L10N-01 都是纯前端改动,风险低,可并行审查 |
| **GAP 从高频到低频** | GAP-03(环境变量)、GAP-01(停止/重启)、GAP-02(删除分支)是用户日常操作,优先级高于 GAP-04(路由规则) / GAP-05(部署模式) / GAP-06(集群派发) / GAP-07(标签/备注) |

### 7.3 不在 Top-10 的条目去向

- **GAP-04/05/06/07/08/09**:功能缺口但不阻塞主流程,纳入 P5"Topology 视图增强"专项(或下一棒 handoff)。注意 Top-10 里的 GAP-01/02/03 三条与 §3 epic(GAP-01~07 合并修)有重叠——若下一棒选择一次性做完整个 epic,可以用该 epic 替代 Top-10 第 7/8/9 项
- **L10N-02/03**:小规模汉化,随 L10N-01 一起或下一棒清扫
- **LIM-01~07**:设计权衡,对应到 P5 / P6 大期,不在碎片表修
- **FU-01~05**:上一棒 follow-up 候选,按 handoff 原排序逐个挑走

### 7.4 下一棒 session 开场建议

```
1. 读本表 §7.1 (Top-10)
2. 按 # 顺序逐条打勾,每条 commit 单独写
3. 每完成一条,本表对应条目状态改为 `done` 并附 commit hash
4. Top-10 全部 done 后,回到 §6 处理 FU 候选
5. 结束时尾巴追加新发现事项 → 下一棒继续
```

---

## 8. 更新规则

### 8.1 ID 前缀约定

| 前缀 | 类型 | 例 |
|---|---|---|
| **UF** | 用户可见故障（User-Facing） | UF-01 克隆私有仓库报错 |
| **GAP** | 功能缺失（两个视图不对齐 / 入口缺失） | GAP-01 拓扑缺环境变量 tab |
| **L10N** | 汉化缺口 | L10N-01 Settings 页面英文残留 |
| **LIM** | 已知限制（设计权衡） | LIM-01 Mongo 单 document 16MB |
| **FU** | 后续候选（小工作量） | FU-01 Repo Picker 分页 |
| **TEST** | 测试覆盖缺口 | TEST-01 Device Flow 持久化无 E2E 测试 |

### 8.2 状态机

`open` → `in-progress` → `done` / `deferred` / `wontfix`

- `open`：等待调度
- `in-progress`：当前 session 正在修
- `done`：已修复且有 commit 链接
- `deferred`：延后到某一大期（比如 LIM-02 单租户 token 延后到 P5）
- `wontfix`：明确不修（需写理由）

### 8.3 优先级

- **P0** — 阻塞：用户报出的现场故障，无法绕过
- **P1** — 高：明显影响 UX 的缺失/缺陷，用户能绕过但很难受
- **P2** — 中：需要修但不急
- **P3** — 低：可有可无的改进

### 8.4 追加规则

- 每次 handoff 的尾巴必须把新发现的事项追加到本表
- 新事项需带：根因定位（文件:行号）、现象、修复方向
- 没有根因定位的"模糊抱怨"不进表，先调研再登记

---

## 9. 来源参考

- `doc/report.cds-phase-b-e-handoff-2026-04-14.md`（handoff §8.1 / §8.3）
- 用户会话 `claude/review-handoff-report-updYh` 中的 6 条描述 + 3 张截图
- Explore agent 根因定位（GitHub 认证、Topology 布局、汉化覆盖）
- 本次会话 Grep `TODO|FIXME|XXX` in `cds/src/`：**0 条**（干净）
- 待后续补充：`/human-verify` 和 `/risk-matrix` 专项覆盖审查
