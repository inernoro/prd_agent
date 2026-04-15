| feat | prd-api | 新增 ChangelogController（GET /api/changelog/current-week + /releases），从仓库内的 changelogs/*.md 碎片和 CHANGELOG.md 解析代码级周报，支持 ?force=true 绕过服务端缓存 |
| feat | prd-api | 新增 IChangelogReader / ChangelogReader 服务：解析"| type | module | description |"表格行 + 版本块 + 用户更新项 highlights，本地源 5 分钟 / GitHub 源 24 小时双 TTL 缓存 |
| feat | prd-api | 更新中心数据源双通道：本地优先（dev 模式从 ContentRootPath 向上递归查找 changelogs/）+ GitHub 兜底（生产 Docker 用 Contents API 列目录 + raw.githubusercontent.com 下载内容，1 次 API 请求 + N 次 raw 下载，符合 60/h 匿名限流） |
| feat | prd-admin | 新增「更新中心」页面（/changelog）：本周更新 + 历史发布双区块，带类型/模块筛选 chip、时间轴布局、刷新按钮、数据源徽章（GitHub/本地仓库 + 「N 分钟前拉取」相对时间） |
| feat | prd-admin | 新增顶栏 ChangelogBell（✨ 图标 + 红点徽章 + popover），展示最近 5 条更新，"查看全部"跳转 /changelog；移动端顶栏挂载，桌面端用户头像下拉菜单新增"更新中心"项 |
| feat | prd-admin | 新增 changelogStore (Zustand persist)：lastSeenAt 时间戳持久化到 sessionStorage，selectUnreadCount/selectRecentEntries 选择器；遵守 no-localstorage 规则 |
| feat | prd-admin | 更新中心刷新按钮通过 ?force=true 透传到后端，触发后端缓存绕过 + 重新拉取 GitHub（用户主动刷新时立即看到最新数据） |
| feat | prd-admin | 百宝箱 BUILTIN_TOOLS 注册"更新中心"卡片（带 wip:true 施工中徽章），符合 navigation-registry 规则 |
| fix | prd-api | ChangelogReader 解析 CHANGELOG.md 时跳过 markdown 代码栅栏（``` / ~~~），避免把"维护规则"章节里的 ## [1.7.0] / ## [未发布] 文档示例当成真版本头解析（CDS 验证发现） |
| chore | .claude/rules | 新增 cds-first-verification.md 规则：本地无 SDK ≠ 无法验证，必须用 /cds-deploy 兜底，禁止把验证负担转嫁给用户 |
| feat | prd-admin | 首页 AgentLauncher 顶部快捷区从 3 张扩展为 4 张，新增「更新中心」卡片（带未读徽章），用 /home Hero 同款青/橙渐变 + 右上角光晕 + hover 辉光边框，层次感和点击预期显著增强 |
| refactor | prd-admin | 首页 Hero 重写：新增 eyebrow 标签（MAP · 米多智能体生态平台）、标题放大到 34px、用户名应用 /home Hero 的青→紫→玫红渐变、背景加 aurora 光晕，解决"缺乏层次感"问题 |
| refactor | prd-admin | 首页 section 标题统一为 SectionHeader 组件：eyebrow（大写标签）+ 主标题（18px）+ subtitle（描述文案）+ accent 渐变短横，取代原先 11px 灰色 uppercase 单行标签，引导感更强 |
| refactor | prd-admin | 用户头像下拉菜单大扫除：删除「修改头像」（与账户管理合并）+ 删除动态 menuCatalog 面板（网页托管/知识库/涌现/提示词/实验室/自动化/快捷指令/PR审查/请求日志等），只保留账户/系统通知/更新中心/数据分享/提交缺陷/退出 |
| feat | prd-admin | 首页实用工具区新增 4 个权限门控条目：提示词管理（prompts.read）、实验室（lab.read）、自动化规则（automations.manage）、请求日志（logs.read），承接从用户菜单迁出的工具类导航 |
| feat | prd-admin | 首页新增 HomeAmbientBackdrop 环境光层：3 个巨大 radial-gradient 色块（紫/青/玫红 8% 透明度 + blur 60px）+ 顶部 50vh 白色椭圆聚光 2.5% + 全局 SVG feTurbulence film grain 3% opacity mix-blend overlay，解决"首页阴沉死黑、缺乏透气感"问题（纯 CSS，0 JS，0 动画） |
| feat | prd-admin | 首页 AgentLauncher 新增进场动效：复用 /home Reveal 组件但 duration 减半到 1000ms（2x 快），按视线顺序编排 — Hero eyebrow→标题→subtitle→search (0/50/100/150ms) → 4 张快捷卡 50ms cascade → AGENTS section header (430ms) → Agent 卡片 35ms cascade → UTILITIES (800ms) → Utility 卡片 25ms cascade → SHOWCASE (滚到视口触发)，总长 ~1800ms |
| feat | prd-admin | 新增 NavigationProgressBar 顶栏路由切换进度条：解决 dev 模式下点击侧栏导航后 Suspense fallback 被 React 18 transition 语义吞掉导致的"卡住 2 秒无反应"问题。通过 useLocation 监听路由变化（不依赖 Suspense），location 变更瞬间立刻显示 3px 高渐变条（青→紫→玫红 + glow），爬升曲线 15%→40%→60%→80%→90%（总计 2s 爬到 90% 卡住），requestIdleCallback 检测浏览器空闲时完成到 100% 并淡出，4s 超时兜底。mount 在 App.tsx 根部，全局生效 |
| fix | prd-admin | NavigationProgressBar 根因修复：useLocation() 在 React Router v6 非 data router 模式下受 React 18 transition 语义影响，navigate() 时新 location 被 hold 直到 lazy import 完成，导致 useEffect 根本没在 t=0 fire。改为 monkey-patch window.history.pushState / replaceState 在原生 API 层拦截，dispatch 'map:navstart' 自定义事件，进度条监听该事件 —— 早于 React 任何 render 逻辑获得信号，修复"进度条落后于页面加载"的时序问题 |
| fix | prd-admin | NavigationProgressBar 两个视觉 bug 修复：(1) requestIdleCallback 在 React hold transition 期间浏览器空闲立刻 fire 导致 finish() 过早触发 → 增加 MIN_DURATION=1500ms 硬下限，idleReceived + minReached 双条件才真 finish；(2) 完成后 setProgress(0) 重置触发 width 反向动画在 opacity 淡出期间可见 → 完成后停在 100% 永不反向，下次 navstart 时用 animating=false 瞬时 snap 到 0%（在 opacity 为 0 时不可见）。修复"一瞬间过去然后退回来"的诡异动画 |
| refactor | prd-admin | 全量迁移老式加载指示器到 @/components/ui/VideoLoader 统一组件体系：30 个文件批处理，16 处 block-level（原先是 flex-center 容器 + MapSpinner/Loader2 + "加载中..."文案）统一替换为 MapSectionLoader（展示 MAP 品牌字母扫光动效），28 处 inline（按钮/行内 icon）从 lucide-react Loader2 统一替换为 MapSpinner；清理 16 个残留的 Loader2 import。涉及工作流（WorkflowAgentPage 等 3 个）、技能创建助手（SkillAgentPage 12 处）、PR 审查（7 个文件）、评审 Agent（3 个）、涌现探索、智识殿堂、LLM 日志、数据管理、转录工作台、百宝箱直连对话等 |
