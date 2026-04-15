| fix | cds | UF-01: 修复私有仓库 clone 时 `could not read Username` 英文报错无引导 —— 新增 clone 预检(github.com URL + 未登录 Device Flow 时 UI 警告)、git 错误翻译(映射认证失败为中文可操作提示),并加固 `setGithubDeviceAuth` 通过 mongo 写回 flush 防止持久化静默失败 |
| fix | cds | UF-02: 左下角用户徽章增加 GitHub Device Flow 用户识别 —— `bootstrapMeLabel()` 在 `/api/me` 返回空时降级查 `/api/github/oauth/status`,已完成 Device Flow 的用户会看到 GitHub login 和头像 |
| fix | cds | UF-03: Topology 视图节点自动居中 —— 首次渲染调用 `_topologyFit()` 自适应缩放+居中,用户交互(滚轮/拖拽/缩放按钮)后切入手动模式不再自动修正,"1:1 复位"改为重新居中而非归零 |
| feat | cds | UF-04: 分支选择器支持手动输入/粘贴分支名 —— 按 Enter 直接创建,下拉框底部常驻"+ 手动添加"入口(不依赖 git refs 列表),placeholder 改为"搜索或粘贴分支名,按 Enter 添加" |
| test | cds | 新增 12 条单元测试覆盖 `_isGithubHttpsUrl` + `_mapGitCloneError` 两个新助手函数(projects-url-helpers.test.ts 从 15 增至 27),测试总数 529 → 541 全绿 |
| refactor | cds | UF-05: Topology 卡片样式对齐参考图(图1) —— 卡片几何从 236×110 → 280×150,统一圆角 18px,主体只留"图标+名称"和"状态圆点+状态",移除 image/port/deps 三行文字降低视觉密度;infra 服务附加底部 volume 槽(分割线 + 🗄️ + 卷名);连线从三次贝塞尔曲线改为正交 HVH 路径 + 8px 圆角拐点 |
| feat | cds | UF-06: Topology 画布两指手势对齐 Mac 触控板标准 —— wheel 事件按 `ctrlKey/metaKey` 分流,有修饰键(捏合/Ctrl+wheel)走缩放,无修饰键(两指滑动)走平移。手势契约从 `prd-admin/src/pages/ai-chat/AdvancedVisualAgentTab.tsx:3267-3281` 移植,保证 CDS Topology 和 VisualAgent 操作手感一致。缩放公式改为指数平滑 `Math.exp(-deltaY * 0.01)` 不再受触控板 deltaY 绝对值影响 |
