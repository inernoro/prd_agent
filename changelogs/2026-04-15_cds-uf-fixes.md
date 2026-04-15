| fix | cds | UF-01: 修复私有仓库 clone 时 `could not read Username` 英文报错无引导 —— 新增 clone 预检(github.com URL + 未登录 Device Flow 时 UI 警告)、git 错误翻译(映射认证失败为中文可操作提示),并加固 `setGithubDeviceAuth` 通过 mongo 写回 flush 防止持久化静默失败 |
| fix | cds | UF-02: 左下角用户徽章增加 GitHub Device Flow 用户识别 —— `bootstrapMeLabel()` 在 `/api/me` 返回空时降级查 `/api/github/oauth/status`,已完成 Device Flow 的用户会看到 GitHub login 和头像 |
| fix | cds | UF-03: Topology 视图节点自动居中 —— 首次渲染调用 `_topologyFit()` 自适应缩放+居中,用户交互(滚轮/拖拽/缩放按钮)后切入手动模式不再自动修正,"1:1 复位"改为重新居中而非归零 |
| feat | cds | UF-04: 分支选择器支持手动输入/粘贴分支名 —— 按 Enter 直接创建,下拉框底部常驻"+ 手动添加"入口(不依赖 git refs 列表),placeholder 改为"搜索或粘贴分支名,按 Enter 添加" |
| test | cds | 新增 12 条单元测试覆盖 `_isGithubHttpsUrl` + `_mapGitCloneError` 两个新助手函数(projects-url-helpers.test.ts 从 15 增至 27),测试总数 529 → 541 全绿 |
