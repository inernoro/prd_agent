| fix | cds | UF-01: 修复私有仓库 clone 时 `could not read Username` 英文报错无引导 —— 新增 clone 预检(github.com URL + 未登录 Device Flow 时 UI 警告)、git 错误翻译(映射认证失败为中文可操作提示),并加固 `setGithubDeviceAuth` 通过 mongo 写回 flush 防止持久化静默失败 |
| fix | cds | UF-02: 左下角用户徽章增加 GitHub Device Flow 用户识别 —— `bootstrapMeLabel()` 在 `/api/me` 返回空时降级查 `/api/github/oauth/status`,已完成 Device Flow 的用户会看到 GitHub login 和头像 |
| fix | cds | UF-03: Topology 视图节点自动居中 —— 首次渲染调用 `_topologyFit()` 自适应缩放+居中,用户交互(滚轮/拖拽/缩放按钮)后切入手动模式不再自动修正,"1:1 复位"改为重新居中而非归零 |
| feat | cds | UF-04: 分支选择器支持手动输入/粘贴分支名 —— 按 Enter 直接创建,下拉框底部常驻"+ 手动添加"入口(不依赖 git refs 列表),placeholder 改为"搜索或粘贴分支名,按 Enter 添加" |
| test | cds | 新增 12 条单元测试覆盖 `_isGithubHttpsUrl` + `_mapGitCloneError` 两个新助手函数(projects-url-helpers.test.ts 从 15 增至 27),测试总数 529 → 541 全绿 |
| refactor | cds | UF-05: Topology 卡片样式对齐参考图(图1) —— 卡片几何从 236×110 → 280×150,统一圆角 18px,主体只留"图标+名称"和"状态圆点+状态",移除 image/port/deps 三行文字降低视觉密度;infra 服务附加底部 volume 槽(分割线 + 🗄️ + 卷名);连线从三次贝塞尔曲线改为正交 HVH 路径 + 8px 圆角拐点 |
| feat | cds | UF-06: Topology 画布两指手势对齐 Mac 触控板标准 —— wheel 事件按 `ctrlKey/metaKey` 分流,有修饰键(捏合/Ctrl+wheel)走缩放,无修饰键(两指滑动)走平移。手势契约从 `prd-admin/src/pages/ai-chat/AdvancedVisualAgentTab.tsx:3267-3281` 移植,保证 CDS Topology 和 VisualAgent 操作手感一致。缩放公式改为指数平滑 `Math.exp(-deltaY * 0.01)` 不再受触控板 deltaY 绝对值影响 |
| feat | cds | UF-07: Topology 分支选择器替换原生 `<select>` 为自定义 combobox,支持输入/粘贴分支名 Enter 添加,下拉分区展示"已添加/可添加/手动添加",共用列表视图的 `addBranch()` 实现,保证两个视图的添加行为 1:1 一致 |
| feat | cds | UF-08: Topology 顶栏新增"列表 \| 拓扑"segmented control 视图切换 pill,删除 leftnav 中标签为"日志"但实际是视图切换的暗门图标;`setViewMode()` 同步两套 toggle 按钮的 active 状态 |
| feat | cds | GAP-01: Topology Details 面板动作栏加 Stop 按钮,点击调用共享 `stopBranch(id)`,无需切回列表视图就能停容器 |
| feat | cds | GAP-02: Topology Details 面板动作栏加 Delete 按钮,点击调用共享 `removeBranch(id)`(红色强调),无需切回列表视图就能删分支 |
| docs | cds | GAP-03: 确认 Topology Details "Variables" tab 本就在 P4 Part 7 完整实现了,矩阵标 resolved-prior,无代码改动 |
| feat | cds | L10N-01: Settings 页面汉化 30+ 英文残留,覆盖项目基础信息、存储后端、GitHub 集成、危险区四个 tab,按照规则保留 Docker/GitHub/URI 等技术术语不译 |
| test | cds | TEST-01 + TEST-02: 在 `tests/routes/github-oauth.test.ts` 新增两条 UF-01 回归 E2E —— (1) backing store save 抛异常时 device-poll 必须返回 500 不是假 ready,(2) 成功持久化后 `getGithubDeviceAuth()?.token` 能被 clone 路径读到。测试总数 541 → 543 |
