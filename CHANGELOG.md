# 更新记录

> 记录 PRD Agent 全栈项目的所有变更。版本发布时自动插入版本标记行。
>
> **格式规范**：见底部 [维护规则](#维护规则)。

---

## [未发布]

### 2026-04-20

| 类型 | 模块 | 描述 |
|------|------|------|
| feat | prd-api | ChangelogReader 拉取 CHANGELOG.md 的 GitHub commit 历史（单次 commits API 调用），按日期聚合，给每个 day 块附上该日最晚一次 commit 的秒级 UTC 时间 |
| feat | prd-api | ChangelogDayDto 新增 commitTimeUtc 字段（ISO 8601），供前端渲染秒级时间 |
| perf | prd-admin | 筛选 chip 增加图标（feat→Sparkles、fix→Wrench、perf→Gauge 等 11 类），条目内模块/类型徽章同步带 icon 更易识别 |
| perf | prd-admin | 条目右侧时间升级为 "YYYY-MM-DD HH:mm:ss"（基于 GitHub commit 时间，tabular-nums 等宽），降级到纯日期时保留 tooltip 说明 |
| perf | prd-admin | 更新中心历史发布行字号放大：类型徽章 12px、模块胶囊 12px tabular-nums、日期头 13px 胶囊化；条目右侧新增提交日期（tabular-nums）；描述过长 truncate 不再挤掉右侧时间 |
| feat | prd-api | 新增 ChangelogReportSource 模型 + changelog_report_sources 集合 + /api/changelog/sources CRUD API，周报来源配置全员共享 |
| feat | prd-admin | 周报 tab 重构为多来源模型：支持全员添加/编辑/删除，从数据库加载，替代原来只在 sessionStorage 里每人各自保存的设置 |
| feat | prd-admin | 新增 MermaidDiagram 组件（懒加载 mermaid 主包），MarkdownContent 对 mermaid 代码块自动渲染图表，不再暴露源码 |
| refactor | prd-admin | 更新中心移除「本周更新」冗余 section，保留历史发布；周报改由「map周报」tab 承载 |
| perf | prd-admin | 周报来源选择采用 chip 栏 + hover 内联编辑/删除，视觉与 Surface System 对齐 |

### 2026-04-19

| 类型 | 模块 | 描述 |
|------|------|------|
| chore | rules | 新增 `.claude/rules/cds-auto-deploy.md` — 明确 push 即部署的知识: 对已 link GitHub 的项目不再提示用户手动跑 `/cds-deploy-pipeline`,交付文案用"commit 已推送,CDS 收到 webhook 后几分钟内 `<url>` 就位"替代旧的"需要真人在预览域名验收(我这边无法)"。`CLAUDE.md` 架构规则索引同步补一行;`codebase-snapshot.md` 追加 PR #450 后状态条目 |
| feat | cds | 分支卡标题 icon 按来源区分: 手工添加分支走原 git-branch icon,GitHub webhook 自动触发的分支(`branch.githubRepoFullName` 非空)走 GitHub Octocat icon,tooltip 注明"来自 <org/repo>",一眼分辨"手工加 vs 自动建"。commit SHA chip 去掉重复的 GitHub logo 变纯 hash(tooltip 仍然标注来源),避免两处重复 |
| feat | cds | 新增 `ICON.githubMark` 到 app.js ICON 注册表 + `.branch-name svg.gh-branch-mark` CSS (dark / light 两版颜色) — 紫色调提示"GitHub 源"并与普通分支保持一致占位宽度,标题行布局不抖 |
| fix | cds | Bugbot #450 第六轮 LOW: handleCheckRun 补 head_sha 格式校验(与 handlePush 一致) — malformed SHA 在 updateBranchGithubMeta + .slice() 路径会炸 |
| feat | cds | 分支卡片 chip 布局重构 — github chip(去 "from GitHub" 文字只留图标+7位 SHA)、端口 chips、pinned 历史提交 chip 合并到同一行 branch-card-chips flex wrap,所有分支卡片高度/结构从此一致 |
| feat | cds | 分支列表页改用 CSS column-count 瀑布流布局,消除网格行高对齐造成的视觉空洞(不同卡片 tag/徽章数量差异导致的断层) |
| fix | cds | 项目列表卡片 GitHub chip 渲染为大蓝圆修复: 原本是 `<a>` 嵌套在 `<a class="cds-project-card">` 里 (HTML 非法),浏览器自动关外层 `<a>` 导致布局崩。改用 `<span onclick>` 打开新窗口 |
| fix | cds | 高危: webhook branchName 和 commitSha 接入 shell 前强制校验(HIGH + MEDIUM) — isSafeGitRef 严格白名单 `[A-Za-z0-9._/-]` + 长度/`..`/尾字符检查;commit SHA 必须 7-40 hex。覆盖 push/PR/delete/self-update/self-force-sync 5 个注入面 |
| fix | cds | defaultLocalhostDeploy 把 commitSha 透传到 /deploy body (MEDIUM),并行 push 之间的 entry.githubCommitSha 竞态因此消除。deploy 路由按「body → entry → worktree HEAD」三级回退 |
| fix | cds | 删 shouldDispatchDeploy / renderGithubBadge 两个死代码(LOW),清理重复注释 |
| feat | cds | CheckRunRunner.reconcileOrphans(): CDS 启动时扫描所有带 checkRunId 但不在 building 的分支,PATCH 到 conclusion=neutral + 清 id,修复 self-update/restart 打断后 GitHub commit 常年「准备状态」的 bug |
| feat | cds | 新增 POST /api/github/webhook/self-test 自测端点: 传 {eventName, payload} 直跑 dispatcher,返回「如果真实 webhook 这么来」会触发什么 side-effect。用于确认 Issue comment 事件是不是真到达 CDS,无需 GitHub 真实发送 |
| feat | cds | 项目 Settings → GitHub 标签页新增"GitHub 自动部署 (Check Runs)"区块:可视化展示 App 配置状态、一键跳转 GitHub 安装/管理、当前项目绑定卡片、自动部署开关 |
| feat | cds | 「绑定 GitHub 仓库」引导式 modal:选 installation → 选仓库 → autoDeploy checkbox → 确认绑定,全程无 curl |
| feat | cds | 项目列表卡片为已绑定项目追加 GitHub badge(仓库名 + 绿色/灰色表示 autoDeploy 开关),点击直达 github.com |
| feat | cds | 分支卡片加"from GitHub <sha7>"徽标,点击跳 commit 页面,让 webhook 触发的分支一眼可辨 |
| feat | cds | Check run 阶段性 PATCH: pull/每层 layer 启动时推送进度到 GitHub, PR Checks 面板实时显示"构建第 X/Y 层 (services...)"而不是全程一条不变的"Deploying to CDS…" |
| feat | cds | Check run finalize 注入 output.text 日志尾部: 部署最后 80 条事件拼成 markdown code block,GitHub Checks 面板「Show more」展开后可直接看失败原因,不用再切回 CDS |
| feat | cds | pull_request.opened/reopened 事件 → bot 自动在 PR 贴 Railway 风格预览地址评论(📋 Preview / Branch / Dashboard 三项 + 分支 SHA),后续 push 触发的 deploy 会原地 PATCH 同条评论,不污染 PR 时间线 |
| feat | cds | pull_request.closed (merged or not) 事件 → 自动 POST /api/branches/:id/stop 停掉预览容器,节省资源 |
| feat | cds | GitHubAppClient 新增 createIssueComment + updateIssueComment 方法(PR comments 走 issues API) |
| feat | cds | BranchEntry 加 githubPrNumber + githubPreviewCommentId 两字段,让 webhook dispatcher 能关联 PR + 复用 bot 评论 id |
| feat | cds | PR 评论 slash 命令:`/cds redeploy` 强制重部署、`/cds stop` 停预览容器、`/cds logs` 回复最近 40 条部署日志、`/cds help` 显示帮助,所有命令 bot 自动回复确认 |
| feat | cds | GitHub 删分支(delete 事件) → CDS 自动 POST /branches/:id/stop 清理对应预览容器,防止孤儿 |
| feat | cds | GitHub repo 被重命名/转移/删除(repository 事件) → 自动解绑 Project 的 github 链接,避免 webhook 打到错的项目 |
| feat | cds | release 事件 acknowledged(占位实现,为未来 release tag → 生产部署预留钩子) |
| feat | cds | dispatcher +19 测试用例(slash 命令 8 条、delete 3 条、repository 3 条、release 1 条)覆盖 |
| feat | cds | 新增预览就绪探测（TCP + HTTP）与分支 `restarting` 状态；容器存活但未监听端口时不再暴露 502，而是持续展示友好等待页直到真正就绪 |
| feat | cds | proxy 层扩大等待页覆盖：building / starting / restarting / 无可用 upstream / ECONNREFUSED 均返回 503 + Retry-After 的友好等待 HTML，前端 2s 自动刷新 |
| feat | cds | nginx 增加 `error_page 502 504 @cds_waiting` 兜底：CDS master 不可达（自升级、崩溃）时回落到 `www/cds-waiting.html` 静态等待页，彻底消除 Cloudflare 502 |
| feat | cds | 已删除分支访问友好页：预览子域名命中本地 + 远端都找不到的分支时，短路显示"预览已下线"404 HTML 页，含活跃分支列表和 15 秒自动返回控制台 |
| feat | cds | `ContainerService.restartServiceInPlace` 支持热重启（docker restart 保留容器），为后续 pull + restart 热加载链路预留入口 |
| fix | cds | 部署流水线在容器存活后进入 `starting`，通过 readiness 探测再转 `running`；探测超时标记 `error` 而非假装成功 |
| style | cds | Dashboard 分支卡片统一配色：非活跃卡片（idle/stopped/error）的端口徽章与技术栈图标转黑白；摒弃蓝色 — 技术栈 SVG 改用 currentColor 继承徽章状态色，port-building 与 status-dot-building 从蓝色改为主题琥珀色；GitHub 标志保留专属视觉 |
| feat | cds | Project 新增 aliasName / aliasSlug 两个可选字段; Settings → 基础信息 新增「显示别名」输入框,项目卡片 / 面包屑 / 删除确认 / Agent Key 签发弹窗全部走 aliasName \|\| name,用于解决「legacy 默认项目 name='prd-agent' 但用户希望显示别的」的显示困扰,不改 id / slug / 分支 id 前缀 |
| feat | cds | PUT /api/projects/:id 接受 aliasName (≤60 字符,空串清除) + aliasSlug (走 SLUG_REGEX,不能等于项目原 slug / 不能与其它 project slug / aliasSlug 冲突,空串清除); aliasSlug 当前仅存储,暂不影响分支 id 前缀,后续 PR 再做可选的 new-branch-prefix 开关 |
| test | cds | projects.test.ts 新增 6 个用例覆盖 alias 接受 / 清除 / 长度 / slug 正则 / 自 slug 冲突 / 跨项目 slug 冲突场景 |
| feat | cds | 新增 POST /api/self-force-sync 自愈端点: git fetch + reset --hard origin/<branch> + 清 dist/.build-sha + 重启,彻底解决本地 git 分叉导致 self-update pull merge 丢远端改动的问题 |
| feat | cds | 项目 Settings → 危险区新增「强制同步 CDS 源码到 origin」卡片: 输入分支名 + 确认 + SSE 实时进度,再也不用 SSH 到服务器敲 git reset |
| fix | cds | self-update 改用 `git reset --hard origin/<branch>` 代替 `git pull`,避免本地分叉时生成 merge commit 静默丢失远端文件变更(实测 settings.js 436 行新增被 merge 策略吞掉导致 UI 不生效) |
| fix | cds | 白天模式「+ 新建项目」按钮背景缺失 —— 选择器从 `.btn-primary-solid` 升级为 `button.btn-primary-solid`,让它与 `[data-theme="light"] button`(specificity 0,1,1) 平局,靠后声明顺序胜出;同时为描边加 1px accent 边框,悬浮色不再被全局 button:hover 盖掉 |
| fix | cds | 分支列表桌面端塌成单列 —— `.branch-list` 的 `display:flex` 让 CSS `column-count:3` 被完全忽略;`@media (min-width:768px)` 内显式翻回 `display:block` + `gap:0`,三/四列流式布局恢复 |
| fix | cds | 分支页顶部 `.view-mode-toggle` 比相邻 icon 按钮高半圈 —— 去掉遗留的 `margin:0 0 10px`,加 `min-height:36px` 对齐 `.icon-btn` 尺寸,整行 header-actions 共享同一条基线 |
| feat | cds | 分支页 ⚙ 菜单补回 6 条被移出去的快捷项(批量编辑环境变量 / 初始化配置 / 预览模式切换 / 镜像加速 / 浏览器标签名 / CDS 自动更新)+ 一键导出配置,并新增「快捷 · CDS 全局开关」分组标签(`.settings-menu-group-label`) —— 让用户在分支页也能触达高频操作,不必每次跳去项目列表 |
| feat | cds | 分支卡 port-badge 改用「语言/框架 icon + 端口号」—— 新增 portNode/portDotnet/portPython/portRust/portGo/portReact/portVue/portDb 语言图标;`detectPortIconKey(profile)` 从 dockerImage/command/id 推断(react > node / dotnet > net / mongo > go);隐藏 `api:` `admin:` 文字,profile 名字只保留在 tooltip(hover 显示) |
| test | cds | Project 别名 PUT 用例新增 6 条(验证 aliasName/aliasSlug 接受 / 清空 / 长度 / 正则 / 自 slug 冲突 / 跨项目 slug 冲突场景),738/738 通过 |
| chore | ci | `.github/workflows/ci.yml` 新增 cds-build job 并纳入 ci-status 聚合门禁 —— Phase 1 单一绿勾覆盖 server + admin + desktop + cds 四个子系统(CDS 仍保留独立 cds.yml 以保持操作员熟悉度,允许微量重复执行换取统一门禁) |
| fix | cds | GitHub webhook 收到非订阅事件(check_suite / workflow_run / pull_request_review / status / star 等)时直接 200 确认并跳过 dispatcher,响应头 X-CDS-Suppress-Activity=1 让 Dashboard 活动流不再被噪声事件淹没 |
| fix | cds | dispatcher 抛错时 webhook 返回 200 (ok:false) 而不是 500,阻止 GitHub 按 8 小时策略重投递触发反复构建;错误仍在服务端日志记录 |
| fix | cds | 同一 (branchId, commitSha) 30 秒内重复 dispatch 自动去重,避免 push + check_run.rerequested + 延迟重投等多路径同 SHA 连续触发两次构建把第一次刚起的容器撕掉 |
| feat | cds | Dashboard 活动流的 GitHub webhook 条目追加事件名标签(如 "GitHub 推送 Webhook · push" / "· check_run" / "· issue_comment"),一眼分辨不同事件类型 |
| docs | doc | 新增 guide.cds-github-webhook-events.md:列出 CDS 必订的 7 个事件(push / pull_request / issue_comment / check_run / installation_repositories / delete / repository)、可选事件(ping / installation / release)、被静默过滤的噪声事件清单(check_suite / workflow_run / pull_request_review 等 20+ 种),以及 GitHub App 后台订阅配置步骤、self-test 验证方法、新增订阅 checklist |
| fix | cds | 删除分支卡 GitHub commit SHA 胶囊(蓝色 7 位 hash): 用户反馈冗余,标题前的 GitHub icon 已经说明来源,commit hash 对运维体验没增加信息,chips row 的视觉空间让给 ports / 时间戳 |
| fix | prd-admin | 修复周报详情页「已阅」浏览记录弹窗样式错乱：改用 createPortal 挂到 body，布局关键尺寸走 inline style，滚动容器补 min-height:0 + overscrollBehavior:contain，新增 ESC 与遮罩点击关闭 |
| fix | prd-admin | 加强周报浏览记录弹窗边界感：硬编码不透明深灰底色 + backdrop-blur(20px) + 强阴影 + 半透明 scrim 遮罩，列表项加细边框与 hover 高亮，header 加分隔线 |
| feat | cds | 新增 `branch-events.ts` 进程级事件总线 (EventEmitter 单例) + 5 种事件类型 (branch.created / status / updated / removed / deploy-step),让 webhook dispatcher + deploy 流 + 手工添加 三条独立路径统一推"分支状态变了"这件事,前端通过 SSE 一条管道消费 |
| feat | cds | 新增 `GET /api/branches/stream` SSE 端点: 订阅时先推一次 snapshot (初始全量, 支持 ?project= 过滤),之后实时推 branchEvents 总线上的每条事件;10s keepalive 心跳;客户端断开自动 off 监听器不泄漏 |
| feat | cds | github-webhook-dispatcher 在 push 事件处理流末尾 emit branch.created / branch.updated,让 Dashboard 打开时能亲眼看到 GitHub push 自动创建的分支出现 |
| feat | cds | branches.ts 部署流程在状态转换点 (building 入口 + 结束时 running/error/starting) + 删除路径 + 手工创建路径 emit 对应事件,和自动触发路径统一走同一总线 |
| feat | cds | 前端 state-stream 处理扩展: 首次见到的分支 id 进 `freshlyArrived` set,renderBranches 给卡片追加 `.fresh-arrival` + (GitHub 来源时)`.fresh-gh` class;5 秒后自动清除,下次重绘回到普通卡片 |
| feat | cds | 新增 `@keyframes cds-card-arrival` (translateY + scale + opacity 滑入) + `cds-card-gh-pulse` (紫色外发光脉冲 x3),叠加勾勒出"GitHub 刚给你建的分支"视觉。遵守 prefers-reduced-motion,无动画用户不触发 |
| test | cds | 新增 tests/routes/branches-stream.test.ts 4 个用例:snapshot 事件 + branch.created 事件路由 + ?project 过滤 + 客户端断开监听器清理(防内存泄漏)。753/753 全绿 |
| feat | scripts | 新增 Phase 2 冒烟测试套件 (scripts/smoke-lib.sh + smoke-health.sh + smoke-prd-agent.sh + smoke-defect-agent.sh + smoke-report-agent.sh + smoke-all.sh) —— 部署后几十秒验证 Health/鉴权 + PRD 会话 Run + 缺陷 CRUD + 周报 CRUD 链路,用 X-AI-Access-Key + X-AI-Impersonate 真实 curl 打 CDS 预览域名,每个子脚本 best-effort 清理自己的测试数据 |
| feat | ci | `.github/workflows/ci.yml` 新增 `smoke-preview` job (workflow_dispatch 手动触发),入参 smoke_host + smoke_skip,走 repo secret AI_ACCESS_KEY 鉴权;Phase 3 再挪到 /cds-deploy 完成 hook 里自动触发 |
| docs | doc | 新增 doc/guide.smoke-tests.md 说明文件清单 / 环境变量 / CI 集成 / 扩展新 Agent 的模板,作为 Phase 2 交接文档 |
| feat | cds | 新增 POST /api/branches/:id/smoke SSE 端点,CDS 就地触发 scripts/smoke-all.sh 跑针对本分支预览域名(https://<branch>.<rootDomain>) 的冒烟测试;AI_ACCESS_KEY 支持 body 传入或从 _global.customEnv 回落,脚本目录走 CDS_SMOKE_SCRIPT_DIR env override;stdout/stderr 每行推 SSE `line` 事件,`complete` 带 exitCode + 耗时 + 通过/失败计数 |
| feat | cds | 分支卡 deploy 下拉菜单(isRunning 时可见)新增「🍳 冒烟测试」项,点开弹出 60vh 流式输出弹窗,SSE 逐行渲染绿/红色,头部显示"✅ 通过 3 项 · 12s"或"❌ 失败 N / 通过 M"汇总;关闭即 abort 当前流(但后端 bash 进程继续跑到结束,遵循 server-authority) |
| test | cds | 新增 tests/routes/branches-smoke.test.ts 6 个用例: 404 / 缺 preview / 缺 key / fallback _global / 缺 script / SSE 流 + 计数抽取,744/744 通过 |
| feat | cds | Project 新增 `autoSmokeEnabled` 字段 + PUT /api/projects/:id 接受布尔值,Settings → 基础信息里新增「部署成功后自动冒烟测试」开关;默认关闭,开启后每次 deploy 成功都会在同条 SSE 流里跑完 scripts/smoke-all.sh(Phase 4) |
| feat | cds | 重构: `runSmokeForBranch(opts)` + `resolveSmokeScriptDir()` 提取为 branches.ts 顶层导出的纯函数,Phase 3 手动端点和 Phase 4 自动 hook 共用同一套 spawn + 计数解析逻辑,避免重复 60 行子进程管理代码 |
| feat | cds | branches.ts 部署 handler 在 deploy `complete` 之后、GitHub check-run finalize 之前调 `maybeRunAutoSmoke(...)`: 仅当 project.autoSmokeEnabled=true + previewDomain 配置 + _global.AI_ACCESS_KEY 存在 + smoke-all.sh 可定位四条全满足才跑;其它情况推一条 `smoke-skip` 事件,不阻断部署(Phase 4) |
| feat | cds | 自动冒烟事件以 `smoke-start` / `smoke-line` / `smoke-skip` / `smoke-complete` 推给 deploy SSE 同一条流,前端 app.js 的 deployBranchDirect 新增 currentEvent 解析,把冒烟日志用 🍳 前缀 + `│` 缩进渲染进 inline deploy log,操作员一个视图看到"部署 → 冒烟"完整叙事 |
| feat | cds | GitHub Check Run finalize 融合冒烟结果(Phase 5): conclusion = hasError \|\| smokeFailed ? 'failure' : 'success'; summary 追加 `冒烟 ✅/❌ pass=N fail=M (Xs)` 字段,PR 的 Checks 面板直接反映"部署绿但冒烟红"这类高价值信号 |
| test | cds | 新增 Phase 4/5 单测:projects.test.ts 增 2 条(autoSmokeEnabled 持久化 + 显式设 false);branches-smoke.test.ts 增 2 条(runSmokeForBranch helper 的 env 透传 + resolveSmokeScriptDir 缺脚本检测)。748/748 全绿 |
| feat | e2e | 新增 Playwright E2E 目录 (e2e/) 作为测试金字塔顶层: package.json + playwright.config.ts + tsconfig + utils/auth.ts,覆盖 7 条规格 3 UI 冒烟 (登录页无 console.error / 根路径 2xx / 静态资源就位) + 4 CDS Dashboard 回归保护(白天模式新建项目按钮 accent 背景 / 桌面分支列表 column-count ≥ 2 / toggle 与 icon 按钮同高 / ⚙ 菜单含关键项) |
| feat | ci | ci.yml 新增 e2e-preview job + workflow_dispatch 入参 e2e_base_url,缓存 Playwright 浏览器,失败自动上传 HTML report + JSON results 到 artifacts(保留 14 天);和 Phase 2/3 的 smoke-preview job 并行独立,UI 崩 vs API 崩 一目了然 |
| docs | doc | 新增 doc/guide.e2e-tests.md:目录结构 / 本地运行命令 / headed / UI 模式 / 失败复盘 / CI 集成 / 写新 spec 模板 / 扩展方向(agent-flow / defect-flow / 跨浏览器 / 视觉回归) |
| fix | cds | CDS 系统更新弹窗下拉框被外层 overflow 裁切 —— dropdown 改用 position:fixed + JS 跟随 input.getBoundingClientRect 定位,挂到 document.body (portal),完全脱离 modal body 的滚动容器,下拉不再被剪。scroll/resize 触发 rAF 节流重定位;close 时同步移除 portal DOM 避免残留 |
| fix | cds | 分支列表栏布局从 CSS `column-count` 多列改为 CSS Grid auto-fill (minmax(340px, 1fr)) —— 旧 column 布局在窗口中等大时产生列间竖向空柱 (image 2 红框),宽屏下卡片 top-bottom-left-right 流动看起来乱 (image 3)。Grid auto-fill 让每行卡片等高对齐,无空柱无错位,窗口缩放自动增减列 |
| feat | cds | 分支卡片右上角新增"最近更新"时间戳: 胶囊样式 margin-left:auto 推到 chips row 末端,优先显示 lastAccessedAt (最近部署时间),缺失时 fallback 到 createdAt 并后缀"创建"二字。调用现有 relativeTime() 辅助,中文输出"刚刚 / N 分钟前 / N 小时前 / N 天前",tooltip 显示完整本地时间。窗口窄时 flex-wrap 折行仍保持右对齐 |
| docs | rules | `.claude/rules/bridge-ops.md` 头部补一张端点 URL 表,明确 `POST /api/bridge/command/:branchId` 的 branchId 必须在 URL path 不在 body —— 旧版知识提到的 `POST /api/bridge/command` (无 :branchId) 是 404 根因。附正反示例 curl,AI Agent 下次遇到 "Cannot POST /api/bridge/..." 能第一时间对表排查 |
| test | e2e | Playwright cds-dashboard 规格从 column-count 断言改为 grid-template-columns track count 断言,匹配新的 Grid 布局 |
| refactor | cds | 合并两套 CDS 系统更新弹窗 —— 新增 cds/web/self-update.js 统一模块,`window.openSelfUpdateModal()` 由 index.html 和 project-list.html 共同加载;app.js `openSelfUpdate()` 和 projects.js `cdsOpenSelfUpdate()` 都退化为 1 行 thin wrapper 调 window 入口,齿轮菜单 / topology popover / cmd-k / 项目列表设置下拉 4 个入口收敛到同一条路径 |
| feat | cds | 统一弹窗汇集两套旧版本的优点: 组合框(可搜索 + 粘贴, 原 app.js 版) + 强制同步 hard-reset 按钮(原 projects.js 版) + 粘性底部工具栏(修复 image 1 底部按钮被截断的问题) + 健康检查轮询(CDS 重启后自动 reload) |
| feat | cds | 分支列表页 header 新增独立 🔄 按钮 (#selfUpdateBtn),点击直接打开统一系统更新弹窗 —— 对应用户反馈"原来有,后来在设置里面被删除掉了"(8f85488 删的 header shortcut 恢复),齿轮菜单里的入口同步保留以兼容肌肉记忆 |
| chore | cds | 清理遗留的 openComboDropdown / filterComboItems / selectComboItem / executeSelfUpdate 等只服务于旧 self-update 弹窗的辅助函数为空壳 retire stub,防止缓存客户端残留 onclick 触发 ReferenceError |
| feat | prd-api | 视频 Agent 分镜模式新增 PRD 输入源：CreateVideoGenRunRequest 扩展 inputSourceType + attachmentIds 字段，空 articleMarkdown 时自动从附件 ExtractedText 拼接 markdown |
| feat | prd-api | VideoGenRunWorker Scripting 阶段针对 PRD 输入使用专用 prompt（痛点→方案→功能演示→收益 8-12 镜结构），与技术文章拆分镜模板区分 |
| feat | prd-admin | 视频 Agent 分镜模式输入区新增双通道：Markdown 文章 / PRD 文档，PRD 模式支持 PDF/Word/Markdown 多文件上传，经 /api/v1/attachments 提取文本，附件 chip 展示与移除 |
| feat | prd-admin | 视频 Agent 直出模式模型选择器重构为三档卡片（经济 Wan 2.6 / 平衡 Seedance 2.0 / 顶配 Veo 3.1）+ 折叠「高级」按钮展开 OpenRouter 全量 7 个模型，默认推荐自动档 |
| refactor | prd-admin | 视频 Agent 统一入口：撤掉「分镜模式 / 直出模式」两个 tab，合并为单一输入 Hero（UnifiedInputHero），根据用户输入（有附件 / 文本 > 200 字 → 拆分镜，短 prompt → 一镜直出）自动路由到对应管线 |
| refactor | prd-admin | 视频 Agent 输入字段默认收起：视频标题 / 系统提示词 / 画面风格 / 路由偏好 / 直出模型档 / 时长 / 宽高 / 分辨率 等统一折叠到「高级设置 ▸」，首次进入只暴露输入框 + 示例 chip + 上传按钮 |
| feat | prd-admin | 新增路由判定实时提示 chip（"即将：拆分镜 / 一镜直出"）+ 提交后 2.5 秒吐司显示判定原因，可在高级设置里强制"总是拆分镜 / 总是一镜直出" |
| feat | prd-admin | 新增历史任务抽屉（HistoryDrawer，createPortal 右侧）取代原左下历史列表，顶部应用条暴露「📂 历史(N)」按钮一键打开，带状态徽章 + 相对时间 |
| refactor | prd-admin | VideoGenDirectPanel 支持 `externalRunId` 纯输出模式：外层已创建的 videogen run 可直接传入，面板跳过内置输入区只做画布 + 进度 + 下载 |
| feat | prd-admin | 输入 Hero 支持拖拽文件（PDF/Word/Markdown/TXT 皆可），小文本文件（.md/.txt < 128KB）走 FileReader 可视，其它走 /api/v1/attachments 后端提取 |
| refactor | prd-admin | 重写 map 周报标签页：弃用 GitHub 订阅流程，改为从任一已有知识库挑选 + 前端文件名关键词过滤，配置存 sessionStorage |
| feat | prd-admin | map 周报标签页进入后自动选中最新的一篇（按 git commit time 倒序，若缺失则回退到同步时间） |
| feat | prd-admin | map 周报列表为本周有新提交的条目显示绿色 NEW 徽标，时间来源区分 "git" vs "同步" |
| feat | prd-api | GitHubDirectorySyncService 同步时从 GitHub commits API 拉取文件最近提交时间，存入 Metadata.github_last_commit_at；历史条目在下次同步命中 skip 分支时自动回填 |
| fix | prd-admin | 修复 DocBrowser 文件树滚动"不跟手"：移除 overscroll-behavior:contain（父级已 overflow:hidden，无需再拦截），TreeNode 的 transition-all 收窄为 transition-colors，避免滚动时 layout transition 造成漂移感 |
| fix | prd-admin | 修复 map 周报页目录树与预览内容联动滚动：改用纯 inline-style 2-pane 布局，强制 minHeight:0 + overflowY:auto 独立滚动 |
| fix | prd-admin | 修复 DocBrowser 强制 minHeight:calc(100vh-160px) 撑破父级导致 AppShell 主滚动的问题 |
| fix | prd-admin | 清理分支上遗留的 TS 编译错误（未用 import、listDocumentEntries 参数个数、EntryPreview 导入路径） |
| chore | doc | 统一 doc/ 命名：3 个 output-*.md 样本文件重命名为 report.skill-eval-sample-*.md，同步更新 report.skill-doc-evaluation / index.yml / guide.list.directory |
| rule | CLAUDE.md | 新增强制规则 #10：doc/ 下所有 .md 必须以 6 类前缀（spec/design/plan/rule/guide/report）开头，禁止 output-*.md / 裸文件名 / 子目录 |
| chore | doc | 批量统一 163 个 md 文件的 H1 标题格式：剥离 37 种混乱后缀（设计方案/设计文档/架构设计/技术设计/设计稿/方案/操作手册/规范/约定/规格说明/实施计划/...），统一追加 ` · 类型`，类型从文件名前缀映射（spec→规格 / design→设计 / plan→计划 / rule→规则 / guide→指南 / report→报告，周报→周报）；已含类型关键词的跳过追加避免重复 |
| fix | doc | 顺手修 2 个 H1 层级不规范文件：rule.doc-maintenance.md 的 `## ` 提升为 `# `，guide.prd-agent-operations.md 保留 YAML frontmatter 不动（H1 正常在 frontmatter 之后） |

### 2026-04-18

| 类型 | 模块 | 描述 |
|------|------|------|
| feat | cds | Agent 徽章改为常驻显示：pendingCount>0 时走黄色高亮 + 新申请到达瞬间 3 次脉冲闪烁；=0 时转为中性色「Agent 记录」入口，点进去看历史 |
| feat | cds | pending-import 审计保留期从 24h 延长到 7 天，抽屉「最近处理」栏显示"近 7 天 · 共 N 条"并在空状态解释提交路径 |
| feat | cds | Agent Key 项目授权:每个项目可签发 `cdsp_` 自描述 key,默认 rw + 一次性显示明文 + 服务端只存 sha256 + 立即吊销。按钮在项目卡片、分支页头部、Key 管理抽屉三处皆可发起。技能 cds-deploy-pipeline 接到 `CDS_PROJECT_KEY=...` 格式文本自动入会话凭证 |
| fix | cds | auto-build（预览子域触发的构建）改用 `getBuildProfilesForProject(entry.projectId)`，不再遍历别的项目的 profile 导致"缺少 command 字段"或跨项目 service 污染 |
| fix | cds | auto-build 创建的分支显式 `projectId: 'default'`，让清理/隔离路径一致对待 |
| feat | cds | pending-import 提交时校验每个 app profile 必须带 command，否则 400 `invalid_profile`，不再让半成品 YAML 混进状态 |
| fix | cds | 分支列表 UI 遍历 service 时过滤掉不在当前项目 buildProfiles 里的条目，防止跨项目或已删 profile 画出鬼影 chip |
| feat | cds | `/api/cleanup-orphans` 支持 `?project=<id>` 或不传 → 按项目逐个 fetch remote 对比本项目分支，不再把 fork 的 main 当孤儿误删 |
| feat | cds | `/api/prune-stale-branches` 同样项目化，每个项目用自己的 repoPath + 自己的已部署分支集合，cloneStatus 未 ready 的项目自动跳过 |
| feat | cds | `/api/cleanup` + `/api/factory-reset` 支持 `?project=<id>`；分支页"恢复出厂/清理全部"默认按当前项目执行，不再误删其他项目 |
| feat | cds | `build_ts` 改用 git HEAD SHA 作为编译缓存 sentinel（替代易误判的 mtime 比较），修复 self-update 后 dist/ 不重建导致新代码不生效的 pre-existing bug |
| feat | skill | 新增 `.claude/skills/cds-deploy-pipeline/cli/cdscli.py` Python CLI 封装 CDS REST API，解决 curl+bash 方案的嵌套 JSON 转义、UA 被 Cloudflare ban、SSE 解析三大痛点 |
| docs | skill | cds-deploy-pipeline SKILL.md 顶部插入 cdscli 首选工具章节，命令清单取代大段 curl 示例 |
| feat | cds | customEnv 支持项目级作用域：{ _global, <projectId> }，部署时 project 覆盖 global，禁止跨项目泄漏 |
| feat | cds | /api/env 全部端点接受 `?scope=_global|<projectId>`，默认 _global 保持向后兼容 |
| feat | cds | 分支页环境变量弹窗新增"全局 / 此项目"切换开关 |
| fix | cds | 删除项目时级联清理其 customEnv 作用域 bucket |
| test | cds | custom-env-scope.test.ts 6 新测试（迁移 + 合并优先级 + 级联） |
| feat | cds | GitHub App webhook 接入：POST /api/github/webhook 接收 push 事件，自动创建/刷新 CDS 分支并触发部署，Railway 式 Check Run 回写到 PR Checks 面板（点击"Details"直达 CDS 预览分支） |
| feat | cds | Project 新增 githubRepoFullName/githubInstallationId/githubAutoDeploy 三元组，支持 POST/DELETE /api/projects/:id/github/link 将项目绑定到 GitHub 仓库 |
| feat | cds | GitHubAppClient 服务：零新依赖（Node 原生 crypto RS256 JWT + HMAC-SHA256 webhook 签名校验）、安装 token 内存缓存、check runs POST/PATCH、installations/repos 列表 |
| feat | cds | 部署流水线挂接 check-run 生命周期：building 阶段 POST status=in_progress,完成后 PATCH conclusion=success/failure 并把 `<分支>.<domain>` 预览 URL 嵌入 summary |
| feat | cds | GET /api/github/app / GET /api/github/installations / GET /api/github/installations/:id/repos 三个辅助端点,给 UI 用于引导操作员安装 App + 挑选仓库绑定 |
| feat | cds | 新增配置项 githubApp {appId, privateKey, webhookSecret, appSlug} + publicBaseUrl,env 优先（CDS_GITHUB_APP_ID/_PRIVATE_KEY/_WEBHOOK_SECRET/_APP_SLUG, CDS_PUBLIC_BASE_URL）,兼容 `.cds.env` 里 `\\n` 字面值的 PEM |
| feat | cds | 新增全局 Agent 通行证 cdsg_*（与 AI_ACCESS_KEY 等权，可跨项目创建/删除）+ 签发/列表/吊销 UI |
| feat | cds | 项目列表页全局设置菜单加入"🔑 Agent 全局通行证"入口，签发时弹警告 |
| test | cds | 新增 global-agent-keys.test.ts（4 tests 全绿） |
| refactor | cds | 全局 CDS 设置（主题/自动更新/预览模式/镜像/标签页/集群/恢复出厂/退出登录）从分支页的齿轮菜单迁移到项目列表页头部；分支页保留 project-scoped 项 |
| fix | cds | 基础设施端点 (POST/PUT/DELETE/start/stop/restart/logs /api/infra[/:id...]) 全面项目化：`(projectId, id)` 复合唯一性、按 `?project=<id>` 或自动推断项目上下文、多项目冲突时 400 明示「请带 ?project=<id>」、container name 非 legacy 项目自动加项目 slug 前缀避免 Docker 级冲突 |
| fix | cds | 分支页头部 4 个冗余 shortcut 按钮移除（构建配置/环境变量/基础设施/路由规则），这些都在齿轮菜单里有 |
| feat | cds | `./exec_cds.sh init` Mongo bootstrap 改造：容器名 cds-state-mongo、固定端口 27018、等待 mongosh ping healthy、写 CDS_MONGO_CONTAINER 到 .cds.env |
| feat | cds | `./exec_cds.sh start` 前新增 ensure_cds_mongo_running 函数，自动 docker start 容器 + 等 healthy，解循环依赖 |
| docs | cds | guide.cds-mongo-migration.md v1.1：三种场景分流（新装/老切/bug 受害者）+ systemd 绕过 load_env 故事 + 三种紧急回退 |
| feat | cds | 移除"mongo URI 配了但连不上就退回 JSON"的自动 fallback — 按用户需求 Mongo 成主存储 |
| feat | cds | 连 Mongo 失败时 throw exit 并打印清晰的回退路径（编辑 .cds.env 或 Dashboard "切回 JSON") |
| docs | cds | 更新 initStateService() 行为矩阵注释，6 种 state × mode 组合明确表达 |
| feat | cds | `switch-to-mongo` / `switch-to-json` 端点现在会把 CDS_STORAGE_MODE / CDS_MONGO_URI / CDS_MONGO_DB upsert/remove 到 `cds/.cds.env`，重启自动延续 Mongo 模式，不再退回 JSON |
| feat | cds | 新增 `cds/src/infra/env-file.ts` — 原子 upsert/removeKey 工具（chmod 600 + 转义 " \\ $） |
| test | cds | env-file 9 新测试全绿（创建/替换/保留其他/删除/转义/权限/错误 key） |
| refactor | cds | 三页面语义化重命名：projects.html→/project-list, index.html 列表视图→/branch-list, 拓扑视图→/branch-panel；旧路径 301 永久重定向，书签不失效 |
| refactor | cds | setViewMode 切换视图时同步 URL（pushState）+ 页面 title，分支列表/分支面板有独立可书签地址 |
| refactor | cds | 所有内部导航链接（app.js / projects.js / settings.js / settings.html / index.html）统一换为语义路径 |
| refactor | cds | 登录后跳转默认目标从 /projects.html 改为 /project-list（middleware + auth routes） |
| feat | cds | 项目列表页新增 Agent 配置申请徽标与审批抽屉，支持批准/拒绝 pending-import 并懒加载 YAML 预览 |
| feat | cds | 项目卡片渲染 clone 生命周期进度条（pending/cloning 黄条、error 红条），非终态时每 5s 自动轮询直至就绪 |
| feat | cds | 支持 `?pendingImport=<id>` 深链接自动打开审批抽屉并滚动到指定卡片，配合 cds-project-scan 技能的一键跳转 |
| feat | cds | 新增 pending-import 流程：外部 Agent 可 POST /api/projects/:id/pending-import 提交 CDS 配置，由面板人工批准/拒绝（14 个新测试） |
| feat | cds | 部署 env 注入 CDS_PROJECT_SLUG / CDS_PROJECT_ID，compose YAML 可写 `"${CDS_PROJECT_SLUG}"` 实现多项目数据隔离 |
| chore | cds | "快速开始"按钮改名「初始化构建配置」并更新引导文案，反映新增 cds-compose.yaml 优先读取的行为 |
| feat | cds | 项目列表卡片新增运行态摘要（分支数/运行中服务数/最近部署时间）+ 显式"进入分支 →" CTA |
| feat | cds | `GET /api/projects` 排序改为 legacy → 运行中服务多 → 最近部署新 |
| fix | cds | 新建项目时 slug 冲突自动追加 -2/-3 后缀（仅当 slug 为自动派生时）；显式填写 slug 仍然 409 |
| fix | cds | 项目内"快速开始"按 projectId 隔离构建配置，旧项目的 profile 不再阻塞新项目初始化 |
| fix | cds | 项目列表加载失败时显示后端真实错误信息（替代笼统的 HTTP 400） |
| fix | cds | `/quickstart` 优先读取项目仓库根目录下的 `cds-compose.yaml`/`cds-compose.yml`，用其声明的 buildProfiles + envVars + infraServices 代替硬编码模板，修复 fork 出的项目因缺少 MongoDB/Redis/JWT 环境变量导致的 Redis 连接崩溃 |
| fix | cds | `/quickstart` 合并 cds-compose 的 envVars 时跳过已存在的 customEnv key，不覆盖 legacy 手工配置；infraServices 按 projectId 作用域去重，避免两个项目同名 `mongo` 互相冲突 |
| fix | cds | `/quickstart` 构建配置 id 后缀从 `projectId` 前 8 位十六进制改为项目 slug（如 `api-prd-agent-2`），topology 视图更易辨识；legacy default 项目继续使用无后缀 id 保持向后兼容 |
| docs | cds-project-scan | Phase 8 新增进度可见性硬要求 + 缺失 projectId 兜底流程（禁止 AI 猜 ID） |
| fix | cds | 项目列表页 "🔄 自动更新" 恢复完整 modal（可选分支 + SSE 流式反馈），之前是 v1 占位符只能更新当前分支 |
| feat | skill | cdscli 新增 `update` 命令自升级（带备份+回滚）+ `version` 命令对比本地/服务端版本 |
| feat | cds | `/api/cli-version` 端点读取 cli/cdscli.py VERSION 常量（60s 缓存）|
| feat | skill | CLI 请求带 `X-CdsCli-Version` header，解析响应头 `X-Cds-Cli-Latest` 自动 stderr 提示"有新版" |
| docs | skill | 新增 reference/maintainer.md：维护者工作流（改技能源 → bump VERSION → push → CDS self-update 生效）|
| docs | skill | SKILL.md 顶部加"你是哪种身份"导航：消费方 vs 维护者两条路径分流 |
| feat | skill | cdscli 新增 `sync-from-cds` 命令 — 扫 cds/src/routes/*.ts 对比 CLI+reference/api.md 的端点覆盖，给出 drift 报告 + 修复建议 |
| docs | skill | SKILL.md 加「维护者：我改了 CDS，Agent 帮我同步技能」6 步工作流 + 触发词清单 |
| docs | skill | reference/maintainer.md 加完整 AI 辅助同步示例（plan-first → 改文件 → 自检 → 汇报）|
| fix | skill | 触发词收紧 — 维护者同步工作流只认 "/cds-sync" / "帮我同步 cds 技能" 等带 cds 关键字的显式指令，禁止"同步技能"/"更新技能"泛指令误触发 |
| feat | skill | cdscli sync-from-cds 路径可配置：--routes-dir 参数 + $CDS_ROUTES_DIR env + git root 推断 + cli 相对路径兜底，四级降级应对 CDS 未来独立仓库场景 |
| feat | skill | sync-from-cds 输出加 routesDir / scannedFiles 字段 + stderr 打印扫描路径，杜绝"扫到哪去了"的不透明情况；--quiet 抑制 stderr |
| docs | skill | maintainer.md 说明 CDS 独立仓库后的路径配置方式（CDS_ROUTES_DIR 环境变量）|
| fix | cds | 分支页头部恢复 🌓 主题切换按钮（之前误搬走了）；两个页面各自有一把 |
| feat | cds | 项目列表页主题切换接入 View Transition API + clip-path ripple，和分支页视觉一致（之前只是直接翻 data-theme 没动画） |
| feat | skill | 新增统一 `cds` 技能，合并 cds-project-scan + cds-deploy-pipeline + smoke-test 三个技能为单一入口 |
| feat | skill | cdscli 扩展 5 个新命令：init (env 向导) / scan (项目扫描) / smoke (分层冒烟) / help-me-check (自动诊断+根因) / deploy (完整流水线) |
| feat | skill | reference/{api,auth,scan,smoke,diagnose,drop-in}.md 6 份按需加载的进阶文档 |
| feat | cds | /api/export-skill 重构为打包整个 .claude/skills/cds/ (含 cli/ + reference/)，README 指导 drop-in 到其它项目 |
| feat | cds | 项目卡片新增「📦 下载 cds 技能包」按钮（位于 🔑 授权 Agent 左侧），一键 tar.gz 下载 |
| docs | skill | 给 cds-project-scan / cds-deploy-pipeline / smoke-test SKILL.md 顶部加废弃/合并指引，保留向后兼容触发词 |
| docs | cds | 新增 guide.cds-multi-project-upgrade.md 生产环境迁移指南：备份命令 / 自检清单 / 回滚路径 |
| feat | cds | migrateCustomEnv 触发时打印日志 `[state] migrated legacy customEnv into _global scope`，方便运维确认迁移成功 |
| feat | prd-admin | Cmd/Ctrl+K 命令面板重构：从只能切 5 个 Agent 升级为统一命令面板，收录 Agent / 百宝箱 / 实用工具，支持搜索、分组（置顶/最近/Agent/百宝箱/实用工具）、键盘导航、点击星标置顶 |
| feat | prd-admin | 新增「设置 → 我的空间」页：私人使用数据看板，展示置顶工具、最近使用、常用工具 Top 10（按启动次数排序），支持一键取消置顶 / 清空最近 / 重置统计 |
| feat | prd-admin | 用户下拉菜单新增「我的空间」入口，快速跳转到 /settings?tab=user-space |
| refactor | prd-admin | 新增 lib/launcherCatalog.ts 作为 Agent + 百宝箱 + 实用工具的统一目录（命令面板与我的空间共享），按权限自动过滤 |
| refactor | prd-admin | agentSwitcherStore 扩展：recentVisits 新增 id/icon 字段 + 新增 usageCounts / pinnedIds，版本迁移至 v2 兼容老数据 |
| refactor | prd-admin | 命令面板卡片改为紧凑方形（5 列网格，高度 96px，2 行描述），面板最大宽度 1080px，键盘上下移动按列数 5 对齐 |
| fix | prd-admin | 命令面板卡片取消固定高度与截断：描述文字自然换行，卡片按内容增高；同行卡片通过 grid items-stretch 对齐 |
| chore | .cursor/rules | 彻底刷新：以 .claude/rules/ 为唯一事实源，scripts/sync-cursor-rules.sh 自动生成 23 条 .mdc 镜像，修复 doc 路径失效/缺 LlmRequestContext/缺 Run-Worker/缺前端模态框/角色枚举陈旧等全部漂移 |
| docs | .claude/rules/llm-gateway.md | 新增「必须设置 LlmRequestContext」硬规则 + 判定清单 + pa-agent "User not found" 反面案例，把"质量门禁运行时 warning"升级为"规则层必看章节" |
| feat | prd-admin | 周报日常记录：单行 input → 多行 textarea + 粘贴图片自动压缩上传（markdown 内联）+ 折叠态/编辑态/快速添加均渲染图片预览 + 每条 ✨ AI 润色按钮（流式预览浮层 + 接受/放弃 + 模型可见） |
| feat | prd-api | 新增 POST /api/report-agent/daily-logs/upload-image（图片上传，复用 IAssetStorage + Attachment）+ POST /api/report-agent/daily-logs/polish（SSE 流式润色：phase/model/thinking/typing/done/error 事件 + 心跳 + CancellationToken.None 服务器权威） |
| chore | prd-admin | 抽取通用图片压缩工具到 src/lib/imageCompress.ts，与 ReportEditor 共用 |
| feat | prd-admin | 周报日常记录自定义标签支持双击就地重命名：chip 上 `title=双击重命名` 提示 + Enter 保存 / Esc / 失焦取消，复用现有校验（空/超长/重名）与乐观更新回滚。系统标签不受影响（仅自定义标签支持）。 |
| fix | prd-api | 缺陷列表接口同时接受 filter/limit/offset 与 mine/page/pageSize，修复前端契约漂移导致 filter=assigned 被静默丢弃、pageSize 回落到默认 20 条使用户看不到自己的缺陷
| fix | prd-api | 缺陷列表 MaxPageSize 提升到 500，支持单次拉取覆盖真实账号全量数据；filter=submitted/assigned/all 直接映射到 ReporterId/AssigneeId 服务端筛选
| fix | prd-admin | 缺陷 store 拉取 limit 从 100 提升到 500 匹配后端新上限，并新增 defectsTotal 字段；列表顶部当 total > 已加载条数时显式提示"共 N 条，请用筛选缩小范围"避免用户误以为数据丢失
| fix | prd-desktop | list_defects Tauri 命令显式传 ?limit=500，修复用户看不到 20 条之外的缺陷
| fix | prd-admin | 缺陷详情弹窗关闭按钮定位到对话框右上角（showChat 时不再卡在 55% 分栏线上） |
| feat | prd-api | `/api/defect-agent/users` 返回 AdminUser 兼容形状并按「已解决缺陷数」降序返回，最积极解决缺陷的人排在最前 |
| feat | prd-admin | 缺陷提交面板（DefectSubmitPanel / GlobalDefectSubmitDialog）统一使用 `UserSearchSelect` 富选择器（头像/角色/活跃时间）替换原始 `<select>`，与「发起数据分享」一致 |
| fix | prd-admin | 缺陷提交按钮允许点击态保留；缺少「提交给」时改为该字段红色闪烁三拍（代替右上角 toast），视觉聚焦到真正需要填写的控件 |
| feat | prd-admin | 智识殿堂（LibraryLandingPage）新增搜索框：支持按知识库名称 / 作者 / 描述 / 标签模糊搜索，含空结果引导 |
| refactor | prd-admin | 统一用户选择器：OpenPlatformPage / AppsPanel / BindingPanel / EmailChannelPanel / IdentityMappingsPage / WhitelistEditDialog / DataSourceManager / TeamManager 全部替换为 `UserSearchSelect`（系统公认的富用户选择组件） |
| fix | prd-desktop | 群组切换不再空白闪烁：messageStore 新增每群快照（LRU 12 群、每群 80 条），切回已访问群秒开，冷启动才等服务端同步
| fix | prd-desktop | 断线提示大重写：移除常驻"未连接"状态点，Header 红色脉冲 banner 改为 ≥4s 防抖的克制琥珀 pill，tauri 层 2s 防抖 markDisconnected 吃掉瞬时抖动，ChatContainer 初始态改 'connecting' 消除打开瞬间红点
| fix | prd-desktop | 群切换时清掉上一群的 SSE error 残留，避免 A 群错误贴到 B 群头部
| fix | prd-desktop | 连接自动探活改为指数退避 5s→60s（不再固定 5s 轮询），避免断网时持续占资源
| fix | prd-api | 修复 DocumentSyncWorker 因 HttpClient 30s 超时抛 TaskCanceledException 被 catch filter 误判为"关机取消"漏掉，最终拖垮整个 Host 导致无法登录的问题 |
| fix | prd-api | HostOptions.BackgroundServiceExceptionBehavior 显式设为 Ignore，避免任一 BackgroundService 未捕获异常时整个进程被停 |
| fix | prd-admin | 修复「管理标签」铅笔按钮进不了编辑态的回归：新增 editingTagSource（manage/quick/editMode）隔离三处入口，避免共用 editingTagIdx 导致 onBlur 连带退出；三处 setEditingTagIdx/Draft 重置统一收敛到 handleCancelInlineEditTag。 |
| feat | prd-api | LLM Gateway 对 OpenRouter 上游自动注入 `HTTP-Referer` + `X-Title` header，把 AppCallerCode 映射到 OpenRouter Dashboard 的应用归属维度；按 ApiUrl 域名隔离，不影响 DeepSeek / 通义 / Claude 等其他上游 |
| fix | prd-api | LLM Gateway 流式请求的传输层异常（HttpClient 超时、连接失败、流中途断连）现在会落 llmrequestlogs 的 statusCode + error，不再被 Watchdog 5 分钟兜底成 `error="TIMEOUT" / dur=300000` 的观测黑洞 |
| fix | prd-api | LLM Gateway 流式请求上游返回 401/4xx 时，先写日志再 yield Fail chunk；避免 caller 收到 Error chunk 立即 return 释放迭代器，导致 MarkError 被跳过、日志滞留 running 最终被 Watchdog 盖成 TIMEOUT |
| fix | prd-api | PRD Agent 遇 PRD 方案仅粗略提及、缺口径/数值/触发条件时，必须标注「未详细说明」并用 `@产品` 发起澄清，禁止用行业惯例/主观推断补全
| fix | prd-api | SystemPromptSettings 新增 SeededVersion 字段：SystemPromptService 检测到旧种子版本时自动用 PromptManager 最新默认值覆盖，解决 snapshot-fallback 陷阱（代码 PR 改了默认提示词，但老环境因首次启动已把旧默认持久化到 MongoDB 而继续返回旧文案）。管理员通过 PUT 保存的 doc 会清空 SeededVersion，永远保留，不被自动升级覆盖
| feat | prd-admin | 百宝箱新增「公开市场」分类 tab，可浏览/搜索/Fork 他人公开发布的智能体到自己的百宝箱 |
| feat | prd-admin | 自定义工具卡片 hover 显示快捷「编辑」按钮，已公开的卡片左下角显示绿色「已公开」徽章 |
| fix | prd-admin | ToolDetail 切换发布状态后立即同步到 store.items，回到 grid 徽章实时刷新（之前需刷新页面） |
| fix | prd-admin | 百宝箱按钮文案去歧义：「自定义副本」→「复制并编辑」、「分享」→「分享对话」、「发布」→「公开发布」，并加 tooltip 说明各自动作和影响 |
| feat | prd-admin | 「公开发布」首次点击时弹原生确认框，避免误把私人智能体公开给所有人 |
| feat | prd-admin | 百宝箱卡片 hover 时右上角直接显示操作浮条：自定义卡片「编辑 / 公开发布 / 删除」，内置可 Fork 卡片「复制并编辑」，不再需要先进详情页 |
| fix | prd-admin | 用户自建工具被误识别为"系统内置"根因修复：后端 ToolboxItem 模型没有 Type 字段，store.loadItems 补归一化 + 多处 fallback 用 createdBy/createdByName 判定，作者头像、编辑按钮、详情页「编辑」等 custom-only UI 恢复正常 |
| feat | prd-admin | 百宝箱卡片 footer 语义重构：定制版显示「定制版」徽章；其它卡片（内置对话/用户自建/公开市场）统一显示作者头像+名字；用户自建工具未公开显示橙色「施工中」、已公开显示绿色「已公开」；「系统内置」徽章移除 |
| fix | prd-admin | 用户自建工具作者显示"未知"兜底优化：后端 GetUserName() 依赖 JWT name claim 可能为空，前端 fallback 改用 authStore 当前登录用户的 displayName/username，最终兜底为"我" |
| feat | prd-admin | 内置对话型智能体（代码审查员/翻译/摘要/数据分析师）统一标记为「官方」作者，与用户自建工具共用 footer 样式 |
| feat | prd-admin | 创建智能体成功后：① toast 明确提示"默认仅你自己可见，点卡片右上角 🌍 公开发布" ② 卡片右上角的「公开发布」按钮自动脉动高亮（绿色光环 + 常驻可见），用户点过或成功公开后自动移除，防止用户以为"创建即共享" |
| feat | prd-api | ToolboxItem 新增 CreatedByAvatarFileName 字段，Create 和 Fork 时查 Users 集合写入创建者头像 + DisplayName（之前只存 JWT name claim 可能为空） |
| feat | prd-admin | 百宝箱卡片底部头像从"首字母圆形块"改为真实头像图片：优先用后端返回的 createdByAvatarFileName 经 resolveAvatarUrl 拼 CDN（适用公开市场里别人的卡片），其次 authStore 当前用户 avatarUrl，首字母块仅作最终兜底 |
| feat | prd-admin | 周报编辑器新增草稿自动保存：输入停手 1.5s 后自动落盘，头部实时展示"保存中/已保存·HH:mm/保存失败"状态条，刷新/关闭前未保存内容有浏览器兜底提示 |
| feat | prd-admin | 周报「列表」类型 section 支持键盘流：回车新增下一条（自动聚焦）、空行退格合并到上一条（Notion 同款），并排除 IME 合成态 |

### 2026-04-17

| 类型 | 模块 | 描述 |
|------|------|------|
| feat | prd-admin | 涌现探索器新增炫酷介绍入口页,首次进入展示三步流程+三维度样例+手势说明,可通过顶栏「关于涌现」再次查看 |
| fix | prd-admin | 修复涌现画布探索/涌现时新节点堆积在同一位置的 bug(原 `toFlowNodes` 在增量到达时只传入单个节点导致无法计算正确深度),改为整体重新布局 + 基于子树宽度的递归树布局算法 |
| feat | prd-admin | 涌现画布手势对齐视觉创作画布:两指拖动=平移、双指捏合或 ⌘/Ctrl+滚轮=缩放、Space+拖动=临时平移、禁止双击缩放 |
| rule | root | 新增 `.claude/rules/gesture-unification.md` 画布手势统一规则,强制所有 2D 画布遵守同一套 Apple 触控板优先的手势约定,并注册到 CLAUDE.md 规则索引 |
| feat | prd-admin | 涌现画布新增骨架占位卡片:点击「探索/涌现」瞬间下方立即出现 4 张 shimmer 扫光骨架 + 虚线 animated 边,SSE 每到达一个真实节点就消费一个占位槽位并带 0.55s 淡入放大的入场动效,彻底消除 LLM 空白等待 |
| feat | prd-admin | 涌现节点操作按钮拆分为两颗:左「增加灵感」(黄色·Lightbulb,打开对话框写方向)、右「探索」(蓝/紫/黄·Star,直接无提示词发散);灵感对话框带 6 个快速预设+⌘Enter 快捷提交,呼应零摩擦输入原则 |
| feat | prd-api | `POST /api/emergence/nodes/:nodeId/explore` 新增可选请求体 `{ userPrompt?: string }`,Service 层 `ExploreAsync` 接收 `userPrompt` 参数并在 userMessage 尾部追加「用户补充灵感方向」段,LLM 按方向优先发散但仍约束于现实锚点 |
| feat | prd-admin | 涌现树列表卡片重新设计:基于标题哈希派生确定性视觉指纹(色相/轨道粒子数/热度/旋转角),每棵树自带独特花蕾+轨道 SVG 动画(节点数→粒子数/亮度,更新时间→热度火苗)+ 渐变进度条,彻底告别"所有树长得一模一样"的单调感 |
| feat | prd-admin | 涌现画布顶栏新增「整理」按钮(Wand2 图标):调用 `reactFlow.fitView` + 重新递归布局,一键把杂乱节点恢复树状整齐视图,解决"人类微调太累"痛点 |
| feat | prd-admin | 涌现画布「二维涌现 / 三维幻想」两颗按钮合并为单颗「涌现 ▾」Popover:展开后展示两种发散方式的大白话解释(跨系统组合 vs 放飞想象),用户第一次见就知道选哪个,呼应 guided-exploration 的 3 秒规则 |
| feat | prd-admin | 涌现画布流式生成时顶栏增加「停止」按钮(StopCircle 红色):调用 `useSseStream.abort()` 中断当前 LLM 请求、清空占位骨架,用户不再被卡住几十秒空等 |
| feat | prd-admin | 涌现画布每到达一个新节点自动调用 `reactFlow.setCenter` 平滑居中,新节点不再跑到视口外需要手动找;缩放 0.85 + 600ms 过渡,兼顾全局感与聚焦感 |
| fix | prd-admin | 涌现画布左下角图例文字从白色改为与图标同色(维度色相),用户不再"分不清白字在说什么";底色加深+blur,提升对比度和可读性 |
| feat | prd-api | 涌现 `ExploreAsync` / `EmergeAsync` 由一次性 `SendAsync` 改为流式 `StreamAsync` + `onContent` 回调,LLM 输出每到达一个 Text chunk 就实时回传给 Controller,用户不再面对几十秒空白等待 |
| feat | prd-admin | 涌现画布左上角原简陋阶段条替换为 `EmergenceStreamingBar`:左徽章(维度色 spinner+文案)、中间流式文字预览(等宽字体+光标闪烁+横向滚动到最新+JSON 字段抽取可读化)、右侧「已涌现 N 个」,维度色随探索/涌现切换 |
| feat | prd-admin | 涌现画布骨架占位卡片在流式生成时替换 shimmer 为 LLM 实时输出文本(最多 140 字 + 等宽字体 + 光标闪烁),底部文案从「即将涌现…」切到「即将落位…」,用户在等待期间看到 AI 正在思考的内容 |
| feat | prd-admin | 涌现首次进入介绍页重新设计:参照 ui-ux-pro-max 的 Bento Grid Showcase + AI-Driven Dynamic Landing 模式,中央种子 hero 视觉(三环反向旋转轨道 + 呼吸光晕 + 四向光芒 + 28 颗漂浮粒子),非对称 bento 布局(1/1.4/1 列,涌现维度居中放大),编号时间线(1→2→3 带渐变连接线)替代原平铺步骤卡片 |
| fix | prd-admin | 涌现画布树布局参数调整:`LEAF_WIDTH` 320→360、`DEPTH_STEP` 220→340,解决种子节点(含描述+缺失能力警告+标签+操作按钮约 260-280px 高)与下一层子节点视觉重叠的 bug |
| fix | prd-admin | 涌现画布左下角图例改用纯色 rgb 文字(蓝/紫/黄)+ 加深面板底色 `rgba(15,16,20,0.85)` + blur saturate(140%),彻底解决"白色 + 半透明 rgba 看不清"问题 |
| feat | prd-api | 涌现 `ExploreAsync` / `EmergeAsync` 新增 `onThinking` 回调,GatewayRequest 启用 `IncludeThinking=true` + OpenRouter `include_reasoning:true` + `reasoning.exclude:false`,推理模型的 reasoning_content 现在能流式回传 |
| feat | prd-api | `EmergenceController` Explore/Emerge SSE 协议新增 `thinking` 事件:reasoning_content 每片就推一条 `event: thinking\ndata: {text}`,用户首字到达前不再面对几十秒空白等待 |
| feat | prd-admin | 涌现画布顶栏 `EmergenceStreamingBar` 新增 `thinking` 字段:typing 还是空时优先展示 reasoning_content(脑图标 1.4s 脉冲 + 斜体灰字 + 横向滚动到最新),首字到达后无缝切换为正式 typing 渲染 |
| fix | prd-admin | 涌现画布左下角 ReactFlow Controls(+/-/fitView 按钮)彻底暗色化:玻璃面板底 + 半透明白字 + hover 变蓝,不再是刺眼的白底黑字与暗色主题冲突 |
| feat | prd-admin | 涌现探索支持并行:原「单流独占」改为每个节点独立 SSE 流,可同时探索 N 个节点,顶栏显示"N 条并行"+代表性 typing/thinking,停止按钮一键停全部;只有同一节点二次点击才禁用 |
| feat | prd-admin | 涌现节点「探索」按钮增加 per-node loading 态:流式期间显示 MapSpinner + "探索中…" + cursor progress + 禁用 disabled,解决「点一次就全树禁用」的误导 |
| fix | prd-admin | 涌现画布删除 ReactFlow 自带 Controls(+/-/fitView):暗色样式覆盖反复无效,且画布手势已支持双指捏合/⌘+滚轮缩放、Space+拖动平移,顶栏「整理」按钮 = fitView,Controls 完全冗余 |
| fix | deploy | exec_dep.sh 自动下载安装 ffmpeg/ffprobe 静态版到 /opt/ffmpeg-static，修复容器因缺少 ffmpeg 导致视频创作/转录报错 |
| feat | prd-api | 新增 HomepageAsset 实体与 HomepageAssetsController（admin 上传/删除）+ HomepageAssetsPublicController（任意登录用户可读），支持首页四张快捷卡背景与所有 Agent 封面图/视频的动态上传 |
| feat | prd-admin | 设置 → 资源管理新增「首页资源」Tab：4 张快捷卡背景 + 17 个 Agent 封面图/视频上传，一个 slot 一张图/视频，自动映射到 CDN |
| feat | prd-admin | LandingPage（AgentLauncherPage）读取已上传的 card 背景与 agent 封面/视频，优先覆盖默认渐变/CDN 素材 |
| feat | prd-api | HomepageAssetsController BuildObjectKey 新增 hero.{id} 路由 → 老 CDN 路径 icon/title/{id}.{ext}，首页顶部 Banner 可在设置页一键替换 |
| feat | prd-admin | 设置页资源管理「首页资源」Tab 顶部新增「首页顶部 Banner」区块，未上传显示老图 + 默认徽标 |
| feat | prd-admin | LandingPage heroBgUrl 改走 useHeroBgUrl hook（订阅 store + ?v= 缓存爆破），上传即时生效 |
| feat | prd-admin | 个人公开页 `/u/:username` 新增「装修」面板：访问自己的公开页可编辑自我介绍（最多 500 字）与切换 8 种背景主题（极光/日落/森林/深海/紫罗兰/樱粉/极简/墨黑） |
| feat | prd-admin | 公开页各领域卡片新增内容预览：文档显示主条目标题+摘要；提示词显示前 240 字；工作空间显示封面图；涌现显示种子预览；工作流显示节点数+前 5 个节点类型链 |
| feat | prd-admin | 公开页自助撤回：访问自己公开页时每张卡片悬浮「取消公开」按钮，二次确认后调用对应 unpublish/visibility 端点，即时从列表移除 |
| feat | prd-api | User 模型新增 `Bio` + `ProfileBackground` 字段，支持 `PATCH /api/profile/public-page` 更新 |
| feat | prd-api | 公开页聚合接口双批次交叉查询：主 Task.WhenAll 后再批量解析 ImageAsset 封面 + DocumentEntry 主条目，避免 N+1 |
| feat | prd-api | 新增 3 个自助撤回端点：`POST /api/visual-agent/image-master/workspaces/{id}/unpublish`、`POST /api/emergence/trees/{id}/unpublish`、`POST /api/workflow-agent/workflows/{id}/unpublish` |
| feat | prd-admin | 公开页卡片重构为"首页作品广场"风格：统一的 `PlazaCard` 瀑布流 + 哈希渐变兜底 + NotebookLM 底部叠加文字，应用于视觉/文学/文档三域 |
| fix | prd-api | 视觉创作 workspace 封面兜底：当 `CoverAssetId` 未设置时，自动取该 workspace 最近创建的 ImageAsset 作为封面；并返回 `coverWidth/coverHeight` 驱动瀑布流自然比例 |
| fix | prd-admin | 公开页背景主题修复：从仅头部 40% 不透明扩展到全页固定环境光层（55% 不透明），让所有主题色（极光/日落/森林等）实际可见 |
| refactor | prd-admin | ShareDock 通用化：提取到 `components/share-dock/`，支持自定义 MIME + 槽位配置，头部可拖动位置 + 可收起成 36px 竖条，位置/折叠状态持久化到 sessionStorage |
| fix | prd-admin | 投放面板从右上角移到右侧垂直居中，不再遮挡筛选栏 / 视图切换按钮 |
| perf | prd-admin | 卡片拖拽从 HTML5 DnD 改为 Pointer Events（新增 `useDockDrag` hook），解决鼠标漂移/不跟手问题，支持触屏 |
| feat | prd-admin | `GlassCard` 新增 `onPointerDown` 道具支持 Pointer Events 自定义拖拽 |
| fix | prd-admin | ShareDock 槽位 hover 反馈加强：外发光 + 内发光 + 2px 高亮边框 + 1.06 缩放 + 呼吸光晕提示，ghost 缩小并偏移避免挡住 slot 光晕 |
| feat | prd-api | `/api/public/u/:username` 响应结构升级为多领域聚合：新增 skills / documents / prompts / workspaces / emergences / workflows 6 个公开资源列表，并行查询 |
| feat | prd-admin | 个人公开页 `/u/:username` 重写为多 Tab 布局：网页 / 技能 / 文档 / 文学提示词 / 视觉创作 / 涌现 / 工作流，每类独立卡片渲染 |
| feat | prd-admin | 公开技能卡片支持"下载"按钮：导出技能元信息为 JSON 文件（含 skillKey/title/description/tags + fork 导入提示） |
| fix | deploy | exec_dep.sh 优先探测宿主机已有 ffmpeg (/usr/local/bin/ffmpeg 等)，仅在不存在时下载静态版 |
| feat | prd-api | VideoAgent 新增 "videogen" 直出模式：通过 OpenRouter 视频 API 调用 Seedance / Wan / Veo / Sora，保留 Remotion 路径不变 |
| feat | prd-api | 新增 IOpenRouterVideoClient + OpenRouterVideoClient（异步 submit + 轮询，按秒计费） |
| feat | prd-api | VideoGenRun 模型新增 RenderMode / DirectPrompt / DirectVideoModel / DirectAspectRatio / DirectResolution / DirectDuration / DirectVideoJobId / DirectVideoCost 字段 |
| feat | prd-api | VideoGenRunWorker 新增 ProcessDirectVideoGenAsync 分支，不影响原 Scripting/Rendering 流程 |
| feat | deploy | docker-compose.yml + dev.yml 注入 OpenRouter__ApiKey 与 OpenRouter__BaseUrl 环境变量 |
| feat | prd-admin | VideoAgentPage 顶部新增模式切换条（分镜模式 / 直出模式），Remotion 原流程保留不变 |
| feat | prd-admin | 新增 VideoGenDirectPanel 沉浸式直出面板：prompt 输入 + 模型/时长/比例/分辨率选择 + 实时进度 + MP4 内嵌播放 |
| feat | prd-api | VideoGen 加入 BaseTypes（四大分类 → 五大基础类型）|
| feat | prd-api | 新增 AppCallerRegistry.VideoAgent.VideoGen.Generate = "video-agent.videogen::video-gen" |
| refactor | prd-api | OpenRouterVideoClient 改走 ILlmGateway.SendRawAsync，API Key 从平台管理读取，不再依赖 OPENROUTER_API_KEY 环境变量 |
| refactor | prd-api | VideoGenRunWorker.ProcessDirectVideoGenAsync 调用新 client 签名（AppCallerCode 驱动）|
| feat | prd-admin | 模型选择模态框新增「视频」tab，Film 图标，点击过滤出视频生成模型 |
| feat | prd-admin | cherryStudioModelTags 新增 isVideoGenModel 判定 + video_generation tag |
| feat | prd-admin | VideoGenDirectPanel 模型下拉新增「自动（由模型池决定）」选项 |

### 2026-04-16

| 类型 | 模块 | 描述 |
|------|------|------|
| feat | cds | FU-02 新增 MongoAuthStore：CDS_AUTH_BACKEND=mongo 持久化用户 session，重启不掉登录态 |
| fix | cds | LIM-07 补回拓扑视图 "Volume / 持久化卷" + Add 菜单入口，调用 openInfraAddModal() |
| feat | cds | FU-03 完成:stack-detector 加 nixpacks 风格框架推断层,覆盖 Next.js / NestJS / Express / Remix / Vite+React / Django / FastAPI / Flask / Rails 9 种框架,返回 framework/suggestedRunCommand/suggestedBuildCommand 可选字段 + 20 条新测试 |
| refactor | cds | FU-04 完成:WorktreeService 路径从 `<base>/<slug>` 改为 `<base>/<projectId>/<slug>`(两个项目同名分支不再碰撞),新增启动期 symlink 迁移(fallback rename) + state.worktreeLayoutVersion 幂等守卫 + 7 条新测试,保持 multi-repo-clone smoke 绿色 |
| feat | cds | GAP-11:拓扑 Details 面板 Deploy 按钮在多 profile 分支下变成 split-button,▾ 下拉列出每个服务,点击调 `deploySingleService(branchId, profileId)` —— 之前只能整分支部署 |
| feat | cds | GAP-12:分支 `status === 'error'` 时显示 Reset 按钮(琥珀色,刷新图标),点击调 `resetBranch(branchId)` 清除错误标记 |
| feat | cds | GAP-13:拓扑 Details "备注" tab 的标签从只读变为可编辑 —— 每个 tag 带 × 删除按钮调 `removeTagFromBranch`,末尾 "+ 标签" 调 `addTagToBranch`,"批量编辑"按钮调 `editBranchTags`。未选分支时回退只读 |
| feat | cds | GAP-14:拓扑 Details 面板新增"提交历史"按钮,弹出 portal 模态框展示 `/branches/:id/git-log` 返回的 15 条提交,点任一提交调 `checkoutCommit` 切换到该 commit 重建 |
| feat | cds | GAP-15:拓扑 Settings tab 的"部署模式"区块从只读列表变为可点击菜单 —— 每条模式行点击调 `switchModeAndDeploy(branchId, profileId, modeId)`,当前激活模式前加绿色 ✓ |
| feat | cds | GAP-16:拓扑顶栏新增手动刷新按钮(位于 "列表\|拓扑" 切换 pill 前),点击调 `refreshAll()` + 本地 `.spinning` class 让 svg 旋转反馈,不用等 5 秒轮询 |
| docs | cds | 新增 `doc/design.cds-fu-02-auth-store-mongo.md` —— FU-02 MapAuthStore mongo 后端的独立设计稿:接口 / 数据模型(cds_users + cds_sessions)/ 启动时按 CDS_AUTH_BACKEND 分发 / memory→mongo 迁移策略(接受一次重登)/ 测试计划 / 回滚路径。下一棒可直接按此稿实施,不需要先设计 |
| docs | cds | 新增 `doc/report.cds-railway-alignment.md` —— 逐条对齐 Railway 范式的 7 大类 + 我们独有的 10 个护城河特性 + 完成度量化:日常可用性 92% / 按功能权重 73%。明确下一步建议 FU-02 → P5 → P6 顺序推进,不要反过来 |
| docs | cds | 新增 `doc/report.cds-handoff-2026-04-16.md` —— 本 session 完整交接报告(8 章):commit 时间线 / UF×22 GAP×16 L10N×3 FU×4 TEST×2 交付清单 / 关键文件:行号索引 / 已知限制 / 人工验收 11 步清单 / 下一棒优先级建议 / 关联文档地图 |
| docs | cds | 更新 `doc/plan.cds-roadmap.md` v1.0 → v1.2 —— 把"本次迭代"改为"已完成";Phase 0/1 全部 ✅;Phase 2 多项目 ✅ + 模板库 📋 未启动;Phase 3 🔮 未启动 |
| docs | cds | 更新 `doc/plan.cds-multi-project-phases.md` P5/P6 注记 —— P5 前置依赖明确为 FU-02(不能并行);P6 和 Phase 3 release agent 作用域边界需独立评审 |
| docs | cds | tighten `doc/guide.cds-view-parity.md` §5 smoke runbook —— 每个步骤加 "操作 · 预期 · 失败判定 · 失败回归的 UF 编号" 四栏;新增 §5.5 出错回报模板(给下一棒填空);新增 §5.6 已知未覆盖角落(iPad / Windows / 大仓库 / key 轮换) |
| fix | cds | 替换所有 emoji 为 SVG 图标（topology 面板、infra 选择器、分支列表、提示文本等 40+ 处） |
| fix | cds | 修复项目卡片 READY 徽章与删除按钮重叠：删除按钮移入 flex header，去除绝对定位 |
| fix | cds | 孤儿分支清理由串行 for-of 改为 Promise.all 并行，缩短多分支清理耗时 |
| fix | cds | build-profiles 接口不再要求 command 字段非空（auto-detect 场景 command 可为空字符串） |
| fix | cds | topology 拓扑图：节点布局改为上下方向（入口在上，数据库在下），新增应用虚线分组框，左侧导航新增视图切换图标，右侧面板添加/关闭按钮不再重叠 |
| fix | cds | 新增 .topology-app-group 和 .topology-fs-leftnav-label CSS 类，修复未定义样式导致渲染异常 |
| fix | cds | 修复 topology 布局：admin(app)被错放底部 infra 行，改用强制 2 层布局确保所有 app 节点在顶部 |
| feat | cds | topology 节点可拖拽：鼠标拖动单个节点，边线实时跟随；复位按钮清除拖拽偏移 |
| feat | cds | topology 分组框增加 GitHub+Apps 标签；初始缩放从 1.5x 降为 0.75x，加大 margin |
| feat | cds | topology 左侧设置图标改为打开系统设置菜单（含导出/自动更新/清理），不再跳转 settings.html |
| fix | cds | 隐藏 topology 全屏模式下面板标签栏的原生横向滚动条（scrollbar-width: none） |
| feat | cds | Activity Monitor 整合入右侧面板：全屏模式隐藏浮动 Activity，左侧导航新增「活动」入口，右侧面板新增「活动」标签展示 CDS/Web 实时日志，新事件自动推送到面板 |
| refactor | cds | topology 左侧导航重构：弃用单一「设置」弹出菜单，改为分段 icon 按钮（导航 / 项目级工具 / 系统级工具），每个功能直接可点 |
| fix | cds | 右侧面板关闭按钮（X）：图标扩大为 18px，边框改为 text-muted 颜色，字色改为 text-primary，确保在任何背景下清晰可见 |
| fix | cds | topology 画布添加 touch-action:none 防止系统触控惯性干扰自定义拖拽；左侧导航添加分段分隔线 |
| feat | cds | topology 聚合视图新增每分支独立虚线框：每列（每个分支）用带分支名 label 的虚线圆角框圈出 api+admin，移除冗余的卡片内 @branchLabel 标签，TOPO_SECTION_GAP_Y 调大至 84 以容纳 label pill |
| fix | cds | 修复 topology/列表 4 处 onclick 静默失效：JSON.stringify 产生未转义双引号破坏 HTML 属性解析（topology 可添加/手动添加/Enter 键、列表手动添加、提交日志 checkoutCommit），统一改为 .replace(/"/g,'&quot;') |
| fix | cds | topology 点击"可添加"分支后新增 _topoAddAndSelect：关闭下拉 + addBranch + 自动切换视图到新分支（原来 addBranch 成功后仍停在共享视图） |
| feat | cds | topology 聚合视图（共享 B 型）改为分组换行布局：超过 4 个分支时自动折行（MAX_AGG_COLS=4），最大画布宽度固定为 4 列，_layoutTopologyAggregated 返回预计算 positions/svgW/svgH，_renderTopologySvg 双路支持；_topologyFit 自动适应视口 |
| perf | cds | topology 拖拽丝滑度对齐 VisualAgent：mousemove/pointermove 写 transform 改为 requestAnimationFrame 合帧（`_scheduleTopologyTransform`），一帧最多一次 DOM 写入；画布 `will-change:transform + contain:layout style` 上 compositor 层；mouse 事件全量迁移 pointer 事件 + `setPointerCapture` 修复 1cm→5cm 漂移 + 指针离窗后失联 |
| fix | cds | 面板关闭按钮 SVG 改为 ✕ 文字字符，彻底消除 fill:currentColor 继承透明的顽疾 |
| refactor | cds | topology 左侧导航主次分离：刷新（最高频）移入项目级区段，导入/更新/清理/项目列表折入「设置」系统级 popover；移除 topbar 多余刷新按钮 |
| fix | cds | CSS 强制 `.topology-fs-leftnav-icon svg { width:20px; height:20px }` 覆盖任意 HTML 属性，彻底根治 icon 偏小反复出现问题 |
| fix | cds | topology window 级 pointer 监听改为一次性绑定（`_topologyWindowListenersBound` 防止每次 renderTopologyView 叠加句柄），长会话无句柄泄漏 |
| fix | cds | topology 状态点动画去掉 `transform:scale(1.25)` — SVG `<circle>` 不遵守 CSS `transform-origin:center`，scale 导致橙色圆点溢出卡片边界抖动；改为纯 opacity 呼吸动画 |
| feat | cds | 共享视图（B 型聚合）：无分支选中 + 有已追踪分支时，展示所有分支 × 所有 BuildProfile 实例，共享同一套基础设施；每张卡片右上角显示 @branchId 标签；点击任一实例自动切换至对应分支并打开服务面板 |
| fix | cds | 宿主机 CPU/MEM 浮动气泡在拓扑全屏模式下隐藏，改为嵌入顶部 topbar 的内联 pill（`topology-fs-hoststats`），不再遮挡画布内容 |
| fix | cds | topology 单分支 DAG 视图的 Apps 框改为显示当前分支名 `@branchId`，与聚合视图保持一致 |
| fix | cds | 刷新页面进入共享视图后打开分支下拉不再自动切换到主分支（删除 _topologyAutoSelectPending 逻辑） |
| fix | cds | topology 部署日志 tab 不再被 updateInlineLog 强制跳回详情 tab（仅在已处于 details tab 时才重渲染） |
| fix | cds | modal z-index 从 100 提升至 500，彻底解决 topo-sys-popover（z-index:200）遮盖弹窗的重叠问题 |
| fix | cds | CDS 系统更新弹窗简化：默认直接更新当前分支，移除分支切换下拉（改为 <details> 折叠的高级选项），清理误导性"更新所有"按钮 |
| fix | cds | 移除"网络流"tab（eBPF/tcpdump 未实现的占位符），避免用户看到无内容页面以为功能异常 |
| fix | cds | topology 节点拖拽双重叠加 bug：_topologyNodeDragStart 的 group transform 改为仅含当前帧增量（ddx,ddy），不再重叠已嵌入坐标的 baseOffset，拖拽实时跟手 |
| fix | cds | 去除 .topology-node 的 transform transition（0.12s ease），消除 SVG 节点拖拽时的动画延迟；环境变量面板眼睛图标颜色由 text-muted 改为 rgba(255,255,255,0.35)，hover 态增强至 0.65，svg 固定 14×14 确保清晰可见 |
| fix | cds | 共享视图单击节点不再跳转到单分支 4 节点视图：引入 _topologyKeepSharedView 标志，点击聚合节点只打开面板（含分支上下文），用户须通过顶部 chip 显式切换分支 |
| fix | cds | 项目卡片服务图标替换为 Simple Icons 准确品牌 SVG（Nginx N 字路径、Node.js 官方 hexagon、MongoDB 叶子、Redis 几何图形），颜色对齐官方品牌色 |
| fix | cds | detect-stack 失败（400/500）由抛错改为非阻断警告，链条继续进入「手动配置」路径，不再显示恐慌性红色 [chain-error] |
| feat | cds | exec_cds.sh init 新增 Phase 3 MongoDB 初始化：交互式询问是否启动 Docker MongoDB 8 容器，自动追加 CDS_MONGO_URI/CDS_STORAGE_MODE=mongo/CDS_AUTH_BACKEND=mongo 到 .cds.env，一键完成持久化数据库配置 |
| fix | cds | topology 添加分支后不跳转：_topoAddAndSelect 改为同步设置 _topologySelectedBranchId + await _topologySelectBranch + 调用 _topologyFit()，确保添加后立即切换到新分支单视图；_topologySelectBranch 对 profile-overrides 404（新分支无覆盖属正常）不再弹错误 toast |
| fix | cds | 项目卡片删除按钮彻底修复：button-in-anchor 是无效 HTML（部分浏览器点击导航而非删除）；改为 cds-project-card-wrapper div 包裹，删除按钮移至 <a> 外侧，position:absolute top:12 right:12，hover 触发器改为 .wrapper:hover，card-head 增加 padding-right:36px 避免标题与按钮重叠 |
| fix | cds | 删除按钮第三轮修复：projects.js 注入 CSS patch（兜底两种选择器应对浏览器 JS/HTML 版本缓存错位）；SVG fill 改为硬编码 #f43f5e 消除 currentColor 继承透明；server.ts HTML 文件返回 Cache-Control: no-store；projects.html script 标签改用 document.write 方式彻底 cache-bust |
| feat | cds | 顶部导航栏新增快捷配置按钮：构建配置 / 环境变量 / 基础设施（运行时绿点状态）/ 路由规则，无需打开齿轮菜单直接点击访问 |
| feat | cds | projects.html 侧边栏 logo 行新增主题切换按钮（亮/暗模式），解决浅色主题下按钮不可见问题 |
| fix | cds | topology 右侧面板"公开地址"和"DEPLOYED VIA GIT"修复：displayBranch 优先使用已选分支而非第一个运行中分支，解决添加新分支后面板仍显示 main.miduo.org 的问题 |
| fix | cds | topology 切换分支时若右侧面板已打开则自动重渲染面板内容，解决分支切换后面板信息不同步的问题 |
| fix | prd-admin | 模型管理页显示虚拟中继平台下的模型列表：从 Exchange.models 合成虚拟 Model 条目，修复"0 个模型 / 暂无模型"展示错乱 |
| fix | prd-admin | 模型管理页检测到虚拟中继平台时隐藏 添加模型 / 管理 / 删除平台 / 内联编辑，提示用户到「模型中继」页编辑 |
| fix | prd-admin | 模型管理页右侧面板：虚拟中继平台隐藏 API 密钥/地址内联编辑，改为可点击的「前往编辑」跳转按钮 |
| fix | prd-admin | 模型管理页右键菜单：虚拟中继平台显示「在「模型中继」页编辑」代替编辑/删除选项 |
| fix | prd-admin | 模型管理页启用切换 / 右侧启用 toggle：虚拟中继平台调用正确路径（跳转至中继管理 tab），不再错误调用真实平台 API |
| fix | prd-admin | 模型管理页底部操作栏：将静态提示文案改为可点击跳转「在「模型中继」页编辑」按钮（含 Link2 图标） |
| fix | prd-admin | 模型管理页左侧平台列表：宽度 256px → 320px，启用按钮加 shrink-0，修复按钮被挤出容器被裁剪的问题 |
| fix | prd-admin | 模型管理页操作按钮组：Exchange 合成模型屏蔽「设为主/意图/识图/生图」按钮（静默失败回源的根因），点击提示"通过应用模型池绑定" |
| fix | prd-api | 修复模型探针对 generation 类型永远失败的设计缺陷，跳过图片生成池探活，默认间隔调整为 180s/600s |
| feat | prd-api | 团队排行榜新增视觉生图、文学配图、上传参考图三个用量维度（image_gen_runs + upload_artifacts） |
| feat | prd-admin | 排行榜前端新增 image-gen-visual / image-gen-literary / image-upload 三列维度展示 |
| fix | prd-api | 探针后台服务默认关闭；PoolHealthTracker 内建 Half-Open 熔断器（5分钟冷却后由真实用户请求自动探活，零后台线程）|
| feat | prd-admin | GAP-10 Phase 1：将画布状态色（running/completed/failed/paused）、边框色、连线色、动画时长抽成 CSS 自定义属性，追加到 tokens.css；workflow-canvas.css 消费新变量，不再硬编码 rgba 颜色值 |
| feat | cds | P5 Phase 1：新增 CdsWorkspaceMember / CdsWorkspaceInvite 域类型；AuthStore 接口扩展成员/邀请方法；MemoryAuthStore + MongoAuthStore 实现；新增 WorkspaceService；新增 /api/workspaces 路由（CRUD + 成员管理 + 邀请流程）；Project 类型新增 workspaceId 字段；前端工作区 pill 从 /api/workspaces 动态加载 |
| fix | cds | IAuthMongoHandle 新增 membersCollection / invitesCollection；RealAuthMongoHandle 实现对应集合 |
| feat | prd-admin | 网页托管页右上角新增"投放面板"（ShareDock），拖拽站点卡片到 🌍公开 / 📤分享 / 🗑️回收站 三个槽位即可一键操作，交互参考 macOS Dock 安装隐喻 |
| feat | prd-admin | 新增 `/u/:username` 个人公开主页（无需登录），聚合展示用户所有 Visibility=public 的托管网页，支持封面、浏览量、标签展示 |
| feat | prd-api | HostedSite Model 新增 `Visibility`（private/public）+ `PublishedAt` 字段；新增 `PATCH /api/web-pages/:id/visibility` 端点切换可见性 |
| feat | prd-api | 新增 `PublicProfileController.GetProfile`（`GET /api/public/u/:username` `[AllowAnonymous]`），按用户名聚合公开托管站 |
| feat | prd-api | 新增 `InboxItem` Model 骨架 + `inbox_items` 集合注册（跨系统数据导入通道，Controller/Service/Device Flow 留待下次迭代开发） |

### 2026-04-15

| 类型 | 模块 | 描述 |
|------|------|------|
| fix | cds | UF-02 回归:`bootstrapMeLabel()` 改为幂等可重入,Device Flow ready 后主动刷新左下角徽章;未解析状态 tooltip 带诊断字符串指向哪个 probe 失败;HTML placeholder 从"未登录"改"加载中…"避免 initial flash 误导 |
| feat | cds | UF-09:Topology Variables tab 支持继承+覆盖 —— 按 branchId 拉 `/profile-overrides`,每行左侧眼睛 toggle(闭眼=继承,开眼=覆盖,橙色=CDS 基础设施锁定),右侧 value input 400ms debounce PUT 写回 branch override;共享视图回退只读 + 提示"选分支切可覆盖模式" |
| fix | cds | UF-10:拓扑视图点"编辑"不再跳回列表 —— `_topologyPanelOpenEditor`/`_topologyPanelOpenLogs`/`_topologyChooseAddItem` 三处删除 `setViewMode('list')`,全部 in-place 调用 `openProfileModal`/`openRoutingModal`/`openInfraModal`/`openLogModal`;同时替换不存在的 `renderBuildProfiles`/`renderRoutingRules` 遗留符号 |
| feat | cds | GAP-04:Topology Details 面板新增"路由"tab,按 profileId 过滤 `routingRules` 展示所有命中规则,编辑按钮 in-place 调 `openRoutingModal` |
| feat | cds | GAP-05:Topology Details 面板 Settings tab 新增"部署模式"区块,遍历 `entity.deployModes` 展示每条策略 |
| feat | cds | GAP-06:Topology Details 面板 Settings tab 新增"集群派发"区块,遍历 `executors` 展示主/远端节点 |
| feat | cds | GAP-07:Topology Details 面板新增"备注"tab,渲染 `entity.notes` + `entity.tags` 自由文本,编辑按钮 in-place 打开 profile 编辑器 |
| feat | cds | GAP-08:Topology 节点卡片右下新增可交互端口 pill,单击复制 `host:port` + toast,双击已选分支时走 `previewBranch`,否则开新标签访问 raw `host:port` |
| feat | cds | GAP-09:拓扑视图预览入口风格与列表对齐 —— 端口 pill 承担 Quick Action 角色,hover 切 accent 色 + 图标反馈 |
| feat | cds | L10N-02:`app.js` 中 Railway 术语汉化 —— "Service is online"→"服务运行中","PUBLIC URL"→"公开地址","CONNECTION STRINGS"→"连接串","SERVICE INFO"→"服务信息","Service Variables"→"环境变量","Host view/Container view"→"宿主机视角/容器视角","GitHub Repository/Database/Docker Image/Routing Rule/Empty Service"→"GitHub 仓库/数据库/Docker 镜像/路由规则/空服务";Details 面板 7 个 tab 全部改中文标签 |
| feat | cds | L10N-03:`projects.html` 汉化 —— 页面 title、"Projects/New/Dashboard/System/Personal"→"项目列表/新建项目/控制台/系统/个人工作区","Sort by: Recent Activity"→"按最近活跃排序" |
| feat | cds | FU-01:Repo Picker 分页 —— `fetchUserReposPage(token, page)` 新增,解析 GitHub `Link` header 的 `rel="next"`;`/api/github/repos?page=N` 路由返回 `{repos, hasNext, page}`;前端 Repo Picker 末尾渲染"加载更多(第 N 页)"按钮,点击追加下一页 |
| feat | cds | FU-05:Device Flow token AES-256-GCM 加密 —— 新增 `cds/src/infra/secret-seal.ts` 提供 `sealToken`/`unsealToken`,从 `CDS_SECRET_KEY` 环境变量派生密钥(支持 64-hex / base64 / SHA-256 passphrase 三种格式);`state.ts setGithubDeviceAuth` 写入前密封,`getGithubDeviceAuth` 读取时透明解密;未设置密钥时回退明文(向后兼容旧 state.json) |
| test | cds | 新增 `tests/infra/secret-seal.test.ts` 16 条单元测试,覆盖密封/解封/round-trip/tamper-detect/key-rotation/passphrase 派生/向后兼容路径;测试总数 543 → 560 |
| fix | cds | UF-14: 修复控制台反复刷屏 `SyntaxError: Unexpected end of JSON input` —— `api()` 从 `await res.json()` 改为 text-first + JSON.parse + 明确的 `isTransient` 错误标记,204/205/304 直接返 `{}`;`loadBranches` 轮询期间的瞬态错误静默吞掉,服务重启/代理 502 不再污染 console |
| fix | cds | UF-15: 修复拓扑顶栏"列表\|拓扑"切换被"+ Add"按钮遮挡 —— `.topology-fs-topbar` 的 `right` 从 16px 改为 132px,为右上角的 + Add 浮动按钮预留空间,两个控件不再共享同一 x 坐标区间 |
| feat | cds | UF-16: 拓扑 Details 面板 Deploy/Stop/Delete 按钮实时反馈 —— 点击后按钮立即变 disabled + 旋转 spinner + 文字改"部署中…/停止中/删除中",状态横幅变琥珀色 + 脉冲呼吸,横幅下方滚动最近 8 行实时日志预览(点击展开完整 modal),SSE 每块 chunk 到达都更新 DOM,列表视图和拓扑视图共用同一个 `inlineDeployLogs` Map,任一视图发起的部署在另一视图也能看到进度。新增 `_topologyRefreshIfVisible(id)` 助手,在 deploy/stop/remove 开始和结束时主动刷新拓扑面板,不用等 5 秒轮询 |
| fix | cds | UF-17: 修复拓扑顶栏在列表视图也显示(重叠) —— 上一轮 UF-15 为了防止 + Add 覆盖而给 `.topology-fs-topbar` 加了 `display:flex !important`,无意中把 `display:none` base rule 也干掉了,导致列表视图也能看到漂浮的 `列表\|拓扑` toggle ghost UI。现在去掉该 !important,依赖 `body.cds-topology-fs` 作用域;同时独立 scope `.topology-fs-view-toggle` 以防未来再出类似问题 |
| fix | cds | UF-18: 修复控制台继续报 `HTTP 400 空响应` —— 之前只有轮询的 transient 错误静默,非轮询(如 deploy 后的 `loadBranches()` refresh)仍然 log。现在 `err.isTransient` 标记所有 4xx/5xx 空响应,`loadBranches` 对 isTransient 错误静默并自动 1.5s 后重试一次,不再污染 console |
| fix | cds | UF-19: 修复拓扑 Details 面板无法关闭 —— 原因是 `+ Add` 浮动按钮(z-index 70)覆盖了面板右上角的关闭 X(panel z-index 68)。现在:(1) 面板打开时 `+ Add` 自动隐藏;(2) ESC 键关闭面板;(3) 点击画布空白处关闭面板(Figma/Miro 式);(4) 关闭按钮换用带边框的方形按钮,hover 红色强调,不再是透明小图标 |
| fix | cds | UF-20: 修复部署日志 tab 显示原始 HTML 源码 —— 根因是客户端用 `GET /api/branches/:id/container-logs?profileId=X`,但服务器只暴露 `POST /api/branches/:id/container-logs`(profileId 在 body)。GET 没有匹配路由就掉到 Express 的静态文件 SPA fallback,返回 `index.html` 当"日志"渲染。现在改为正确的 POST + `{profileId}` body,同时加 defensive guard:若 content-type 是 HTML,直接显示"服务器返回了 HTML"错误提示而不是渲染源码 |
| feat | cds | UF-21: 拓扑节点卡片图标升级 —— 废弃 emoji(🍃🔺🐘🟢 等),换成 7 个真实 SVG brand logo:GitHub(应用服务统一用)、MongoDB(绿叶 + 根茎)、Redis(多层立方体)、PostgreSQL(蓝色象)、MySQL(海豚混合)、Nginx(绿 N)、Kafka(节点图)、通用 DB 兜底。应用服务一律显示 GitHub 图标(匹配 Railway 参考图),具体栈语言在镜像 tag 行体现。底部 volume 槽的 🗄️ 也换成矢量硬盘图标(2 个 LED 灯加水平分割线) |
| feat | cds | UF-22: 拓扑节点卡片在部署中的实时动画 —— 当分支处于 building/starting 状态或 `busyBranches.has(id)` 为真时,节点卡片边框变琥珀色 + 呼吸脉冲光晕,状态圆点也同步脉冲放大。错误态固定红色边框不动(和部署中的琥珀脉冲区分开)。`_topologyNodeStatus` 也加强了:分支级 `status='building'` 就返回 building,不再等 per-service 状态出来才显示(第一个 chunk 前就有反馈) |
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
| test | cds | 新增 `tests/integration/view-parity.smoke.test.ts` 端到端 smoke test —— 14 条断言真实启动 Express app + 命中列表视图和拓扑视图共用的所有 API 路径(/branches、/build-profiles、/infra、/routing-rules、/branches/:id/profile-overrides GET/PUT/DELETE、/github/oauth/status、/projects)。跑下来实际抓出 3 个假设错误(build-profiles 会 mask secret-like key / infra 响应是 `{services:[...]}` / POST /branches 需要真 git 仓库),全部已修,现在 574/574 绿 |
| docs | cds | 新增 `doc/guide.cds-view-parity.md` —— 列表视图 16 个动作 × 拓扑视图 9 个 tab + 11 个外壳元素的功能对齐全表;标出 6 个剩余 gap(GAP-11..16)留给未来对齐 |
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
| fix | prd-api | ExchangeController 修复 JsonSerializerOptions 未指定 TypeInfoResolver 导致 JsonArray 原始类型序列化抛异常（原因：project 启用了 AOT source-gen，裸 `new JsonSerializerOptions { WriteIndented = true }` 缺失 resolver） |
| feat | prd-api | ModelExchange 新增 Models:List<ExchangeModel> 字段，中继升级为"虚拟平台"：一条 Exchange = N 个模型 |
| feat | prd-api | PlatformsController GET /api/mds/platforms 返回合并列表（真实平台 + 虚拟中继平台, kind:"real"\|"exchange"） |
| feat | prd-api | PlatformsController GET /{id}/available-models 同时支持 Exchange.Id 查询，返回其 Models 列表 |
| feat | prd-api | ModelResolver 新增按 Exchange.Id 查找分支，同时保留"__exchange__" 旧路径，向后兼容 |
| feat | prd-api | ExchangeController 新增 POST /exchanges/{id}/models/{modelId}/try-it 一键体验端点 |
| feat | prd-api | ExchangeController /for-pool 返回真实 Exchange.Id 作为 platformId，不再是硬编码 __exchange__ |
| feat | prd-api | gemini-native 模板预置 5 个结构化模型（chat + generation 混合） |
| feat | prd-admin | 中继管理页重构：表单新增"模型列表"区域（ModelId / 显示名 / 类型 / 启用），取代扁平的别名文本框 |
| feat | prd-admin | 中继卡片展示模型表格，每行一个"一键体验"按钮（调用 try-it 端点）|
| feat | prd-admin | Platform 类型新增 kind/isVirtual 字段；ModelPoolManagePage 不再硬编码合成 "__exchange__" 虚拟平台 |
| fix | prd-admin | PlatformAvailableModelsDialog 通过 platform.kind 识别虚拟中继，不再依赖 "__exchange__" 魔术字符串 |
| feat | prd-api | ModelExchange 新增 ModelAliases 字段，支持一个中继承接多个模型（Provider 级别） |
| feat | prd-api | ModelExchange.TargetUrl 支持 {model} 占位符，LlmGateway 在调度时自动替换为实际模型 ID |
| feat | prd-api | 新增 GeminiNativeTransformer，支持 Google Gemini 原生协议（OpenAI↔Gemini 请求/响应互转 + 文本/图像双模态） |
| feat | prd-api | LlmGateway 认证方案新增 x-goog-api-key（Google Gemini 原生认证头） |
| feat | prd-api | ExchangeController 新增 Gemini 原生协议导入模板（预填 URL 模版 + 5 个 Gemini 模型别名） |
| feat | prd-api | ModelResolver Exchange 查找同时匹配 ModelAlias 与 ModelAliases 列表 |
| feat | prd-admin | Exchange 管理页新增「附加模型别名」输入框 + URL {model} 占位符提示 |
| feat | prd-admin | Exchange 卡片展示附加别名列表（可点击复制） |

### 2026-04-14

| 类型 | 模块 | 描述 |
|------|------|------|
| docs | doc | 刷新「Agent 开发入门指南」：覆盖 3-27 至 4-14 的 532 个提交带来的能力变化——新增阶段 -1（涌现发散）和阶段 5（完工总结）、补齐 8 个新技能（`/emerge` `/plan-first` `/uat` `/dev-report` `/create-executor` `/bridge` `/deep-trace` `/fix-surface`）、新增"涌现思维"章节阐述反向自洽与三维涌现模型、Agent 速览补 review-agent + pr-review + 转录工作台、铁律从 5 条扩展到 7 条（导航注册默认百宝箱 + 无根之木禁令）、术语表新增 12 个新概念 |
| fix | prd-api | docker-compose.yml / docker-compose.dev.yml 的 api 服务补上 GitHubOAuth__ClientId / ClientSecret / Scopes 三个环境变量映射（docker compose 不会自动转发宿主机 env，必须显式声明），修复 PR Review Agent 提示 "尚未配置 GitHub OAuth App" 的问题 |
| fix | prd-admin | GitHubConnectCard 未配置提示改写：补充 .env 文件写法 / .bashrc 改完需重开终端 / 需要重跑 exec_dep.sh 的操作指引 |
| fix | deploy | exec_dep.sh 独立部署模式修复 nginx 502：新增 deploy/nginx/conf.d/branches/_standalone.conf (内容同 deploy/nginx/nginx.conf 的 /api → api:8080 反代)，exec_dep.sh 每次部署都幂等重建 default.conf → branches/_standalone.conf 的 symlink，修复纯净机器首次部署后所有 /api/* 都被仓库默认的 _disconnected.conf 拦成 {"error":"No active branch connected"} 的问题 |
| docs | docker-compose.yml | gateway 服务注释补齐三种部署模式（standalone/cds/disconnected）下 default.conf symlink 的指向规则，避免下一位部署者再次踩坑 |
| feat | prd-admin | 首页品牌更新：顶栏/底栏/Hero HUD 品牌名统一为「米多智能体生态平台」(Midoo Agentic Platform)，Hero 副标题替换为 MAP 官方定义，传递「企业级数字劳动力平台 · 碳硅共生」的核心定位 |
| fix | prd-admin | 首页 Hero 副标题排版收敛：容器 max-w-2xl → max-w-3xl、字号 clamp(0.95rem,1.2vw,1.125rem) → clamp(0.85rem,0.95vw,1rem)，解决长段定义换行产生尾行孤字、视觉权重压过 CTA 的问题 |
| fix | prd-admin | 智识殿堂文档阅读器（LibraryDocReader）补齐 remark-breaks 插件，保留单行换行符，避免纯文本/排版文档被 markdown 合并成一整段 |
| fix | prd-admin | 文档空间 /document-store 的 DocBrowser 同步补齐 remark-breaks 插件，修复 ASCII 框图/步骤箭头被压成一段的问题 |
| fix | prd-admin | 修复 LibraryDocReader/DocBrowser 代码块判断逻辑：原代码用 `language-` 类名判断 inline，导致未指定语言的 fenced code block（架构图/树形结构等）被错当成 inline 渲染成一颗颗药丸。改为按"内容含换行"判断块级 |
| fix | prd-admin | LibraryDocReader/DocBrowser 无语言 fenced 代码块跳过 Prism，改用纯 `<pre>` 渲染，消除 ASCII 框图上 Prism token 背景叠加导致的"多余背景色块"；同步 override `pre` 为 fragment 避免双重包裹 |
| fix | prd-admin | 举一反三：MarkdownContent（共享组件，周报/技能页等 5 处消费）和 ai-toolbox ToolDetail 的 AssistantMarkdown 存在同构 Bug A+B，同步修复（含 `pre` fragment override） |
| fix | prd-admin | 补齐 `remark-breaks` 插件：ArticleIllustrationEditorPage（7 处）、ConfigManagementDialog、VideoAgentPage、SubmissionDetailModal、RichTextMarkdownContent、GroupsPage、DefectDetailPanel、AiChatPage、ArenaPage、LlmRequestDetailDialog、LlmLogsPage、marketplaceTypes，统一单行换行行为 |
| fix | prd-desktop | KnowledgeBasePage 补齐 `remark-breaks` 插件，与管理端统一 |
| feat | prd-admin | 技能广场详情页 breadcrumb 新增「复制 MD」「下载 .zip」按钮，与「我的技能」详情页风格一致（小图标 + 切换反馈，1.8s 自动复位） |
| feat | prd-admin | 我的技能详情页 breadcrumb 同步新增「复制 MD」「下载 .zip」，与广场同构，按钮顺序按破坏性递增（复制 → 下载 → 发布 → 删除） |
| feat | prd-api | 新增 GET /api/skill-agent/skills/{skillKey}/export/zip 端点；GetSkillMd 放开已发布个人技能的非作者访问；内部拆出 ExportSkillAsZipAsync 共享 zip 打包逻辑 |
| feat | prd-api | 周报 Agent 新增团队周报分享链接：团队负责人/副负责人可为某团队+某周生成分享链接（支持密码保护与过期时间），非成员需输入密码方可访问 |
| feat | prd-admin | 「团队」Tab 新增「分享」按钮，参考网页托管的快速分享对话框；新增 /s/report-team/:token 公开查看页，未登录提示登录、非团队成员需密码、团队成员免密码 |
| fix | prd-admin | 重做「使用指引」弹窗：原来是侧栏右侧半浮层（没有遮罩、位置错乱）。改为标准居中 Dialog（深色遮罩 + createPortal + ESC/点击蒙版关闭），保留三张操作卡片与推荐流程提示 |
| fix | prd-api | SkillAgent 保存改为幂等 upsert，"需要调整"后再次保存不再静默失败或产出重复记录 |
| fix | prd-admin | 技能创建页右侧预览栏宽度改为 flex 4:6，与"测试技能"详情页一致；保存失败时显式提示原因；按钮文案在首次/再次保存间区分；移动端底部栏允许反复保存 |
| feat | prd-api | 新增 `GET /api/skill-agent/sessions/drafts` 列出当前用户未保存（SavedSkillKey 空）的会话；响应裁剪，不下发 Messages 全量 |
| feat | prd-api | ISkillAgentSessionStore 新增 ListDraftsAsync，按 LastActiveAt 倒序，利用 `UserId + LastActiveAt` 复合索引 |
| feat | prd-admin | 「我的技能」Tab 顶部新增"未完成的草稿"区；点"继续"复用 sessionStorage + CreateTab.initSession 恢复整条会话；点"删"走既有删除端点；0 条不渲染 |
| fix | prd-api | 个人技能列表端点补齐 IsPublic/AuthorName/AuthorAvatar/PublishedAt 字段，修复"发布到广场后返回详情页按钮又变回未发布"的显示错位 |
| fix | prd-api | SkillAgentController Publish/Unpublish 校验 MatchedCount、区分 404/403/400 错误码，日志记录全路径便于排查 |
| fix | prd-admin | 技能详情页"发布到广场"按钮增加操作结果反馈（成功/失败条 2.5s 自动消失），不再静默失败 |
| fix | prd-api | PublishSkill 查询作者信息时 `u.Id` 改为 `u.UserId`，修复 MongoDB Serializer 异常（User.Id 已在 BsonClassMapRegistration 中 UnmapMember，真正主键是 UserId） |
| fix | prd-admin | 技能广场卡片与详情页作者头像用 `resolveAvatarUrl` 拼接 CDN 前缀，修复直接把 AvatarFileName 当 URL 导致头像加载失败 |
| feat | prd-api | SkillAgent 会话（Messages/Intent/SkillDraft/CurrentStage/SavedSkillKey）现在持久化到 MongoDB `skill_agent_sessions` 集合：进程重启 / 2h 空闲 / 用户刷新都能恢复中间态 |
| feat | prd-api | 新增 ISkillAgentSessionStore（内存 miss 时 DB 兜底加载 + upsert 持久化 + 用户隔离过滤），Controller 的 SendMessage/AutoTest/Save/Get/Delete/ExportMd/ExportZip 全部改走 ResolveSessionAsync |
| feat | prd-api | SkillAgentSession + SkillAgentMessage 迁移到 PrdAgent.Core.Models（避免 Core 层接口反向依赖 Infrastructure） |
| feat | prd-admin | 技能创建页把 sessionId 存入 sessionStorage，页面打开时优先恢复上次会话；handleReset 会清 sessionStorage |
| docs | doc | 新增 `skill_agent_sessions` 集合的 MongoDB 索引建议（UserId+LastActiveAt 复合 + 7 天 TTL） |

### 2026-04-13

| 类型 | 模块 | 描述 |
|------|------|------|
| feat | cds | P1 多项目外壳：新增 `/api/projects` 路由（4 个端点，向下延伸到 P4 创建/删除）+ `projects.html` 项目列表着陆页 + `GET /` 302 重定向到 `/projects.html`，Dashboard header 加"← 项目"返回链接 |
| test | cds | 新增 `tests/routes/projects.test.ts` 6 条单测覆盖 GET/POST/DELETE 路径 (298/298 绿) |
| docs | cds | 对齐 `design.cds-multi-project.md` + `plan.cds-multi-project-phases.md` 的 P1 交付清单，说明前端是纯 HTML 而非 React |
| feat | cds | P2 GitHub OAuth 认证：新增 `CDS_AUTH_MODE=github` 模式 + `/api/auth/github/*` 路由 + session middleware + `login-gh.html` 着陆页，默认 `disabled` 保留向下兼容 |
| feat | cds | 新增 `AuthStore` 接口 + `MemoryAuthStore` in-memory 实现（P3 将替换为 MongoDB 后端），定义 `CdsUser` / `CdsSession` / `CdsWorkspace` domain 类型 |
| feat | cds | 首登自举：第一个 OAuth 成功的用户自动成为 system owner 并获得 personal workspace |
| test | cds | 新增 33 条 P2 单测（memory-store 13 + auth-service 13 + routes 7），全量 `pnpm test` 298 → 331 零回归 |
| docs | cds | 更新 `doc/plan.cds-multi-project-phases.md` P2 交付清单，说明"MongoDB 延迟到 P3，P2 先走 in-memory 接口"的策略调整 |
| refactor | cds | P3 Part 1：抽出 `StateBackingStore` 接口 + `JsonStateBackingStore` 实现，把 `StateService` 的 atomic write / `.bak.*` rotation / recovery 逻辑从 `state.ts` 搬到独立模块；`StateService` 改为通过 `backingStore.load()/save()` 委托持久化。为 P3 Part 2 接入 MongoDB 准备接缝 |
| feat | cds | 新增 `CDS_STORAGE_MODE` 环境变量（默认 `json`）。`mongo`/`dual` 值会在启动时抛出明确错误指向 Part 2/3，避免 .cds.env 误配置静默降级 |
| test | cds | 新增 `tests/infra/json-backing-store.test.ts` 9 条单测直测 backing store，全量测试 331 → 340 零回归 |
| feat | cds | P4 Part 1 数据模型：`CdsState` 新增 `projects?: Project[]` 字段 + `Project` 类型；`StateService` 新增 `getProjects / getProject / getLegacyProject / addProject / removeProject / updateProject` 方法 + `migrateProjects()` 启动迁移，冷启动时自动创建 legacyFlag 默认项目 |
| refactor | cds | `cds/src/routes/projects.ts` 移除 P1 时代的 `buildLegacyProject()` 硬编码，改为读 `stateService.getProjects()` 真实数据；POST/DELETE 501 响应的 `availablePhase` 更新为 `'P4 Part 2'` |
| feat | cds | P2.5 Dashboard header 加入 GitHub 用户徽章：`#cdsAuthWidget` 包含 avatar + login + 登出按钮，`bootstrapAuthWidget()` 探测 `/api/me` 后自动显隐；basic/disabled 模式下保持隐藏（零视觉回归）|
| test | cds | 新增 `tests/services/state-projects.test.ts`（13 条测 migration + CRUD + legacy 保护）；更新 `tests/routes/projects.test.ts`（6 条对齐 P4 Part 1 语义）；全量测试 340 → **353 零回归** |
| docs | cds | `doc/plan.cds-multi-project-phases.md` P4 改为三 Part 拆分描述，Part 1 交付清单 + 验收标准全部勾选 |
| feat | cds | P4 Part 2 真项目创建：`POST /api/projects` 接受 name/slug/gitRepoUrl/description，调 `docker network create cds-proj-<id>` 并持久化（带 rollback）；`DELETE /api/projects/:id` 幂等删除 docker 网络 + 项目条目，legacy 项目 403 保护 |
| feat | cds | `Project` 类型新增 `dockerNetwork?` 字段，`createProjectsRouter` 新增 shell + config 依赖注入 |
| feat | cds | 前端 `projects.html` 新增创建项目对话框（name/slug/gitRepoUrl/description 四字段 + 内联错误 + ESC 关闭），项目卡片 hover 出现删除按钮（legacy 项目除外），删除前弹 confirm 确认 |
| test | cds | 新增 9 条 POST/DELETE 单测（成功路径、4 档 400 校验、409 duplicate、500 docker 失败 + rollback、幂等网络创建、legacy 403、未知 id 404），全量测试 353 → **362 零回归** |
| docs | cds | `doc/plan.cds-multi-project-phases.md` P4 Part 2 交付清单勾选 |
| feat | cds | P4 Part 3a 数据层 project scoping：`BranchEntry` / `BuildProfile` / `InfraService` / `RoutingRule` 四个接口新增 `projectId?` 字段 |
| feat | cds | `StateService.migrateProjectScoping()` 在 load 时把 pre-P4 entries 全部标为 `'default'`；`addBranch` / `addBuildProfile` / `addInfraService` / `addRoutingRule` 在 projectId 缺失时自动填 `'default'`，保证运行时不变量：每个 entry 必有 projectId |
| feat | cds | 新增四个 read-only helper：`getBranchesForProject(id)` / `getBuildProfilesForProject(id)` / `getInfraServicesForProject(id)` / `getRoutingRulesForProject(id)`，为 Part 3b 的 project-scoped 路由铺路 |
| test | cds | 新增 `tests/services/state-project-scoping.test.ts` 13 条（迁移幂等性 + add*() 自动填充 + helpers 过滤正确性 + defensive fallback），全量测试 362 → **375 零回归** |
| docs | cds | `doc/plan.cds-multi-project-phases.md` P4 section 更新为 Part 1/2/3a 已落地 + Part 3b 待办 |
| feat | cds | P4 Part 3b 后端 project scoping：`GET /api/branches` / `/api/routing-rules` / `/api/build-profiles` / `/api/infra` 新增 `?project=<id>` 查询过滤；`POST /api/branches` 接受 `projectId` 入参并校验项目存在 |
| feat | cds | P4 Part 3b 前端 project scoping：`app.js` 新增顶部常量 `CURRENT_PROJECT_ID`（从 URL `?project=` 读），`api()` helper 自动给 scoped GET 请求注入 `?project=<id>` 过滤；创建分支时在 body 里带上 projectId；Dashboard header 链接自动显示当前项目名 |
| test | cds | 新增 3 条 branches 路由过滤测试（?project= 过滤、POST unknown projectId 400、POST 正常 stamp），全量测试 375 → **378 零回归** |
| docs | cds | `doc/plan.cds-multi-project-phases.md` P4 整体完成：Part 1/2/3a/3b 全部勾选，新增"P4 完成意义"章节总结端到端多项目能力 |
| feat | cds | P4 Part 4 Railway-fidelity UI 升级：`projects.html` 完全重写为「左侧窄 sidebar (260px) + 主内容区」布局，sidebar 含工作区切换 pill / Projects 导航高亮 / Templates/Usage/People/Dashboard 链接 / 底部用户卡；主内容区含 "Projects" 大标题 + "+ New" 主操作按钮 + 工具栏（计数 + 排序 + 视图切换）+ 项目卡网格 |
| feat | cds | 项目卡片 Railway 风格：顶部标题 + legacy badge；中间 120px 高 dotted-canvas 服务图标条（最多展示 4 个品牌图标 + N 个溢出）；底部 `production · X services` 环境与统计行；hover 浮起 + 红色删除按钮（legacy 项目除外）|
| feat | cds | `projects.js` 服务图标自动识别：内联 12 个品牌 SVG（MongoDB/Redis/Postgres/MySQL/Node/Dotnet/Python/Nginx/Git/GitHub/Docker/RabbitMQ/Elasticsearch），按 dockerImage 子串匹配；并行 fetch `/api/build-profiles?project=<id>` + `/api/infra?project=<id>`（复用 P4 Part 3b 过滤），渐进式渲染卡片（先骨架后填图标）|
| feat | cds | 用户卡位 `bootstrapMeLabel()` 从 `/api/me` 自动填充 avatar + github login；新建项目对话框样式对齐 Railway（圆角 16px、阴影加深、focus 发光） |
| feat | cds | P4 Part 5 全屏拓扑画布：`setViewMode('topology')` 现在给 `<body>` 加 `cds-topology-fs` class，CSS 隐藏 dashboard 的 header / 搜索 / 分支栏 / tag bar 等所有 chrome，把 `#topologyView` 提升到 `position: fixed; inset: 0` 占满整个视口，`.topology-card` 失去边框 + radius 和 `topology-canvas-wrap` flex:1 撑满 |
| feat | cds | 全屏模式新增浮动顶栏 `topology-fs-topbar`：左侧 ← Projects 返回 + 项目名（从 `/api/projects/:id` 异步拉取）；右侧"列表视图"切换按钮 + 主题切换；浮动底部提示条 `topology-edit-hint`："点击节点直接编辑配置·拖拽空白处平移·滚轮缩放" |
| feat | cds | 节点点击交互重做：选中分支后**单击**应用节点直接打开 override modal（原本要双击），更直观；shift+click 仍是边高亮（escape hatch）；单击 infra 节点切回列表视图并自动打开基础设施面板（infra 编辑器目前在那里）|
| docs | cds | legend 提示文案动态化：未选分支时显示"先选择上方分支，再点击节点编辑"，已选分支时显示"点击节点直接编辑该分支配置" |
| feat | cds | P4 Part 6 全屏拓扑 Railway-fidelity 改造：新增 44px 左侧 icon sub-nav（拓扑/指标/日志/设置）、顶部 breadcrumb pill（项目名 + production env + 分支下拉）、浮动 + Add 按钮 + 6 项菜单（GitHub Repo / Database / Docker / Routing / Volume / Empty Service）、右侧 460px 服务详情滑入面板含 4 个标签页（Deployments / Variables / Metrics / Settings） |
| feat | cds | 节点单击行为重做：app/infra 节点单击都打开右侧滑入详情面板（Deployments tab 显示 ACTIVE pill + image + 状态，Settings tab 显示 service info + "在编辑器中打开"按钮跳转到 override modal），shift+click 仍是边高亮 |
| feat | cds | 进入拓扑模式时自动从 branches 列表挑 main/master 作为默认分支 stamp 到下拉框，单击节点立即可编辑（不再要求用户先手动选分支） |
| feat | cds | + Add 菜单的 6 项各自路由到现有 CDS 创建流程：Database/Docker → 切回列表 + 打开 infra modal；Routing → 打开 routing-rules 配置；Empty Service → 打开 build-profiles 配置；Volume/GitHub → 友好 toast 占位 |
| docs | cds | legend 提示文案动态化 + 顶部老 chip bar / legend 在 fs 模式下完全隐藏 |
| feat | cds | P4 Part 7 — 拓扑面板 Variables tab Railway-style 表格：网格布局（key 列 + value 列 + 复制按钮列）、敏感字段（含 secret/password/token/key）值自动遮罩为 ••••••••、点 ⧉ 复制原值、空状态卡片含图标 + 引导文案、顶部 "Service Variables N" 计数 + "编辑全部" 按钮路由到 override modal |
| feat | cds | P4 Part 8 (MECE A5) — 全新空项目 Dashboard 三步引导 CTA：当 buildProfiles + infraServices 都为空时 `renderEmptyBranchesState` 返回新版本（"欢迎！开始添加你的第一个服务" + 三个按钮：进入拓扑画布 / 从 Compose 导入 / 添加构建配置 + 推荐文案）|
| feat | cds | P4 Part 8 (MECE R4) — error 状态分支卡片改为富文本失败预览块：红色边框卡片含 ⚠ 图标 + "部署失败" 标题 + "查看日志" / "重置" 内联按钮 + `<pre>` 块显示 b.errorMessage 最后 6 行 + "还有 N 行" 溢出标识，用户无需点击日志按钮就能看到错误内容 |
| feat | cds | P4 Part 9 (MECE B4) — BuildProfile 添加表单顶部新增"快速开始"模板栏：5 个一键模板按钮（Node.js / .NET / Python / Go / Static），点击自动填充 id+name+icon+image+workDir+port+install+build+run 全部字段，含 install/build 命令时自动展开高级选项，活跃模板按钮高亮，用户从 7+ 字段填写降为 1 click + 微调 |
| fix | cds | 修复 Auto-Update 重启后 5 秒硬超时直接 `location.reload()` 导致 502 的缺陷：新增 `waitForCdsHealthy` 轮询 `/healthz`（每秒一次、最长 120s、先等 down 再等 up），替换 `setTimeout(reload, 5000)` |
| chore | repo | `.gitignore` 补齐 CDS 运行时产物：`/.cds/`、`/.cds-worktrees/`、`cds/.cds.env.bak`、`cds/.cds.env.*.bak`，消除 `git status` 的无用噪声 |

### 2026-04-12

| 类型 | 模块 | 描述 |
|------|------|------|
| feat | cds | 分支级 BuildProfile 覆盖（继承 + 扩展）：每分支可独立定制 dockerImage/command/env/resources/activeDeployMode 等，未设置的字段继承公共基线 |
| feat | cds | 新增 `BuildProfileOverride` 类型 + `BranchEntry.profileOverrides` 字段 |
| feat | cds | 新增 `applyProfileOverride()` 与 `resolveEffectiveProfile()`，合并顺序：baseline → branch override → deploy mode |
| feat | cds | 新增 REST 端点：GET/PUT/DELETE `/api/branches/:id/profile-overrides[/:profileId]` |
| feat | cds | Dashboard 部署菜单新增「容器配置 (继承/覆盖)」入口 + 模态框（公共默认展示 / 字段级继承徽章 / 环境变量合并预览） |
| feat | cds | 部署日志里增加 `(分支自定义)` 标签与 `branchOverrideKeys` 详情，便于追溯 |
| test | cds | 新增 11 个单元测试覆盖合并逻辑（env 键级合并 / 优先级顺序 / 空覆盖 / deploy mode 切换） |
| feat | cds | 分支容器覆盖模态新增「保存并立即部署」按钮，一键完成保存→关闭→重部署 |
| fix | cds | `GET /api/branches/:id/profile-overrides` 的 `effective.env` 现在包含 CDS_* 基础设施变量，与运行时实际注入保持一致（新增 `cdsEnvKeys` 字段标识来源） |
| fix | cds | 覆盖模态的公共默认 env 预览从纯文本 `<pre>` 改为可点击列表，CDS_* 变量橙色标注，每行带「→ 编辑」按钮可一键复制到覆盖区 |
| fix | cds | `_collectOverrideFromForm` 正确识别 `KEY=` 空值（保留为空字符串），不再被误判为「继承」 |
| fix | cds | 保存覆盖前检测 CDS_* 变量覆盖，弹出二次确认防止误伤 MongoDB/Redis 等基础服务连接 |
| fix | cds | 保存时跟踪环境变量解析行数，有跳过时 toast 提示「已识别 N 条，跳过 M 条格式错误行」 |
| fix | cds | `PUT /api/branches/:id/profile-overrides/:profileId` 后端拒绝 `containerPort <= 0`，前端 number input 加 `min="1"` |
| fix | cds | 保存/重置请求进行中时禁用所有按钮，防止重复提交 |
| fix | cds | 后端 `env` 字段校验改为排除 null 和数组（`typeof x === 'object'` 陷阱） |
| fix | cds | 后端过滤掉 env 中非字符串值，避免 `undefined`/数字泄漏到 Docker env-file |
| feat | cds | 分支子域名别名（Subdomain Aliases）：每个分支除默认 `<slug>.<rootDomain>` 外可额外挂 N 个稳定别名 |
| feat | cds | 新增 `BranchEntry.subdomainAliases?: string[]` 字段 + state 层 get/set/findBranchByAlias/findAliasCollisions |
| feat | cds | ProxyService.extractPreviewBranch 先查别名，命中则路由到对应分支；未命中才退回 slug 兜底。别名总是胜过同名 slug |
| feat | cds | 新增 REST 端点：GET/PUT `/api/branches/:id/subdomain-aliases`，带 DNS 合法性校验 + 保留字拦截（www/admin/switch/preview/cds/master/dashboard）+ 跨分支冲突检测（409） |
| feat | cds | 容器配置 modal 新增独立的 `🌐 子域名` 标签页（分支级，不属于任何 profile）：chip 列表 + 单行添加 + 即点即删 + 每个别名的预览 URL 直达 |
| feat | cds | 别名保存立即生效，无需重新部署（代理层级改动，非容器启动时合并） |
| test | cds | 新增 9 个 state 单元测试（set/get/findBranchByAlias/findAliasCollisions 的 slug 冲突、alias 冲突、case-insensitive、自引用豁免） |
| test | cds | 新增 6 个 proxy 单元测试（extractPreviewBranch 别名命中、大小写不敏感、别名胜过同名 slug、非 rootDomain 返回 null、端口号剥离） |
| feat | cds | 拓扑视图（画板模式）：列表/拓扑切换按钮 + 分层 DAG 图（SVG） + 分支选择器 + 依赖线（弯曲贝塞尔 + 箭头） |
| feat | cds | 画板节点自动布局：Kahn 算法按 depends_on 分层，infra 在最左侧 / app 按依赖链向右 |
| feat | cds | 分支级覆盖徽章：选中一个分支后，所有被该分支自定义的 profile 节点显示 🌿 + 绿色高亮边框，hover 显示被覆盖的字段列表 |
| feat | cds | 节点点击直达：点击 app 节点 → 自动打开容器配置 modal 并定位到对应 profile tab（`openOverrideModal` 新增 `preferredProfileId` 参数） |
| feat | cds | 基础设施节点 = 圆角胶囊形（rx=22），应用节点 = 矩形（rx=8），视觉差异化 |
| feat | cds | 拓扑视图与列表视图共享同一数据源（已有的 polling）——切换到拓扑不需额外 fetch，依赖分支覆盖的 override 集合按需懒加载并缓存 |
| feat | cds | View mode 持久化到 sessionStorage（`cds_view_mode`），遵守 CDS "禁止 localStorage" 规则 |
| feat | cds | 拓扑视图大修：向 Railway 对齐（rich cards + pan/zoom + toolbar + click-focus edge highlight） |
| feat | cds | 列表/拓扑 toggle 移到 header 右上角（靠近主题/设置按钮），符合用户反馈 |
| feat | cds | 节点卡片翻倍信息密度 236×110：服务图标 + 名称 + 状态点(运行中/构建中/错误/待命 彩色) + 镜像缩写 + 端口 + 依赖数 + 🌿 自定义 pill |
| feat | cds | 根据镜像名/服务 ID 自动选图标：mongo→🍃 / redis→🔺 / postgres→🐘 / node→🟢 / dotnet→🟣 / python→🐍 / rust→🦀 等 |
| feat | cds | 画布背景改为 grid-dot radial-gradient（`background-size: 22px 22px`），替代旧的 dashed border，观感接近 Railway |
| feat | cds | Pan/zoom：鼠标滚轮以光标为中心缩放 (0.3x–2.5x)，拖拽平移，cursor 状态联动 grab/grabbing |
| feat | cds | 底部左下工具条：放大 / 缩小 / ⊡ 自适应缩放 / ◉ 1:1 复位 + 右上角缩放百分比指示器 |
| feat | cds | 单击节点 → 聚焦（高亮所有相连的边 + 其他节点灰显）；双击节点 → 打开容器配置 modal 并定位到对应 profile tab |
| feat | cds | 从 `branch.services[profileId].status` 读实时状态，驱动节点状态点着色（running=绿 / building=琥珀 / error=红 / idle/stopped=灰） |
| feat | cds | 依赖连线改为虚线 + 箭头 + 聚焦时高亮绿色实线；无依赖的服务不再孤立显示为问题，而是明确表达"独立服务" |
| refactor | cds | 节点尺寸常量抽成 `TOPO_NODE_W/H/GAP_X/Y/PAD`，后续调优无需改多处 |
| fix | prd-admin | 修复首页 ProductMockup 在首屏加载时因 IntersectionObserver 阈值不满足而不显示的问题 |
| fix | prd-admin | 修复 FeatureDeepDive 各 mockup 示意文案未跟随语言切换（hardcoded 中文），现已全部接入 i18n |
| fix | prd-admin | 修复周报 ReportMockup 柱状图因 flex 子元素缺少 h-full 导致百分比高度为 0、柱子不显示的问题 |
| fix | prd-admin | CompatibilityStack 中文平台名（阿里通义/智谱/百度/字节）切换英文时显示国际品牌名 |
| feat | prd-api | 支持多对象存储 Provider 切换（tencentCos / cloudflareR2），通过 ASSETS_PROVIDER 环境变量选择 |
| refactor | prd-api | 补全 IAssetStorage 接口（TryDownloadBytesAsync、ExistsAsync），消除 14 处 TencentCosStorage 类型耦合 |
| feat | prd-api | 新增 CloudflareR2Storage 实现（S3 兼容 API，AWSSDK.S3），支持 Cloudflare R2 对象存储 |
| refactor | prd-api | Base64 扩展方法改为基于 IAssetStorage 接口，不再绑定具体存储实现 |
| feat | prd-api | 新增 asset_registry 资产登记簿，每次存储操作自动登记（scope: system/user/generated/log） |
| feat | prd-api | RegistryAssetStorage 装饰器：透明包裹真实存储，零改调用点即可启用登记 |
| fix | prd-admin | PR 审查卡片折叠态直接显示具体错误原因，无需展开即可看到 |

### 2026-04-11

| 类型 | 模块 | 描述 |
|------|------|------|
| refactor | prd-admin | ArenaPage 沿用 Linear × Retro-Futurism 风格：新增 StaticBackdrop `mode='absolute'` 支持 AppShell 内嵌页使用（避免 `fixed` 穿透侧边栏），Arena 根容器改为 `relative` + `<StaticBackdrop mode="absolute" />` 六层静态背景；侧边栏/顶栏/底栏全部改为玻璃化背板（`rgba(10,14,22,0.52-0.62) + blur(10-12px)`）；"新建对战"和"发送"按钮换成 `HERO_GRADIENT` 渐变药丸；顶栏新增渐变 Swords 徽章 + `BLIND · LIVE` HUD chip；空态欢迎页换成 `Reveal` 阶梯进场 + `BLIND · ARENA` eyebrow + Space Grotesk 慢呼吸标题（`arena-title-pulse`）；对战面板改成带 labelColor 发光边框的玻璃卡 + Space Grotesk 字母徽章；底栏进度环 conic-gradient 从单色 indigo 改为签名三色渐变；保留所有 SSE/Run 业务逻辑、handler、state 不变。 |
| refactor | prd-admin | `StaticBackdrop` 增加 `mode?: 'fixed' \| 'absolute'` prop：默认 `fixed` 保持 LoginPage / LandingPage 行为不变；新增 `absolute` 模式专供 AppShell 内 Outlet 页使用（如 ArenaPage），仅填满最近的 `relative` 父容器，不会穿透左侧导航和顶栏。 |
| docs | - | 更新 `doc/rule.landing-visual-style.md` R2 章节：新增两种挂载模式的使用表格（独立全屏页走默认 `fixed`，AppShell 内 Outlet 页走 `mode="absolute"`），加入"禁止在 AppShell 内 Outlet 页使用默认 fixed 模式"的反面规则。 |
| feat | cds | 设置菜单新增「退出集群」快捷入口，hybrid/executor 角色直接一键退出，无需再进入集群弹窗 |
| fix | cds | 单节点 scheduler 模式电池徽章恢复为本地容器槽视图（不再卡在「集群 …」占位），仅在实际有远端执行器时切换为集群视图 |
| fix | cds | 首次加载分支列表不再闪现「暂无分支」过渡文案，初始保留 CDS 加载动画直到数据就绪，空状态升级为带插图+CTA 的设计态 |
| fix | cds | DELETE/停止分支现在会识别 entry.executorId 并代理到远端执行器 /exec/delete /exec/stop，不再只清掉主节点状态而留下僵尸容器 |
| feat | cds | scheduler 启停改为 UI 开关：新增 PUT /api/scheduler/enabled + SchedulerService.setEnabled + state.json 持久化，容量弹窗内 on/off 切换，状态通过 state-stream 广播 |
| feat | cds | 执行器状态页加入详细的「为什么没有 Dashboard」解释（避免 split-brain / 运维成本 / 控制平面单一），并指引使用主节点的退出集群按钮 |
| chore | cds | 单节点模式隐藏多余的「执行器集群 1/1 在线」面板，header 电池徽章已充分展示容量 |
| perf | cds | restart 重排为 "先 build 再 stop"：tsc 在旧进程还在服务时就写出 dist，停掉旧进程到新进程绑端口的空窗从 10-16s 收缩到 2-4s，消除 Cloudflare 502 Bad gateway 体感 |
| perf | cds | tsconfig 开启 incremental + tsBuildInfoFile，warm 构建从 5s 降到 3s（小 VM 收益更明显） |
| feat | cds | 前端新增重启检测遮罩：SSE 中断时展示"CDS 正在重启"卡片，轮询 /healthz，后端恢复后自动刷新页面，替代原本的 Cloudflare 502 硬错 |
| refactor | prd-api | 新建 GitHub 基础设施层 `PrdAgent.Infrastructure.GitHub`，参照 LlmGateway 的"独立组件"定位，供 PR 审查工作台、未来的日报/检测等多应用复用同一套 GitHub REST 封装 |
| refactor | prd-api | 抽取 `IGitHubClient` 接口 + 把 `GitHubPrClient`（899 行）从 `Services/PrReview/` 迁移到 `Infrastructure/GitHub/`，实现接口；业务层通过接口注入，和凭证来源（per-user OAuth/per-app PAT/GitHub App token）完全解耦 |
| refactor | prd-api | 抽取 `IGitHubOAuthService` 接口 + 把 `GitHubOAuthService`（Device Flow RFC 8628 + HMAC 签名 flow_token）从 `Services/PrReview/` 迁移到 `Infrastructure/GitHub/`，实现接口 |
| refactor | prd-api | 把 `PrUrlParser`（SSRF 白名单 + URL 解析）从 `Services/PrReview/` 迁移到 `Infrastructure/GitHub/`，作为通用 GitHub PR URL 工具类 |
| refactor | prd-api | 新建 `GitHubException` 基类持有通用 GitHub 错误码（NotConnected/TokenExpired/RepoNotVisible/RateLimited/OAuth/DeviceFlow 等 13 个工厂方法）；`PrReviewException` 改为继承自 `GitHubException`，只保留 PR 审查应用专属的 `ItemNotFound`/`Duplicate` |
| refactor | prd-api | `PrReviewController` 改用 `IGitHubClient` + `IGitHubOAuthService` 接口注入；9 处 `catch (PrReviewException)` 改为 `catch (GitHubException)` 基类捕获（多态兼容），行为零变化 |
| refactor | prd-api | `Program.cs` DI 注册改为接口→实现形式：`IGitHubClient → GitHubPrClient`、`IGitHubOAuthService → GitHubOAuthService`；HttpClient "GitHubApi" 命名客户端配置保持不变 |
| refactor | prd-api | 单测 `PrUrlParserTests.cs` 的 `using` 从 `PrdAgent.Api.Services.PrReview` 改为 `PrdAgent.Infrastructure.GitHub`，测试代码本身无改动 |
| docs | doc | 新增 `doc/design.github-infrastructure.md`，记录 GitHub 基础设施层的分层结构、与 LlmGateway 的异同、per-app 授权模型、未来扩展路径（Commits/Issues/CheckRuns 操作按需追加） |
| refactor | prd-admin | 首页 /home 去紫（减少"AI 紫"套路感，参照 linear.app）：StaticBackdrop 顶部紫色径向光晕改为 slate/冷白 + 微弱 teal；Hero HUD chip 紫边改 slate-300 边 + 绿色 live dot；Hero 主标题 text-shadow 去紫改为 slate + 青；Hero Tron 地板紫色竖线改 slate-300；FeatureDeepDive section header accent 从 #a855f7 改 #cbd5e1（slate-300） |
| feat | prd-admin | Hero 新增 TechLogoBar：CTA 组下方加"POWERED BY"大模型文字 logo 条（GPT-5 · Claude 4.6 · Gemini 2.5 · Grok 4 · Llama · DeepSeek V3 · Kimi K2 · Qwen 3 · GLM 4.6 · Wenxin），灰度 display 字体 + 圆点分隔，hover 亮起；解决"首屏有点单调"问题 |
| feat | prd-admin | 新增 ThreePillars 幕：对标 linear.app 的"A new species of product tool"编辑式 3 列布局，放在 StatsStrip 和 FeatureDeepDive 之间。顶部 eyebrow + 大编辑式标题 + 副标；3 列带 fig 01.1 / 01.2 / 01.3 标签 + wireframe 线框示意（Layers/Network/Monitor 图标 + grid pattern + 角标 tick）+ h3 + 描述，列间竖向分割线 |
| fix | prd-admin | FeatureDeepDive 容器从 max-w-6xl (1152px) 拉宽到 max-w-[1240px]，列间距从 md:gap-20 拉到 md:gap-28，px 内边距增加 md:px-10；解决"挤在中间了"问题 |
| feat | prd-admin | i18n 字典新增 hero.techBarLabel + hero.techItems + pillars 全量双语字段 |
| refactor | prd-admin | FeatureDeepDive 瘦身（解决"过大而非大气"）：容器 max-w-[1440px] → max-w-[1200px]；title clamp(2.25,5vw,4.5rem) → clamp(1.875,3.6vw,3.25rem)；mockup 砍掉 grid pattern 背景 + xl margin labels；mockup 外层 padding px-28 → px-10；block 间距 space-y-44/56 → space-y-32/40；描述/bullets 字号收紧；每块目标 ≈ 1 视口 |
| feat | prd-admin | 新增 WorkflowCanvas 幕（对标 linear.app "Move work forward / Understand progress at scale"）：上半 eyebrow + 大标题 + 描述 + chapter marker（2 列），下半 canvas mockup 全宽带 5 节点 workflow pipeline（触发器 → PRD 分析师 → 视觉设计师 → 文学创作者 → 发布），节点含 done/running/pending 三态，边 progress 填充 + pulse 动画 + status footer。严格遵循"一屏一个视觉语言"原则。插入 FeatureDeepDive 和 Cinema 之间 |
| feat | prd-admin | i18n 字典新增 workflow 全量双语字段（eyebrow / title / description / chapterMarker / canvasTitle / runLabel / nodes[5] / status.{running,elapsed,eta,trace}）|
| refactor | prd-admin | 首页 /home 全面重构为九幕 Linear.app 风结构：Hero → StatsStrip → FeatureDeepDive → Cinema → HowItWorks → AgentGrid → CompatibilityStack → FinalCta → Footer |
| feat | prd-admin | 新增 StatsStrip 幕：极简大数字横条（15+/14/98/99.9%），无卡片无图标 |
| feat | prd-admin | 新增 FeatureDeepDive 幕：六大核心 Agent（视觉/文学/PRD/视频/缺陷/周报）左右交替深度展示，每段配专属几何 mockup（2×2 生成图网格 / 润色文本 / PRD 缺口标注 / 视频分镜时间线 / 缺陷 triage 卡片 / 周报对比条形图） |
| feat | prd-admin | 新增 HowItWorks 幕：三步流程（提问 → Agent 选型 → 流式输出），带步骤间连接渐变线 |
| feat | prd-admin | 新增 AgentGrid 幕：从 toolboxStore.BUILTIN_TOOLS 真实驱动 15 个 Agent 卡片，4 列网格，每卡独立 accent color + hover 光晕，Dedicated/Assistant 分类徽章 |
| feat | prd-admin | 新增 CompatibilityStack 幕：12 家 LLM Provider 文字 logo 矩阵（OpenAI/Anthropic/Gemini/DeepSeek/Kimi/通义/GLM/文心/豆包 等），区域标签 |
| feat | prd-admin | 新增 FinalCta 幕："现在，轮到你了" 收束 CTA，稀缺渐变第二次也是最后一次出现 |
| feat | prd-admin | 新增 MinimalFooter 幕：极简单行页脚（logo + GitHub + 版权） |
| refactor | prd-admin | LandingPage 重写：九幕 SCENE_COLORS 场景色编排，Starfield 降到 18% 不透明度作材质，顶栏导航改为 产品/Agent/片花/流程/兼容/文档 |
| fix | prd-admin | 删除六个旧 section（LibrarySection 克莱风空壳 / FeatureBento / SocialProof / AgentShowcase / DownloadSection / CtaFooter）+ 三个孤儿组件（CountUpNumber / GlowOrb / ParticleField），首页目录从 10 个 section 精简到 9 个全新 section |
| feat | prd-admin | 首页 /home Hero 新增 Aurora 极光渐变背景（4 层彩色 blob 用 mix-blend-mode: screen 叠在 Starfield 之上，形成星云质感） |
| feat | prd-admin | 首页 Hero 新增 4 张浮动 Agent 活动卡（视觉/文学/PRD/视频），frosted glass + 进度条 + pulse dot + 鼠标视差 + 呼吸漂浮，让首屏"活起来" |
| fix | prd-admin | 修复 Hero 主标题在宽屏下"呼吸"两字被截断换行的 bug — 标题拆为"让创造 / 自由呼吸"两行，字重与字号错落（300 / 500），视觉节奏更强 |
| feat | prd-admin | Hero 中心内容加入鼠标微视差（CSS 变量驱动，零 React re-render） |
| refactor | prd-admin | 首页 /home Hero 全面重写为 Linear.app 风格：删除 AuroraBackground 极光 mesh、FloatingAgentCards 浮动假卡、BlurText 每字扫光、鼠标视差，杜绝"2024 AI 创业公司"视觉套餐 |
| feat | prd-admin | 新增 ProductMockup 组件：真实感 MAP 应用壳（浏览器 chrome + icon 侧栏 + 对话列表 + 视觉 Agent 生成 4 张候选图的流式场景），作为首屏 CTA 下方的产品证据，替代之前的假浮动卡 |
| refactor | prd-admin | Hero 背景改为 Linear 签名动作：单一顶部径向光晕（紫→透明），LandingPage 把 Starfield 降到 22% 不透明度作材质 |
| refactor | prd-admin | Hero 主标题改回单行"让创造，自由呼吸"，单字重 medium + 负字距 -0.035em + max-width 16ch，editorial 感取代双行字重差 drama |
| refactor | prd-admin | Hero 动效改为一次性 CSS fade-up（hero-fade-up + mockup-rise），移除 BlurText 每字扫光动画 |
| feat | prd-admin | 首页 /home 新增中英文切换器（仅首页，顶栏右上角 `中/EN` 胶囊 toggle） |
| feat | prd-admin | 新建 i18n/landing.ts 双语字典（涵盖 nav/hero/stats/features/cinema/how/agents/compat/pulse/download/cta/footer 全部可见文案），结构化 TranslationShape interface |
| feat | prd-admin | 新建 contexts/LanguageContext.tsx：LanguageProvider + useLanguage hook，sessionStorage 记忆语言选择，同步更新 `<html lang>` |
| feat | prd-admin | 新建 components/LanguageToggle.tsx：中英切换 pill，当前语言高亮 + 霓虹边框 |
| feat | prd-admin | 全部 9 个 section（Hero/Stats/FeatureDeepDive/Cinema/HowItWorks/AgentGrid/CompatibilityStack/CommunityPulse/DesktopDownload/FinalCta/MinimalFooter）接入 useLanguage，文案从字典读 |
| feat | prd-admin | FeatureDeepDive 段落感升级：每个 feature block 内部 7 级 stagger reveal（chapter 号 → eyebrow → title → desc → bullets 逐条 → learn-more → mockup），让页面"徐徐前进地拼凑出来" |
| feat | prd-admin | FeatureDeepDive 新增 chapter 编号分段符 `CHAPTER 01 / 06`（VT323 mono + 霓虹发光），每段开头出现，作为"新段落开始"的明确视觉信号 |
| refactor | prd-admin | FeatureDeepDive block 间距从 space-y-32/44 拉大到 space-y-44/56，header mb 从 32/40 拉大到 36/48，gap 从 md:gap-16 拉到 md:gap-20 —— 解决 "六个专业 Agent，一个工作台" 上下挤感 |
| refactor | prd-admin | 首页 /home Hero 精简到"一屏一主角"（删除 10+ 堆料元素，保留超大显示标题 + 单行副标 + 双 CTA + scroll 提示） |
| feat | prd-admin | 新增 SignatureCinema 幕（全宽 16:9 电影位），预留视频 src 入口，缺失时降级为径向渐变 poster + 播放图标 + "即将上线"签名 |
| feat | prd-admin | LandingPage 接入 IntersectionObserver 滚动场景编排：Hero/Showcase/Cinema/Library/Features/Evidence/Download/CTA 八幕各自对应一种 Starfield themeColor，粒子宇宙随叙事流动 |
| feat | prd-admin | 引入 Space Grotesk + Inter 作为品牌显示/正文字体（Google Fonts 非阻塞加载，新增 --font-display / --font-body CSS tokens） |
| refactor | prd-admin | 顶栏导航增加「片花」入口，删除「案例」，观看片花 CTA 现在滚到 #cinema 与标签语义一致 |
| fix | prd-admin | 修复 StatsStrip 后方诡异"银色金属条"伪影：StaticBackdrop 的 synthwave 地平线/太阳/Tron 地板从 fixed 全屏搬到 HeroSection 本地，避免 fixed 42% 位置穿透后续 section |
| feat | prd-admin | 新增 useInView hook + Reveal 组件：Intersection Observer 驱动的 fade-up 滚动进场动效，prefers-reduced-motion 尊重，触发一次不重复 |
| feat | prd-admin | 新增 SectionHeader 共享组件：统一所有 section 头部版式（Lucide icon HUD chip + VT323 eyebrow + h2 + 可选 subtitle），内置 Reveal 分步进场 |
| feat | prd-admin | 全站 section chip 的 Unicode 符号 ✦ ► » ⚡ ★ 替换为真 Lucide 图标：Sparkles / Users / Workflow / Zap / Star / Radio / Download |
| fix | prd-admin | Hero CTA 重做对称两按钮：h-12 + rounded-full + icon 前置，消除之前一个实 pill 一个纯文字的视觉不平衡 |
| fix | prd-admin | FeatureDeepDive 头部间距：pt-10 + mb-32→40，六段之间 space-y-32→44，修复"六个专业 Agent"章节上下挤感 |
| fix | prd-admin | StatsStrip 去掉 border-y 金属条效果，改为纯留白 + 每数字独立 Reveal stagger |
| feat | prd-admin | Hero 主标题加 ambient neon pulse（5s 呼吸发光）+ 终端 HUD chip 同步 pulse |
| feat | prd-admin | 所有 section 内容接入 Reveal：Hero 分 5 级 delay（chip→title→subtitle→CTA→mockup），其他 section stagger 80-120ms |
| feat | prd-admin | ProductMockup 内容接入 i18n：左侧 5 条对话列表（标题 + meta）、"新对话"按钮、顶部标题栏标题和状态、分享/继续生成按钮、用户消息气泡、Agent 回复、生成进度、输入框 placeholder —— 全部双语 |
| fix | prd-admin | 顶栏英文溢出修复：nav gap 从 gap-8 缩到 gap-5/lg:gap-7；品牌文字 "Midor Agent Platform" 从 `sm:inline` 改为 `xl:inline`（英文较长时移到大屏才显示）；容器从 max-w-7xl 拉到 max-w-[1440px]；nav 链接加 whitespace-nowrap |
| feat | prd-admin | FeatureDeepDive 布局彻底重做成 Linear 图 2 风格（解决"挤在中间了"）：<br>· 容器 max-w-[1240px] → max-w-[1440px] 且 md:px-12<br>· 抛弃 2-col 左右交替，改为**上 Eyebrow 横条 + 中 2-col (大标题 1.3fr + 描述/bullets 1fr) + 下 full-width mockup display window**<br>· 大标题 clamp(1.75-3.25rem) → clamp(2.25-4.5rem) 编辑式放大<br>· Mockup 全宽容器带 48px grid pattern 背景 + 顶边 accent scanline + xl 屏左右 margin 里的 fig/id/version 标签（模仿 Linear 技术注释风）<br>· mockup 本体宽度保持 980px 居中，两边留大量呼吸空间（使用 padding 而非强拉伸）|
| feat | prd-admin | 首页 /home 融合 retro-futurism gaming 元素（ui-ux-pro-max 推荐的 Retro-Futurism + Synthwave 风格，参照 App Store Style Landing 模式） |
| feat | prd-admin | StaticBackdrop 重构：新增 Tron 透视地板网格（CSS 3D perspective 62° 紫青双向 40px 格 + mask fade）+ Synthwave 地平线光带 + 合成太阳光斑 + CRT 横向扫描线 overlay（0.025 opacity, mix-blend-overlay） |
| feat | prd-admin | 接入 VT323 终端字体（Google Fonts），新增 --font-mono token，全站 section eyebrow/HUD 标签统一用 VT323 + 霓虹 text-shadow |
| feat | prd-admin | Hero chip 改为终端 HUD 状态条：SYSTEM ONLINE + 绿色 pulse dot + MAP 标识，紫色发光边框 |
| feat | prd-admin | Hero 主标题"让创造，自由呼吸"加 neon text-shadow（紫 + 青 + 玫瑰三层发光） |
| feat | prd-admin | FeatureDeepDive / AgentGrid / HowItWorks / CompatibilityStack / FinalCta section eyebrow 全部升级为 VT323 mono HUD chip（带 scanline 式发光符号 ✦ ► » ⚡ ★） |
| feat | prd-admin | AgentGrid 每张卡片新增 LV.XX 游戏等级徽章（Dedicated = LV.99, Assistant = LV.42） |
| feat | prd-admin | 新增 CommunityPulse 幕：LIVE·PULSE HUD 标签 + 4 张大号 stat（ACTIVE AGENTS / CONVERSATIONS 24H / TOKENS / MEDIA）+ Weekly Leaderboard Top 5 Agent 排行榜 |
| feat | prd-admin | 新增 DesktopDownload 幕：DESKTOP CLIENT HUD 标签 + 3 张平台卡（macOS / Windows / Linux）+ Tauri 2.0 原生客户端介绍 + 系统托盘/快捷键 bullet |
| refactor | prd-admin | LandingPage 从 9 幕扩展到 11 幕，导航改为 产品/Agent/片花/社区/下载/文档 |
| refactor | prd-admin | 首页 /home 背景彻底改为静态：新增 StaticBackdrop 组件（纯 CSS，零动画零粒子零 canvas），参照 Linear.app + Vercel.com 做法 |
| feat | prd-admin | StaticBackdrop 五层：#050508 纯底 / 32px 点阵网格（顶浓底淡 mask）/ 顶部紫色径向光晕 / 底部玫瑰微光 / 细噪点 overlay |
| refactor | prd-admin | 删除 StarfieldBackground.tsx（WebGL 粒子连线 shader），LandingPage 移除场景色编排 IntersectionObserver 逻辑（静态背景无需切换色温） |
| refactor | prd-admin | HeroSection 移除本地顶部径向光晕，统一由 StaticBackdrop 提供，避免两层叠加 |
| feat | prd-admin | FeatureDeepDive VisualMockup 内部加分步进场动画（克制版）：4 个生成图 grid 接入 useInView，每格 stagger 120ms 入场（opacity 0→1 + scale 0.94→1 + translateY 14→0），done 2 格的绿色对勾延迟 pop-in 带弹性 overshoot（cubic-bezier 0.34, 1.56, 0.64, 1），generating 2 格叠加 shimmer 横扫（延迟在自身入场后开始），prefers-reduced-motion 尊重。只作用于 Visual 一段强化"生成中"叙事，不影响其他 5 个 mockup。 |
| refactor | prd-admin | LoginPage 沿用 PR #405 首页的 Linear × Retro-Futurism 视觉语言：StaticBackdrop 六层静态背景 + Hero 局部 retro 装饰（synthwave 地平线 / 合成太阳 / Tron 地板）+ HERO_GRADIENT 主 CTA pill + HUD chip eyebrow + Space Grotesk 呼吸标题 + VT323 mono 表单 label + Reveal 阶梯进场，替换原 RecursiveGridBackdrop + prd-login-card 老玻璃样式；业务逻辑（login/首次登录重置密码/权限拉取）保持一致。 |
| docs | - | 新增 doc/rule.landing-visual-style.md 沉淀首页/登录页共用的 10 条视觉语言规则（签名渐变、StaticBackdrop、字体三件套、Reveal、HUD chip、对称 CTA、neon pulse、去紫、玻璃卡片、i18n），作为后续扩展新页面时的统一风格权威。 |
| feat | prd-api | PR Review V2 档 3 对齐度检查：新增 PrAlignmentService，通过 ILlmGateway 流式调用 LLM，对比 PR 描述 vs 实际代码变更 + 关联 issue，输出 Markdown 对齐度报告（遵守 llm-gateway.md 规则） |
| feat | prd-api | GitHubPrClient 扩展：新增 files（前 80 个，每 patch 截断 4KB）+ body（截断 20KB）+ 关联 issue（Closes #N 解析，body 截断 8KB）的拉取，防 MongoDB 单文档膨胀与 LLM 上下文爆炸 |
| feat | prd-api | PrReviewItem + PrReviewSnapshot 新增 Body / Files / LinkedIssue* / AlignmentReport 字段，承载档 3 所需的 AI 上下文与结果 |
| feat | prd-api | PrReviewController 新增两个端点：GET /items/{id}/ai/alignment（读缓存）+ GET /items/{id}/ai/alignment/stream（SSE 流式，按 phase/typing/result/error 事件推送） |
| feat | prd-api | PrAlignmentService prompt 强约束 Markdown 输出结构（对齐度% + 总结 + 已落实 + 没提但动了 + 提了没见到 + 关联 Issue 对齐 + 架构师关注点），后端同时解析出 Score + Summary 落库 |
| feat | prd-admin | 新增 AlignmentPanel 组件：基于 useSseStream 订阅 SSE 流，四态切换（idle / running / done / error），支持中止、重新分析、缓存展示，打字机预览 + 阶段文案遵守 llm-visibility 规则 |
| feat | prd-admin | AlignmentPanel 结构化渲染：解析 markdown 章节为色彩化卡片（emerald/amber/red/violet 对应 已落实/没提但动了/提了没见到/架构师关注点），头部展示对齐度分数徽章 + 重跑按钮 |
| feat | prd-admin | prReview 服务层新增 getPrReviewAlignment / getPrReviewAlignmentStreamUrl；usePrReviewStore 新增 setAlignmentReport 方法同步流完成后的结果；PrItemCard 展开态嵌入 AlignmentPanel |
| feat | prd-api | PR Review V2 后端：新增 PrReviewErrors 统一错误码与 PrReviewException 领域异常，消灭 404 歧义（REPO_NOT_VISIBLE vs PR_NUMBER_INVALID） |
| feat | prd-api | PR Review V2 后端：新增 GitHubOAuthService，用 HMAC(Jwt:Secret) 签名 state 实现无状态 CSRF 防护，支持 code→token 兑换与 /user 信息拉取 |
| feat | prd-api | PR Review V2 后端：新增 GitHubPrClient，happy path 单次调用 + 404 两步探测（先查 /pulls 失败再探 /repos 区分仓库可见性） |
| feat | prd-api | PR Review V2 后端：新增 PrReviewController 十端点（auth status/start/callback/disconnect + items CRUD/refresh/note），严格按 userId 隔离 |
| feat | prd-api | AdminPermissionCatalog 新增 pr-review.use 权限位，与旧 pr-review-prism.use 并存 |
| refactor | prd-api | PR Review V2 切换到 GitHub Device Flow (RFC 8628)，取代 Web Flow。原因：CDS 动态域名（<branch>.miduo.org）与 Web Flow Callback URL 预注册机制不兼容，Device Flow 无需 callback，本地/CDS/生产共用一套代码 |
| refactor | prd-api | GitHubOAuthService 重写：StartDeviceFlowAsync + PollDeviceFlowAsync + HMAC 签名的无状态 flowToken（base64url(deviceCode|userId|expiry|hmac)，FixedTimeEquals 防时序攻击） |
| refactor | prd-api | PrReviewController 新增 POST /auth/device/start 与 POST /auth/device/poll，删除 /auth/start、/auth/callback、ResolveBaseUrl、BuildCallbackUrl 等 Web Flow 遗留 |
| refactor | prd-api | PrReviewErrors 新增 DEVICE_FLOW_TOKEN_INVALID / DEVICE_FLOW_EXPIRED / DEVICE_FLOW_ACCESS_DENIED / DEVICE_FLOW_REQUEST_FAILED；移除 state 相关错误码 |
| refactor | prd-admin | services/real/prReview.ts 替换 startPrReviewOAuth 为 startPrReviewDeviceFlow + pollPrReviewDeviceFlow，新增 PrReviewDeviceFlowStart/Poll 类型 |
| refactor | prd-admin | usePrReviewStore 重写授权路径：startConnect → open verificationUriComplete → 自动轮询循环，按 slow_down 响应动态调大间隔，支持本地倒计时超时 |
| refactor | prd-admin | GitHubConnectCard 重写为 Device Flow UX：授权码大字展示 + 一键复制 + 打开 GitHub 按钮 + 倒计时进度条 + 终态提示（expired/denied/failed） |
| refactor | prd-admin | PrReviewPage 移除 ?connected=1 query 处理（Device Flow 无 redirect），简化主页面逻辑 |
| docs | doc | design.pr-review-v2.md / spec.srs.md §4.24 全面更新，反映 Device Flow 架构与 CDS 动态域名适配决策 |
| fix | prd-api | PR Review V2：在 AppCallerRegistry 登记 pr-review.summary::chat 和 pr-review.alignment::chat。首次部署时 LLM Gateway 报 APP_CALLER_INVALID，因为新 AppCallerCode 没有写入代码侧注册表，管理端同步时检测不到 |
| fix | prd-api | PrSummaryService.ParseHeadline / PrAlignmentService.ParseAlignmentOutput 的正则 `[^\n#]+` 会在 LLM 输出中遇到 `#` 时截断（例如 "Fix #123"），改为 `[^\n]+` 抓整行并在业务层限长 |
| fix | prd-api | PrReviewController 档 1/3 的 StreamSummary / StreamAlignment 增加空输出防御：LLM 返回空内容时写入 Error 字段并推 error 事件，不再当成"成功但空白" |
| fix | prd-api | PrReviewController 补 using System.Text（首次部署时 StringBuilder 两处 CS0246 编译错误） |
| feat | prd-api | PR Review V2 基础：新增 GitHubUserConnection / PrReviewItem / PrReviewSnapshot 模型，奠定 per-user OAuth 审查路径 |
| feat | prd-api | PR Review V2：新增 PrUrlParser（owner/repo/number 抽取 + SSRF 白名单），伴随 30+ 单测覆盖协议/host/路径逃逸/编码绕过/非法编号/字符越界 |
| feat | prd-api | PR Review V2：在 MongoDbContext 注册 github_user_connections 与 pr_review_items 集合 |
| feat | doc | 新增 doc/design.pr-review-v2.md：以 OAuth 为根的 PR 审查工作台顶层设计，定义 MVP 边界、错误分类、下线计划 |
| feat | prd-admin | PR Review V2 前端：新增 /admin/pr-review 页面，严格 SSOT + 无 localStorage，整页拆成 5 个组件（200 行主页面取代 1781 行巨石） |
| feat | prd-admin | PR Review V2 前端：GitHubConnectCard 组件——OAuth 整页跳转连接 GitHub，展示已连接 login/头像/scopes，支持一键断开 |
| feat | prd-admin | PR Review V2 前端：AddPrForm 粘贴 PR URL 同步拉取，失败提示保留错误码分类 |
| feat | prd-admin | PR Review V2 前端：PrItemCard 折叠式卡片——基本信息/详情/Markdown 笔记失焦自动保存/刷新/删除 |
| feat | prd-admin | PR Review V2 前端：PrItemList 列表 + 分页 + 空态/加载态区分 |
| feat | prd-admin | PR Review V2 前端：usePrReviewStore（Zustand）严格 SSOT，乐观 UI + 回滚机制 |
| feat | prd-admin | PR Review V2 前端：新增 services/real/prReview.ts 类型化 API 层，注册至 services/index.ts |
| feat | prd-admin | App.tsx / authzMenuMapping 新增 pr-review 路由和权限位 |
| fix | prd-api | **关键幽灵 bug**：RegisterAppSettings 缺少 SetIgnoreExtraElements(true)，导致 MongoDB 残留的 PrReviewPrismGitHubTokenEncrypted 字段反序列化 AppSettings 时抛 BSON 异常，被 LlmRequestLogWriter.StartAsync 的 silent catch 吞掉，表现为**所有 LLM 调用都不写 llmrequestlogs**（新旧功能都受影响） |
| fix | prd-api | LlmRequestLogWriter.StartAsync 的 catch 块日志级别从 Debug 提升到 Warning，避免类似"所有日志静默丢失"的幽灵故障难以排查 |
| feat | doc | 新增 rule.ai-model-visibility + .claude/rules/ai-model-visibility 原则：中大型 AI 功能必须在 UI 最顶部展示当前调用的模型名 {model} · {platform}，数据来自后端 Start chunk，禁止前端硬编码 |
| feat | prd-api | PrReviewModelInfoHolder（新）：服务层 → Controller 的模型信息传递载体，让 IAsyncEnumerable 流式方法能把 Start chunk 捕获到的 ActualModel / ActualPlatformName / ModelGroupName 带出来 |
| feat | prd-api | PrSummaryService / PrAlignmentService StreamXxxAsync 新增 modelInfo 参数，在 Gateway Start chunk 时填充 |
| feat | prd-api | PrReviewController 在 SSE 流中新增 model 事件（Start 捕获后立即推送），同时把模型名持久化到 AlignmentReport.Model / SummaryReport.Model 字段 |
| feat | prd-admin | AlignmentPanel + SummaryPanel 新增 ModelBadge 组件：顶部低饱和度小字展示 "● {model} · {platform}"，流式阶段从 SSE model 事件获取实时值，完成后从 Report.Model 获取缓存值 |
| fix | prd-api | 新增 StreamLlmWithHeartbeatAsync 心跳：LLM 首字延迟（qwen/deepseek 等推理模型可达 10~90s）期间每 2s 推送 phase=waiting 事件带 elapsed 秒数，首字到达时切换到 phase=streaming。彻底消除用户盯着静态文案等几十秒的"空白等待"体验 |
| feat | prd-api | 新增 GET /api/pr-review/items/{id}/raw 端点：返回 PR 完整原文（body 未截断 + files[] 含 diff patch），独立端点避免把 100KB 数据塞进列表接口 |
| feat | prd-admin | 新增 PrRawContentModal 组件 + PrItemCard"查看原文"按钮：完整展示 PR 描述、关联 issue、变更文件列表（可折叠 diff patch，diff 带 +/-/@@ 彩色高亮） |
| fix | prd-api | **根因**：PrSummaryService / PrAlignmentService 只处理 GatewayChunkType.Text，把 Thinking chunk（推理模型 reasoning_content）silently dropped，导致 qwen-thinking 50 秒思考被当成"空白等待"（日志 firstByteAt=1.8s 但 SSE 首字 52s）。新增 LlmStreamDelta record struct 区分 Thinking / Text，两个 service 都 yield 双类型 |
| feat | prd-api | StreamLlmWithHeartbeatAsync 新增 SSE thinking 事件推送 + phase=thinking/streaming 阶段区分 |
| feat | prd-admin | 新增 PrMarkdown 共享组件（ReactMarkdown + remarkGfm + remarkBreaks + 深色主题），用于 PR 面板所有 markdown 场景：oneLiner、keyChanges bullets、impact/reviewAdvice 章节、AlignmentPanel 三栏 bullets、PrRawContentModal 的 PR body 与 linkedIssueBody |
| feat | prd-admin | SummaryPanel + AlignmentPanel 新增 ThinkingBlock 组件：流式渲染推理模型思考过程，正文开始后自动折叠 |
| fix | prd-api | 心跳 phase 文案分三级：0-15s "AI 正在思考"；15-40s "上游首字延迟较高（{model}），已等待 20s"；40s+ "⚠️ 上游响应异常缓慢，建议中止重试"。根因是 qwen/qwen3.6-plus 走 OpenRouter 是 fake-streaming——chunk #1 @ 4.4s 只是 Start metadata，chunk #2 第一个真正的文本 token @ 52s |
| fix | prd-api | OpenRouter 不默认转发 reasoning 的根因修复：在 request body 里加 `include_reasoning: true` + `reasoning: {exclude: false}`，修复后 thinking 事件从 1.9s 开始流式到达（从前是 52s 空白）。同步 OpenAIGatewayAdapter 支持 `reasoning` 字段（OpenRouter 归一名）和 `reasoning_content`（上游原生名） |
| feat | doc | 新建 `doc/rule.llm-gateway.md` + 扩展 `.claude/rules/llm-gateway.md`，沉淀 5 个流式 LLM 陷阱：firstByteAt 指标歧义 / OpenRouter 必须显式开 reasoning / reasoning 字段名不统一 / fake streaming 只能 UX 降级 / 诊断 3 个信息源交叉验证。附 8 项 checklist |
| feat | prd-api | 新增 GET /api/pr-review/items/{id}/history 端点，并行拉取 6 个 GitHub REST API（commits / reviews / review-comments / issue-comments / timeline / check-runs），每个子请求失败不致命 |
| feat | prd-admin | PrItemCard 右上角新增"历史"悬浮按钮 + PrHistoryModal 弹窗（5 个 tab：时间线 / 提交 / 评审 / 评论 / CI 检查）。时间线 tab 支持 committed / reviewed / commented / labeled / assigned / merged / force_pushed / renamed / ready_for_review 等 20+ GitHub 事件类型，每种事件独立图标 + 颜色 + 中文描述 |
| fix | prd-admin | PrHistoryModal 修复两个问题：(1) 用 createPortal 挂到 document.body，修复被 PrItemCard 外层 overflow-hidden 裁剪导致的超出屏幕无法滑动；(2) 改为按 tab 懒加载，打开弹窗只拉 timeline（~400ms），切 tab 时才拉对应类型。第一版打开立即并行拉 6 个 endpoint 需 2-3s |
| fix | prd-api | PrReviewController /history 端点支持 `?type=timeline&page=1&perPage=30` 懒加载模式，GitHubPrClient 拆出 FetchHistorySliceAsync 按类型分派。每个 tab 独立分页，hasMore 由 items.count>=perPage 推导 |
| fix | prd-admin | PrHistoryModal + PrRawContentModal 改用 inline style 强制高度（`height:90vh, maxHeight:90vh`），绕过 Tailwind v4 Oxide 引擎对 arbitrary value 的偶发失效；同步给 PrRawContentModal 补上 createPortal（第一轮漏了） |
| feat | doc | 新建 `doc/rule.frontend-modal.md` + `.claude/rules/frontend-modal.md`，沉淀模态框 3 硬约束：inline style 走布局关键属性 / createPortal 到 body / flex 滚动容器必须 min-h:0。附标准实现模板 + 提交前 Checklist |
| refactor | prd-api | 下线旧 PR审查棱镜：删除 PrReviewPrismController (1211 行)、GitHubPrReviewPrismService (501 行)、PrReviewPrismSnapshotBuilder、PrReviewPrismSubmission 模型 |
| refactor | prd-api | 下线旧 PR审查棱镜：删除集成测试 (1087 行) + 单元测试 (145 行)，由 PrUrlParserTests 覆盖新 V2 路径 |
| refactor | prd-api | 下线旧 PR审查棱镜：从 MongoDbContext 移除 PrReviewPrismSubmissions 集合与索引；AppSettings 删除 PrReviewPrismGitHubTokenEncrypted 字段 |
| refactor | prd-api | 下线旧 PR审查棱镜：AdminPermissionCatalog / BuiltInSystemRoles / AdminMenuCatalog 移除 pr-review-prism.use，替换为 pr-review.use |
| refactor | prd-admin | 下线旧 PR审查棱镜：删除 pages/pr-review-prism (1781 行) + services/real/prReviewPrism.ts + PrReviewPrismCardArt，由 /pr-review V2 页面替代 |
| refactor | prd-admin | 下线旧 PR审查棱镜：从 App.tsx / authzMenuMapping / AgentLauncherPage / MobileHomePage / toolboxStore 移除所有 pr-review-prism 引用 |
| refactor | ci | 删除 .github/pr-architect/* 整个目录（README / manifests / review-rules / design-sources / decision-card-template）与 5 个 workflow、5 个 Python 脚本、PULL_REQUEST_TEMPLATE.md |
| refactor | skills | 删除 .claude/skills/pr-prism-bootstrap 与 scripts/bootstrap-pr-prism.sh / init-pr-prism-basis.sh |
| refactor | doc | 下线 doc/guide.pr-prism-bootstrap-package.md / guide.pr-prism-onboarding.md；spec.srs.md 第 4.24 节从 PR 审查棱镜改写为 PR 审查工作台 V2；rule.data-dictionary.md / rule.app-identity.md 同步更新 |
| chore | doc | 清理未发布的 V1 历史 changelog 碎片：2026-04-08_map-home-pr-review-prism.md、2026-04-09_pr-review-prism-complete.md（V1 从未发版，清理避免 CHANGELOG 出现从未面世的功能） |
| feat | prd-api | PR Review V2 档 1 变更摘要：新增 PrSummaryService，通过 ILlmGateway 流式生成"一句话/关键改动/主要影响/审查建议"四段式 Markdown，AppCallerCode=pr-review.summary::chat |
| feat | prd-api | PrReviewItem 新增 SummaryReport 字段，存 markdown + headline + 耗时 + error |
| feat | prd-api | PrReviewController 新增 GET /items/{id}/ai/summary（读缓存）+ GET /items/{id}/ai/summary/stream（SSE 流式，复用与 alignment 相同的 phase/typing/result/error 事件协议） |
| refactor | prd-api | 抽出 EnsureSnapshotReadyAsync + PrepareSseHeaders 私有 helper，alignment 与 summary 两个 SSE 端点共享快照刷新与响应头设置，消除重复 |
| feat | prd-admin | 新增 SummaryPanel 组件：四态 SSE 生命周期（idle/running/done/error），空态按钮 / 打字机预览 / 结构化渲染（关键改动 · 主要影响 · 审查建议） |
| feat | prd-admin | PrItemCard 展开态依次嵌入 SummaryPanel（档 1，sky 色调）+ AlignmentPanel（档 3，violet 色调），摘要在前因为运行更快更适合先看 |
| feat | prd-admin | prReview 服务层新增 PrSummaryReportDto 类型、getPrReviewSummary / getPrReviewSummaryStreamUrl；usePrReviewStore 新增 setSummaryReport 方法 |

### 2026-04-10

| 类型 | 模块 | 描述 |
|------|------|------|
| feat | cds | 头部新增容量压力电池图标: 实时显示 runningContainers/maxContainers 比率,四色分层(绿<60%/蓝<80%/橙<100%/红超售),超售时呼吸灯动效,点击打开弹窗显示 scheduler 状态 + hot/cold 分支列表 |
| feat | cds | 新增 `./exec_cds.sh connect/disconnect/issue-token/cluster` 子命令，一条命令加入 CDS 集群 |
| feat | cds | 主节点 standalone → scheduler 自动热升级，首个 executor 注册时触发，无需重启 |
| feat | cds | 新增 `GET /api/executors/capacity` 端点，总容量（分支槽/内存/CPU）随执行器加入自动扩充 |
| feat | cds | 主节点作为 `role=embedded` 执行器自注册，容量汇总包含主机自身资源 |
| feat | cds | Bootstrap 两段式 token 机制：一次性 token（15 分钟过期）换永久 executor token |
| feat | cds | 新增 `cds/src/services/env-file.ts` 原子读写 `.cds.env` 工具模块 |
| docs | cds | 新增 `doc/guide.cds-cluster-setup.md` 集群扩容运维手册（含前置检查、5 种排错、安全建议） |
| docs | cds | `./exec_cds.sh help` 大改造：分区呈现、表情符号导航、新手 FAQ、命令解释假设零基础用户 |
| fix | cds | `./exec_cds.sh connect` 拒绝明文 HTTP URL（loopback 例外），防止 bootstrap token 被中间人截获 |
| fix | cds | `./exec_cds.sh connect` 网络探测按 curl exit code 分类（DNS/连接/超时/TLS/HTTP），给针对性修复建议 |
| fix | cds | `./exec_cds.sh connect` 注册超时从 20 秒延长到 60 秒，每 5 秒打印进度避免冷启动机器误报 |
| fix | cds | `./exec_cds.sh connect` 失败时区分 "Token 拼写/过期/已被消费" 三种场景，给具体修复步骤 |
| fix | cds | scheduler/routes 拒绝包含控制字符或长度 > 64 的 executor id，防止日志注入 |
| fix | cds | scheduler/routes 在 bootstrap token 已被消费时返回特定错误信息，引导用户重新 issue-token |
| fix | cds | scheduler/routes 把 "首个 executor" 判定从闭包标志改为基于 registry 状态，避免主进程重启后冗余触发 |
| fix | cds | executor-registry 拒绝把 embedded 节点降级为 remote（防恶意远程节点冒充主节点 id 静默禁用 embedded 部署路径）|
| fix | cds | executor-registry 自动回收离线超过 24 小时的远程节点（embedded 永远保留）|
| fix | cds | env-file 备份文件 `.cds.env.bak` 显式 chmod 0600，避免 copyFileSync 沿用 umask 默认权限暴露 token |
| fix | cds | env-file 持久化失败时打印 LOUD 警告框 + 广播到 dashboard activity stream |
| feat | cds | Dashboard 新增"集群设置"面板（设置菜单 → 集群），支持一键生成连接码、粘贴加入、热切换进入 hybrid 模式、UI 退出集群 |
| feat | cds | 新增 `/api/cluster/issue-token` + `/api/cluster/join` + `/api/cluster/leave` + `/api/cluster/status` 四个端点，作为 CLI 的补充 UI 入口 |
| feat | cds | 集群连接码格式：`base64(JSON{master,token,expiresAt})`，一个字符串自包含所有字段，便于复制粘贴 |
| feat | cds | 加入集群为进程内热切换（不重启），Dashboard 继续可用；UI 显式警告下次重启会进入纯 executor 模式 |
| feat | cds | BranchDispatcher 真正接入部署流程：POST /api/branches/:id/deploy 支持 targetExecutorId 参数，自动/手动派发到远程 executor，通过 HTTP SSE 代理回传日志 |
| feat | cds | Dashboard 分支卡片展示"on: 执行器短名"徽章，实时显示每个分支跑在哪台节点 |
| feat | cds | Dashboard 集群模态新增节点管理区：每个节点独立卡片 + 排空/踢出按钮 + 内存/CPU/分支槽负载条 |
| feat | cds | Dashboard 新增调度策略切换 UI（radio）：least-load（推荐）/ least-branches / round-robin，运行时生效 |
| feat | cds | Dashboard 顶部容量徽章在集群模式自动切换为"N/M 节点 · 空闲/总槽"显示，单击查看调度器详情 |
| feat | cds | 分支部署下拉菜单新增"派发到..."子菜单，可手动指定目标执行器或选"自动（按策略）" |
| feat | cds | state-stream SSE 广播扩展为 executors + mode + capacity，Dashboard 集群变更秒级同步无需刷新 |
| fix | cds | Executor 心跳自动把远程分支同步到 master 分支列表，解决"B 的自带分支在 A 上看不见"问题 |
| fix | cds | Executor 离线时自动把其拥有的分支标记为 error + "请重新部署"，用户可点部署按钮触发 dispatcher 重派 |
| fix | cds | CPU 核数从 os.cpus().length 改为 os.availableParallelism()，尊重 cgroup v2 CPU 限制 |
| fix | cds | 部署下拉菜单溢出窗口底部时自动向上翻转或约束高度 + 内部滚动，不再被视口裁掉 |
| feat | cds | 数据迁移支持跨 CDS 密钥一键直连：新增「CDS 密钥管理」面板，可复制本机访问密钥、注册远程 CDS，源/目标均可选择密钥，HTTPS 流式传输，无需 SSH 或复杂配置 |
| feat | cds | 数据迁移重构为流式管道（mongodump \| mongorestore），彻底去除临时文件，使用 `--archive --gzip` 单流传输，修复大库迁移 `use of closed network connection` 断连问题 |
| feat | cds | SSH 迁移改用命令模式而非端口转发：`ssh jump "mongodump --archive --gzip" \| mongorestore`，加入 ServerAliveInterval=30 保活，长时间 dump 不再断流 |
| feat | cds | SSH 隧道新增「测试隧道」按钮，直接验证 ssh 连通性与远端 mongodump 可用性，不再被迫等到「无法获取数据库列表」才发现问题 |
| feat | cds | SSH 隧道新增「docker 容器名」字段，支持 `ssh jump "docker exec <container> sh -c 'mongodump...'"` 模式，兼容远端 mongo 仅以容器形态存在的场景 |
| feat | cds | 数据迁移任务卡片新增「编辑」按钮，可修改名称、源/目标、集合选择（运行中禁用）；新增 PUT /api/data-migrations/:id |
| fix | cds | 修复「新建数据迁移」对话框输入框溢出问题：主机+端口改为严格 flex 约束（mc-input / mc-host / mc-port），port 固定 68px，其他字段 `min-width:0` 防止溢出 |
| feat | cds | 新增对等 CDS 端点：/my-key /peers CRUD /peers/:id/{test,list-databases,list-collections} /local-dump /local-restore /test-tunnel，均复用现有 X-AI-Access-Key 鉴权 |
| feat | cds | MongoConnectionConfig 新增 `type: 'cds'` 与 `cdsPeerId` 字段，CdsPeer 存储于 state.json（加载时自动迁移旧状态） |
| docs | doc | design.cds.md 升级到 v3.2：新增 §7.5 运维入口与 Nginx 渲染章节（为什么只留一个脚本 / 多根域名路由规则 / 渐进式 TLS / 幂等渲染 / 与跨机 dispatcher 的边界），更新 §1 Quickstart 和 §6 环境变量体系为 .cds.env + CDS_ROOT_DOMAINS 4 变量方案 |
| docs | doc | design.cds-resilience.md §八 Layer 3 加入与 design.cds §7.5 单节点入口的边界说明；§九 单节点 runbook 更新为新的 init/start 流程 |
| feat | cds | 后端 GET /api/host-stats: 返回宿主机内存使用率、CPU loadavg、CPU 核数、运行时长,public 无 auth 5s 一次 |
| feat | cds | Dashboard 右下角(Activity Monitor 上方)新增宿主机实时负载小窗: MEM/CPU 双 bar + 百分比标签,4 色分层(< 50/75/90/>=90%),双指标 >= 90% 时呼吸灯告警动效 |
| feat | cds | 点击负载小窗弹出详情: 内存使用 GB / CPU 1分钟loadavg / 系统运行时长 + loadavg 1m/5m/15m 历史 |
| fix | cds | exec_cds.sh init 交互式 prompt 修复：read_default / read_secret 的 printf 被 $() 命令替换捕获导致脚本假死，改为 >/dev/tty 输出提示、</dev/tty 读取输入 |
| fix | cds | exec_cds.sh 的 nginx 渲染改为内容对比后才写盘 (write_if_changed)，避免每次 start 都误打印"配置已生成"噪音，自更新时 docker compose 真正感知到"无变化"而不重启容器 |
| feat | cds | 当 cds-site.conf / nginx.conf 发生变化且容器已在运行时，自动 nginx -t 校验 + nginx -s reload 热重载，用户新加的根域名立刻生效且无停机 |
| feat | cds | `./exec_cds.sh init` 现在自动检查并交互式安装依赖 (Node/pnpm/Docker/curl/openssl/python3)，缺失项给复制粘贴的安装命令 |
| feat | cds | 新增发行版检测 (Ubuntu/Debian/CentOS/Fedora/Arch/Alpine/macOS)，按发行版给对应的 apt/yum/dnf/pacman/apk/brew 安装命令 |
| feat | cds | Docker 检测区分"未安装"和"已安装但无权限"两种情况，后者给 `usermod -aG docker + newgrp docker` 修复步骤 |
| feat | cds | 依赖检查幂等：跑两次、跑到一半 Ctrl+C 再跑都能继续 |
| docs | project | 新增 `.claude/rules/quickstart-zero-friction.md` 原则：快启动必须大包大揽，假设使用者是小白，注册到 CLAUDE.md 规则索引 |
| feat | cds | Phase 2 cgroup 限制: BuildProfile.resources + compose-parser 支持 x-cds-resources / deploy.resources.limits 双源,container.runService 追加 --memory / --memory-swap / --cpus 标志 |
| feat | cds | Phase 2 JanitorService: 周期性扫描 lastAccessedAt > worktreeTTLDays 的分支并通过 callback 删除,跳过 pinned/defaultBranch/colorMarked,同时做磁盘水位告警(statfsSync) |
| feat | cds | Phase 2 Master 容器化: Dockerfile.master (multi-stage + docker CLI + healthcheck) + systemd/cds-master.service (Restart=always + security hardening) |
| feat | cds | Phase 2 GET /healthz 健康检查端点: state 可读 + docker 可达双检查,返回 200/503,public 无 auth 供 Docker/systemd/Nginx 主动探测 |
| feat | cds | Phase 3 BranchDispatcher: 读取每个 executor 的 /api/scheduler/state,按 capacityUsage.current/max 比率做 capacity-aware 派发(fallback 到 least-branches) |
| feat | cds | Phase 3 POST /api/executors/dispatch/:branch: 调度 API 支持 capacity-aware / least-branches 两种策略 |
| feat | cds | Phase 3 Nginx 模板生成器: generateUpstreamBlock + generateBranchMap + generateFullConfig,支持 draining → backup、offline → 排除、proxy_buffering off (SSE 支持) |
| docs | doc | design.cds-resilience.md v2.0: 扩展 Phase 2/3 章节 + 3 层分布式架构图 + 职责切分矩阵 + 集群部署 runbook + 单机 vs 集群决策树 |
| docs | doc | plan.cds-resilience-rollout.md: Phase 2/3 checkbox 全打勾,记录 60 个新单测覆盖,标注待运维部署项 |
| docs | doc | design.cds.md §8: 补 v3.1/v3.2/v3.3 三阶段状态表 + 核心理念三层 |
| refactor | cds | 合并 exec_cds.sh / exec_setup.sh / nginx/init_domain.sh / nginx/start_nginx.sh 为单一入口 cds/exec_cds.sh，命令收敛为 init/start/stop/restart/status/logs/cert |
| feat | cds | start 默认后台运行（nohup + PID 文件），--fg 进入前台；新增 init 交互式初始化写入 cds/.cds.env 并自动渲染 nginx 配置 |
| feat | cds | CDS_ROOT_DOMAINS 支持逗号分隔多根域名，每个根域名 D 自动生成三条路由：D → Dashboard、cds.D → Dashboard、*.D → Preview，miduo.org 与 mycds.net 可同时使用 |
| feat | cds | nginx 配置改为每次启动根据 .cds.env 重新渲染（cds/nginx/cds-site.conf），存在 certs/<domain>.crt 自动启用 HTTPS，缺省 HTTP-only 兜底 |
| refactor | cds | 根目录 exec_cds.sh 改为转发器，所有业务逻辑集中在 cds/exec_cds.sh；删除 host-env.example.sh 等遗留配置入口 |
| docs | doc | 更新 guide.cds-env.md 和 guide.quickstart.md 对齐新脚本接口，移除 .bashrc / exec_setup.sh / CDS_SWITCH_DOMAIN 等废弃表述 |
| fix | cds | exec_cds.sh 新增 --background 参数别名（等同于 daemon），修复 self-update 静默失败导致 CDS 整体宕机 |
| fix | cds | self-update spawn 改为规范 daemon 参数 + 子进程 stdout/stderr 重定向到 .cds/self-update-error.log，失败不再无声 |
| feat | cds | deploy 端点启动时检测 maxContainers 容量超售，超售发送 SSE capacity-warn 事件 + 写入 deploy log |
| docs | doc | plan.cds-resilience-rollout.md 补 Phase 1.5 pipeline 验证记录 + 3 个 pre-existing bug 根因 + Phase 2 优先级调整 |
| refactor | prd-api | 划词评论重锚定算法抽取到 `PrdAgent.Infrastructure.Services.DocumentStore.InlineCommentRebinder` 纯函数类，便于单元测试覆盖；同步新增 20 个 xunit 测试覆盖唯一命中/多处消歧/失锚/空输入/边界情况 |
| fix | prd-api | 知识库级联删除补齐三张表：删除 Store 时同步清理 `document_store_view_events` / `document_inline_comments` / `document_store_agent_runs`；删除 Entry/Folder 时按 `EntryId`/`SourceEntryId` 清理对应记录，避免孤儿数据 |

### 2026-04-09

| 类型 | 模块 | 描述 |
|------|------|------|
| feat | cds | 新增分支温池调度器 (SchedulerService)：LRU 驱逐 + idleTTL 自动休眠 + 四源 pinning，用 maxHotBranches 为小服务器提供容量预算与故障隔离 |
| feat | cds | GET/POST /api/scheduler/{state,pin,unpin,cool}:slug 四个端点，Dashboard 可观测并手动干预温池 |
| feat | cds | 代理命中分支后自动 scheduler.touch 更新 LRU（15s 节流持久化） |
| fix | cds | StateService.save 改为原子写 + 滚动备份（state.json.bak.<ts> 保留 10 份），载入时从最新备份恢复损坏 state |
| docs | doc | 新增 design.cds-resilience.md（小服务器负载均衡设计）、plan.cds-resilience-rollout.md（可续传进度追踪），design.cds.md 补核心思想 + 文档地图 + HA 章节 |
| feat | prd-admin | 知识库卡片支持重命名：hover 时在标题右侧显示铅笔按钮，弹窗内编辑即可保存（复用 PUT /api/document-store/stores/{id}） |
| feat | prd-admin | 知识库页新增「我的空间 / 我的收藏 / 我的点赞」标签切换；收藏/点赞 tab 下点击卡片跳转 /library/{id} 公开详情页（若收藏的是自己创建的空间则进入编辑视图） |
| feat | prd-api | DocumentStoreController 新增 GET /api/document-store/likes/mine；同步增强 GET /api/document-store/favorites/mine 返回最近 3 个文档预览、店主信息及 isOwner 标记，与 stores/with-preview 卡片结构对齐 |
| feat | prd-admin | 知识库卡片支持打标签：编辑弹窗内可输入标签（回车/逗号添加，最多 10 个、单个 ≤20 字），卡片标题下展示前 4 个 # 标签 chip，超出显示 +N（复用现有 PUT /api/document-store/stores/{id} tags 字段，无需后端改动） |
| fix | prd-api | 删除知识库/文档时级联清理 document_sync_logs、ParsedPrd 正文、attachments 附件、likes/favorites/share_links；删除文件夹或 GitHub 目录订阅时递归清理子条目 |
| fix | prd-admin | 删除知识库/文档/文件夹前弹出液态玻璃二次确认（systemDialog），明确列出将清除的数据范围 |
| fix | prd-admin | 修复智识殿堂文档内锚点链接 bug：锚点/站内链接不再强制新开标签页，改为 SPA 内 scroll；外链保留 target=_blank |
| fix | prd-admin | 智识殿堂支持从 URL hash 深链：复制 `/library/{id}#章节` 打开后自动滚动到对应章节 |
| fix | prd-admin | 修复相对路径链接被错误解析为路由导航导致跳到错误知识库：相对路径如 `design.visual-agent` 现在先在当前知识库 entries 里查找匹配文档，命中则在 reader 内切换；未命中时显示删除线 + tooltip 警告"未找到文档"，不再触发错误跳转 |
| refactor | prd-admin | LibraryDocReader 链接处理改用 react-router useNavigate()，替换 pushState+PopStateEvent 的 hack |
| feat | prd-admin | 智识殿堂 LibraryDocReader 新增：顶部搜索框（标题+正文第一行模糊匹配）、标题显示模式切换（文件名 ↔ 正文第一行） |
| feat | prd-admin | DocBrowser 与 LibraryDocReader 的 Markdown 渲染器升级：支持 KaTeX 数学公式、heading 带稳定 slug ID、任务列表专属样式 |
| fix | prd-admin | 智识殿堂 Hero 卡片改为真实数据驱动：使用当前排序下的 #1 知识库（名称/作者/篇数/点赞/阅读），用 likes+views/5 的渐近曲线计算「热度」%，按钮跳转真实详情页；空数据态显示「等待第一卷藏书」引导发布 |
| feat | prd-admin | 智识殿堂阅读器（LibraryDocReader）右上角新增「全屏阅读」按钮，点击切换 fixed 全屏覆盖；ESC 退出，全屏期间锁定 body 滚动 |
| feat | prd-admin | 周报团队添加成员支持批量多选+搜索，新增 UserMultiSearchSelect 组件 |
| feat | prd-api | 周报团队新增批量添加成员 API（POST teams/{id}/members/batch） |
| fix | prd-api | AI生成周报时MAP平台工作记录严格按用户实际行为输出，零数据指标不再传入提示词 |
| fix | prd-api | 周报文档编辑统计修复用户归属：原查询遗漏UserId过滤导致统计全站文档，改用Groups.OwnerId关联，指标重命名为"创建PRD项目" |
| fix | prd-api | 周报LlmCalls自噬循环修复：排除report-agent.*的AppCallerCode，避免报告生成自身的LLM调用被统计为用户行为 |
| fix | prd-api | 周报AI生成提示词强化严格约束条款，禁止AI凭空编造、语义漂移或捏造修饰语 |
| feat | prd-api | 新增技能引导 Agent（skill-agent），5 阶段对话式引导用户创建技能 |
| feat | prd-api | 技能引导 Agent 支持导出 SKILL.md 和 ZIP 包（含 README + 使用示例） |
| feat | prd-admin | 技能管理页面新增「AI 创建」入口，打开对话式技能创建助手 |
| feat | prd-admin | 知识库订阅详情：新增订阅详情抽屉，展示状态卡（上次/下次同步、错误信息）、调整同步间隔、暂停/恢复、立即同步，并以时间线呈现"最近变化记录" |
| feat | prd-admin | 文件树为最近 24 小时内有更新的订阅文件标记 (new) 徽标，订阅条目右侧增加同步状态彩点指示器 |
| feat | prd-admin | 文档预览顶栏对订阅来源文件展示版本徽标（GitHub 类显示 #shortSha），点击直接打开订阅详情 |
| feat | prd-api | 新增 document_sync_logs 集合，订阅同步只在内容真正变化或出错时落库（无变化只更新 LastSyncAt），避免日志膨胀 |
| feat | prd-api | URL 订阅同步使用 If-None-Match / If-Modified-Since 条件请求 + ContentHash 兜底，避免被源站封控 |
| feat | prd-api | 新增 GET /entries/{id}/sync-logs 与 PATCH /entries/{id}/subscription 端点，支持查看变化日志 + 暂停/调整间隔 |
| feat | prd-api | DocumentEntry 增加 IsPaused / LastChangedAt / ContentHash / LastETag / LastModifiedHeader 字段 |
| refactor | prd-api | GitHubDirectorySyncService.SyncDirectoryAsync 改为返回 GitHubDirectoryDiff，由 Worker 决定是否落变更日志 |
| feat | prd-api | 知识库 Agent：一键生成字幕（音视频直译带时间戳字幕 + 图片 Vision 识别），输出为新 DocumentEntry `{原文件名}-字幕.md` |
| feat | prd-api | 知识库 Agent：文档再加工（4 个内置模板：摘要 / 会议纪要 / 技术博文 / 学习笔记 + 自定义 prompt），流式 LLM 输出到新 entry |
| feat | prd-api | 新增 `document_store_agent_runs` 集合 + DocumentStoreAgentWorker（BackgroundService，轮询 queued 任务，遵循服务器权威性：CancellationToken.None + Worker 关机标记失败） |
| feat | prd-api | DocumentStoreController 新增端点：`GET reprocess-templates`、`POST generate-subtitle`、`POST reprocess`、`GET agent-runs/{id}`、`GET entries/{id}/agent-runs/latest`、`GET agent-runs/{id}/stream`（SSE + afterSeq） |
| feat | prd-api | AppCallerRegistry 新增 `DocumentStoreAgent.Subtitle.Audio/Vision` 和 `DocumentStoreAgent.Reprocess.Generate` 三条调用标识 |
| feat | prd-admin | DocBrowser ContextMenu 新增"生成字幕"和"再加工"选项（按 entry contentType 显示） |
| feat | prd-admin | DocBrowser 预览顶栏对音视频/图片 entry 显示「✨ 生成字幕」按钮，对文字 entry 显示「🪄 再加工」按钮 |
| feat | prd-admin | 新增 SubtitleGenerationDrawer：状态卡 + 进度条 + 阶段指示 + SSE 实时刷新，完成后自动跳转到新生成的字幕文档 |
| feat | prd-admin | 新增 ReprocessDrawer：模板卡片选择 + 自定义 prompt 输入 + 流式 LLM 实时打字预览 + 完成后跳转 |
| ops | — | docker-compose.dev.yml 补上 ffmpeg / ffprobe volume 挂载（与生产 docker-compose.yml 对齐，用于视频抽音频） |
| feat | prd-admin | 百宝箱卡片支持 `wip` 字段，未正式发布的 Agent 在卡片左下角显示橙色"施工中"徽章 |
| feat | prd-api | 知识库新增观察者统计：`document_store_view_events` 集合 + 埋点端点（log/leave/list），支持同一用户多次访问、匿名访客 session token、停留时长 |
| feat | prd-api | 知识库新增划词评论：`document_inline_comments` 集合 + CRUD 端点；文档正文更新时基于 SelectedText + 上下文前后 50 字的重锚定算法（active / orphaned 状态） |
| feat | prd-admin | 新增 `useViewTracking` hook：进入文档时埋点 + visibilitychange/beforeunload 发 sendBeacon 补时长，作用于 DocBrowser 和 LibraryDocReader 两个 viewer |
| feat | prd-admin | 知识库详情页新增「访客」按钮，打开 ViewersDrawer 显示总访问量 / 独立访客 / 总停留时长 + 最近 50 条访问时间线 |
| feat | prd-admin | DocBrowser 文档阅读时支持划词评论：选中正文后浮现"添加评论"按钮，点击打开 InlineCommentDrawer，支持发表评论、定位引用原文、删除评论；文档更新后失锚评论单独分组展示 |

### 2026-04-08

| 类型 | 模块 | 描述 |
|------|------|------|
| feat | cds | 新增 Bridge 握手流程（用户同意握手后才激活会话） |
| feat | cds | Widget 新增 claymorphism 风格的握手审批面板（左下角弹出） |
| feat | cds | 后端新增 /bridge/handshake-request, /handshake-requests/:id/approve, /handshake-requests/:id/reject, /handshake-status/:id 端点 |
| refactor | prd-admin | LibraryLandingPage 完全重设计为 claymorphism 教育平台风格（Fredoka + Nunito 字体，奶油色背景，厚边框 + 硬投影卡片） |
| refactor | prd-admin | LibraryStoreDetailPage 同步改为 claymorphism 风格（白卡 + 厚边框 + 橙色/绿色/粉色高亮互动按钮） |
| refactor | prd-admin | 首页 LibrarySection 改为 claymorphism 风格，与 landing 页视觉一致 |
| docs | .claude | bridge skill 文档新增 Phase 1 握手流程 + Phase 1B 直接激活备用流程，明确用户邀请场景必须用握手 |
| fix | cds | 预览模式改为服务器权威：默认值改为「子域名」，切换后落库共享，移除 localStorage 独立存储（修复分享链接打开后总是默认 `simple` 模式、误触 `set-default` 污染 defaultBranch 的问题） |
| feat | prd-admin | 新增「智识殿堂」公共知识库浏览页 (/library)，支持热门/最新/高赞/高阅排序 |
| feat | prd-admin | 新增公开知识库详情页 (/library/:storeId)，宏伟的图书馆主题（径向光晕 + 浮动星辰背景） |
| feat | prd-admin | 知识库详情页右上角新增「发布到智识殿堂」开关，一键切换公开/私有 |
| feat | prd-admin | 知识库新增分享对话框：公开直链 + 自定义短链（永不/1/7/30/90 天过期 + 撤销 + 复制 + 浏览统计） |
| feat | prd-admin | 公共知识库支持点赞/收藏/复制链接互动 |
| feat | prd-admin | 首页新增 LibrarySection 板块，展示最热的 6 个公共知识库（替代原 TutorialSection） |
| feat | prd-admin | AgentLauncher 入口替换：「使用教程」→「智识殿堂」 |
| refactor | prd-admin | 删除 TutorialsPage / TutorialDetailPage / tutorialData / TutorialSection 及 /tutorials 路由（注意：tutorial-email 系统未受影响） |
| feat | prd-api | DocumentStore 新增 LikeCount/ViewCount/FavoriteCount/CoverImageUrl 字段 |
| feat | prd-api | 新增 DocumentStoreLike / DocumentStoreFavorite / DocumentStoreShareLink 模型 + 3 个 MongoDB 集合 |
| feat | prd-api | 新增公开端点：GET /api/document-store/public/stores、/public/stores/{id}、/public/stores/{id}/entries、/public/entries/{id}/content（[AllowAnonymous]）|
| feat | prd-api | 新增互动端点：POST/DELETE /stores/{id}/like、POST/DELETE /stores/{id}/favorite、GET /favorites/mine |
| feat | prd-api | 新增分享链接端点：POST/GET /stores/{id}/share-links、DELETE /share-links/{id}、GET /public/share/{token} |
| feat | prd-api | GET /public/stores/{id} 自动累加 ViewCount 浏览数 |
| chore | scripts | 新增 scripts/migrations/ 目录，提供 replace-cdn-domain.js 和 verify-cdn-domain.js，用于将 MongoDB 中残留的旧 CDN 域名 pa.759800.com 批量替换为 map.ebcone.net（递归子串替换所有集合的字符串字段，默认 dry-run） |

### 2026-04-07

| 类型 | 模块 | 描述 |
|------|------|------|
| feat | prd-admin | 文档浏览器支持多文档置顶（pin），右键上下文菜单替代直接设为主文档 |
| feat | prd-admin | 文件树标题显示切换：默认使用正文第一行，可切换为文件名 |
| feat | prd-admin | 搜索支持文档内容搜索（可选开关），后端存储 ContentIndex 到 MongoDB |
| fix | prd-admin | 修复知识库详情页刷新后丢失状态的 bug（sessionStorage 持久化 storeId） |
| feat | prd-admin | 知识库卡片显示最近文档预览列表，增大卡片高度 |
| feat | prd-api | DocumentStore 新增 PinnedEntryIds 字段，支持多文档置顶 |
| feat | prd-api | DocumentEntry 新增 ContentIndex 字段，上传和同步时自动截取前 2000 字存入 |
| feat | prd-api | 新增 PUT /stores/{storeId}/pinned-entries 置顶/取消置顶端点 |
| feat | prd-api | 新增 GET /stores/with-preview 端点，返回空间列表含最近文档预览 |
| feat | prd-api | ListEntries 端点新增 searchContent 参数，支持内容搜索 |
| fix | prd-admin | 文档列表左侧留白过大，非文件夹项移除空白占位符 |
| feat | prd-admin | 支持拖拽文件到文件夹（HTML5 drag & drop） |
| feat | prd-admin | 右键菜单新增删除选项（文件/文件夹） |
| feat | prd-admin | 文档在线编辑：预览面板新增编辑模式（Markdown textarea + 保存） |
| feat | prd-admin | 加号按钮改为下拉菜单：文档/上传文件/新建文件夹（已实现）+ 模板/AI写作/链接（置灰待实现） |
| feat | prd-admin | 每个文件夹允许独立设置主文档（存储在 folder.metadata.primaryChildId） |
| feat | prd-admin | 本地搜索同时匹配 title/summary/正文第一行，开启内容搜索时自动触发回填 |
| feat | prd-api | 新增 PUT /entries/{entryId}/move 移动文档条目端点 |
| feat | prd-api | 新增 PUT /entries/{entryId}/content 文档内容在线编辑端点 |
| feat | prd-api | 新增 PUT /entries/{folderId}/primary-child 设置文件夹主文档端点 |
| feat | prd-api | 新增 POST /stores/{storeId}/rebuild-content-index 回填内容索引端点 |
| fix | prd-admin | 修复拖拽文件树条目时误触发右侧上传遮罩（仅响应外部 Files 拖入） |
| feat | prd-admin | 文档浏览器左侧导航支持鼠标拖拽调整宽度（200~560px，sessionStorage 持久化） |
| feat | prd-admin | 文档浏览器左侧导航应用液态玻璃效果（backdrop-filter blur + saturate） |
| feat | prd-admin | 新建 src/lib/fileTypeRegistry.ts 文件类型注册表（PPT/Word/Excel/Code/Image 等 15 种类型） |
| fix | prd-admin | DocBrowser 文件图标从硬编码 switch 改为 FILE_TYPE_REGISTRY 查询，修复 PPTX 显示为文本图标的 bug |
| fix | prd-api | 上传端点 MIME 推断增加 .ppt/.pptx/.xls/.xlsx 支持 |
| fix | prd-api | 上传文档标题保留扩展名（便于前端按扩展名识别文件类型） |
| rule | .claude | frontend-architecture.md 新增「注册表模式」强制规则，禁止组件内硬编码 switch 类型判断 |
| fix | prd-admin | DocBrowser/DocumentStorePage 所有 Loader2 替换为统一的 MapSpinner/MapSectionLoader |
| rule | .claude | frontend-architecture.md 新增「统一加载组件」强制规则，禁止直接使用 lucide-react Loader2 |
| feat | prd-admin | 文档预览支持图片/视频/音频/PDF 直接渲染（按 fileTypeRegistry.preview 字段路由） |
| feat | prd-admin | 二进制文件兜底显示文件图标 + 下载按钮，不再"无文本内容"裸露提示 |
| feat | prd-admin | 编辑按钮仅对可编辑文本类型（md/txt/code/json/yaml/csv 等）显示 |
| fix | prd-admin | 修复一键分享缺陷时数量与列表不一致（前端传递可见缺陷 ID 列表） |
| fix | prd-api | 批量分享支持接收前端传入的 defectIds，确保分享内容与用户当前视图一致 |
| refactor | prd-admin | 分享管理用两个复制按钮替代一键分享+AI评分，直接导出用户原话+评论+VLM内容 |
| feat | prd-admin | 缺陷列表行显示缺陷编号(defectNo) |
| feat | prd-admin | 缺陷列表新增搜索框，支持按编号、标题、内容模糊搜索 |
| feat | prd-admin | 分享面板支持勾选缺陷+三种复制模式（含原图base64/含图链/含VLM描述），图片以 图1/图2 代称引用 |
| fix | prd-api | 新增缺陷附件代理端点，解决前端 base64 模式下跨域 CORS 失败 |
| fix | prd-admin | 复制内容补回 AI 工作流提示词（修复计划/评论API/标记完成 等阶段说明） |
| feat | prd-api | 新增 GitHub 目录同步功能：自动拉取指定仓库目录下所有 .md 文件到文档空间，支持 SHA 增量去重 |
| feat | prd-api | DocumentSyncWorker 支持 github_directory 源类型路由 |
| feat | prd-admin | 订阅对话框新增 GitHub 目录模式（URL 订阅 / GitHub 目录双模式切换） |
| feat | prd-api | 文档空间新增主文档功能（PrimaryEntryId + PUT /primary-entry 端点） |
| feat | prd-admin | 新增 DocBrowser 可复用组件：左侧文件列表 + 右侧 Markdown 渲染预览 |
| refactor | prd-admin | 文档空间详情页从卡片列表重构为左右分栏文档浏览器布局 |
| feat | prd-api | 知识库支持多层文件夹（DocumentEntry.ParentId + IsFolder + 创建文件夹端点） |
| feat | prd-admin | DocBrowser 升级为递归文件夹树（展开/折叠 + 面包屑导航 + 搜索自动展开） |
| refactor | prd-api | 文档空间改名为"知识库"，菜单移到首页实用工具区 |
| feat | prd-admin | 首页实用工具区新增知识库和涌现探索入口 |
| feat | prd-admin | TAPD缺陷采集与分析模板新增1p规则，AI技术服务费纳入技术专业委员会月度简报并支持逐月统计分析 |
| feat | prd-admin | 工作流脚本代码输入框升级为大尺寸编辑器，支持全屏编辑与高亮预览 |
| feat | prd-admin | 月报1p区块补充费用依据链接展示（可点击），并保留逐月统计分析表格 |

### 2026-04-06

| 类型 | 模块 | 描述 |
|------|------|------|
| feat | prd-api | 文档空间文件上传存盘：串联 IAssetStorage + FileContentExtractor + DocumentService，文件真实存储到 COS/本地 |
| feat | prd-api | 文档空间内容读取 API：从 ParsedPrd 或 Attachment.ExtractedText 获取文档文本 |
| feat | prd-api | 文档订阅源：支持添加 RSS/网页 URL 作为订阅，设定同步间隔 |
| feat | prd-api | DocumentSyncWorker 后台同步引擎：PeriodicTimer 扫描到期条目，自动拉取外部 URL 内容 |
| feat | prd-api | DocumentEntry 新增同步字段：SourceUrl、SyncIntervalMinutes、LastSyncAt、SyncStatus、SyncError |
| feat | prd-admin | 文档上传改用真实 multipart 上传端点（文件落盘，不再只存元数据） |
| feat | prd-admin | 文档详情面板增加「查看文档内容」预览功能 |
| feat | prd-admin | 新增订阅源对话框（输入 URL + 选择同步间隔） |
| feat | prd-admin | 订阅源条目用 RSS 图标区分，详情面板显示同步状态 + 手动同步按钮 |
| feat | prd-api | 新增 Workspace 工作空间模型（MongoDB workspaces 集合），支持 CLI Agent 持久化多轮对话 |
| feat | prd-api | 新增 WorkspacesController（创建/列表/详情/对话/删除），对话接口 SSE 流式响应 |
| feat | prd-api | 新增工作空间读写权限（workspaces.read / workspaces.write） |
| docs | doc | 新增 design.workspace.md 工作空间设计文档 |

### 2026-04-04

| 类型 | 模块 | 描述 |
|------|------|------|
| refactor | prd_agent | 重构质量保障技能链：修复流程链缺失/编号跳跃/描述不清，分类为主流程/辅助/专项修复/文档/元技能五类，用途改为"输入→输出"格式 |
| feat | prd_agent | 新增技能百科全书 doc/guide.skill-catalog.md：35 个技能完整索引 + 合并记录 + 调用链路图 + 维护指引 |
| refactor | prd_agent | 重写 README.md 为英文版，对齐 CLAUDE.md 内容结构，补充技能链和架构模式说明 |
| refactor | prd_agent | 合并 documentation-writer + technical-writing + user-guide-writing → technical-documentation（Diátaxis + 8 模板） |
| fix | prd_agent | 修复 deep-trace 触发词从 /trace 改为 /deep-trace，避免与 flow-trace 冲突 |
| feat | prd-admin | 新增文档空间前端页面（空间列表、空间详情、文档上传、搜索、删除） |
| feat | prd-admin | 文档空间空状态引导（三步引导 + CTA 按钮 + 拖拽上传） |
| feat | prd-admin | 文档 → 涌现流转入口：文档条目可一键跳转涌现探索器，自动预填种子内容 |
| feat | prd-admin | 涌现创建对话框支持从 URL 参数预填种子（文档空间跳转来时自动打开） |
| feat | prd-admin | 新增文档空间路由 /document-store，注册到 App.tsx |
| feat | prd-admin | 新增 documentStore 前端 service 层（contracts + real + api routes + index exports） |
| feat | prd-api | 新增涌现探索器后端（EmergenceTree + EmergenceNode 模型、EmergenceService、EmergenceController） |
| feat | prd-api | 涌现探索器支持三维涌现：一维系统内探索 + 二维跨系统涌现 + 三维幻想涌现 |
| feat | prd-api | 涌现核心设计：反向自洽原则（每个节点必须有现实锚点 + 桥梁假设 + 可回溯引用链） |
| feat | prd-api | 涌现探索/涌现端点支持 SSE 流式推送，节点逐个生长到画布 |
| feat | prd-admin | 新增涌现探索器前端页面（React Flow 画布、三维度自定义节点、工具栏） |
| feat | prd-admin | 涌现树列表 + 新建对话框 + 导出 Markdown |
| feat | doc | 新增 Page Agent Bridge 技术设计文档（编码 Agent 网页操控通道） |
| feat | cds | Page Agent Bridge：编码 Agent 通过 CDS Widget 读取页面 DOM 和执行操作 |
| feat | cds | Bridge HTTP 轮询服务 + REST API（/api/bridge/*）|
| feat | cds | Widget DOM 提取器（简化文本格式供 LLM 消费）|
| feat | cds | Widget 操作执行器（click/type/scroll/navigate/spa-navigate/evaluate）|
| feat | cds | 导航请求 UI（Agent 申请 → 用户点击打开 → 自动建立连接）|
| feat | cds | Console 错误和网络异常拦截上报 |
| feat | cds | 鼠标轨迹动画（渐变蓝光标 + 旋转光环 + 目标高亮 3s 淡出）|
| feat | cds | 操作面板（Badge 上方展开，步骤列表实时状态）|
| feat | cds | 按需激活（start-session/end-session 生命周期管理）|
| feat | cds | spa-navigate 四级策略（React Link → 注入 <a> → 文字匹配 → pushState）|
| fix | cds | 命令队列从单槽改为 FIFO 数组，防止连发丢命令 |
| fix | cds | URL 变化检测去除 WebSocket 残留引用 |
| fix | cds | end-session 改为 Widget 响应后清理（非固定延迟）|

### 2026-04-03

| 类型 | 模块 | 描述 |
|------|------|------|
| feat | prd-api | 新增文档空间基础设施（DocumentStore + DocumentEntry），支持文档存储、知识库内容管理 |
| feat | prd-api | 新增文档空间 CRUD API（空间创建/列表/详情/更新/删除 + 条目管理） |
| feat | prd-api | 新增 document-store.read / document-store.write 权限点与菜单入口 |
| feat | 技能 | 新增 document-emerge 涌现技能（/emerge），基于竞品矩阵驱动文档空间功能演进 |

### 2026-04-01

| 类型 | 模块 | 描述 |
|------|------|------|
| feat | prd-api | 周报 Agent 支持 Webhook 通知推送（企微/钉钉/飞书/自定义），6 种事件自动外发 |
| feat | prd-admin | 团队设置新增 Webhook 通知面板，支持 CRUD 和测试连通性 |
| feat | prd-api | 产品评审员 Agent 支持 Webhook 通知推送，评审完成后自动推送评分结果到企微/钉钉/飞书 |
| feat | prd-admin | 产品评审员页面新增「通知配置」弹窗，支持 Webhook CRUD 和连通性测试 |

### 2026-03-31

| 类型 | 模块 | 描述 |
|------|------|------|
| feat | cds | CDS 设置新增数据迁移功能，支持 MongoDB 实例间一键迁移，含 SSH 隧道、SSE 实时进度、迁移工具自动安装 |
| feat | cds | 数据迁移支持集合级选择迁移，可勾选指定集合或全库迁移 |
| feat | cds | 数据迁移 UX 优化：数据库下拉自动加载、目标库名自动同步、任务名自动生成、连接失败降级手动输入 |
| feat | cds | 数据迁移任务卡片展示源→目标链路、集合信息、耗时、SSH 标识，支持克隆/重新执行 |
| feat | cds | 新增 list-databases / list-collections API，支持前端下拉选择 |
| fix | prd-admin | 修复 surface-row 选中态被 hover !important 覆盖，新增 data-active CSS 选中态 |
| fix | prd-admin | 修复转录工作台预览/编辑切换按钮对比度不足，改为 pill toggle 高对比样式 |
| fix | prd-admin | 修复编辑模式 textarea 无边框无法辨识，增加 border + ring 视觉区分 |
| fix | prd-admin | 修复预览模式用 pre 标签渲染，改为 ReactMarkdown 渲染 |
| fix | prd-admin | 修复 SegmentRow 编辑入口无视觉提示，增加 hover 下划线和 cursor-text |
| fix | prd-admin | 修复侧边栏三级列表层级不清，增加工作区字重、图标色、树线可见度 |
| fix | prd-admin | 修复 GenerateDialog 模板选中态 inline style 冲突，迁移到 data-active |
| fix | prd-admin | 统一状态图标颜色从 green-500 到 emerald-400 语义 token |
| fix | prd-admin | 修复轮询死循环（items 在依赖数组导致无限 re-render），改用 useRef |
| fix | prd-admin | 修复 Segment 编辑无防抖每次击键触发 API，增加 500ms debounce |
| fix | prd-admin | 修复 selectedItem 状态冗余，改为 selectedItemId + useMemo 派生 |
| feat | prd-admin | 文案编辑支持保存，新增"保存"按钮和未保存提示 |
| feat | prd-api | 新增 PUT /api/transcript-agent/runs/{runId}/result 文案编辑保存接口 |
| feat | prd-api | 新增 TranscriptRunWatchdog，自动清理卡在 processing 超 30 分钟的任务 |
| fix | prd-api | SSE 进度流增加每 10 秒 keepalive 心跳，防止连接超时断开 |
| fix | prd-api | Worker 关闭时将处理中的 run 标记为 failed，防止孤儿任务 |
| fix | prd-api | RenameItem DB 写操作从 HttpContext.RequestAborted 改为 CancellationToken.None |
| fix | prd-api | SSE 轮询 DB 查询改用客户端 ct，客户端断开后立即停止轮询 |
| feat | prd-admin | 首页实用工具区新增网页托管入口 |
| feat | prd-admin | 侧边栏导航恢复显示网页托管入口 |
| feat | prd-admin | PageHeader 支持显示标题和描述，网页托管页顶部导航栏展示页面标题 |
| feat | prd-admin | 我的资源网页 tab 支持 iframe 缩略预览图，提取 SitePreview 共享组件 |

### 2026-03-30

| 类型 | 模块 | 描述 |
|------|------|------|
| fix | prd-admin | 修复 TypeScript 编译错误：移除未使用的导入和变量，修正 CreateImageGenRunInput 类型标注 |
| feat | prd-api | 视觉创作工作区列表接口支持 skip 分页参数和 hasMore 标记 |
| feat | prd-admin | 视觉创作工作区列表支持无限滚动，滑动到底部自动加载更多项目 |

### 2026-03-29

| 类型 | 模块 | 描述 |
|------|------|------|
| refactor | prd-api | 重构 CLI Agent 执行器为多执行器分发架构（builtin-llm/docker/api/script），支持自由扩展新执行器类型 |
| feat | prd-api | 新增 builtin-llm 执行器，无需 Docker 直接调用 LLM Gateway 生成页面，支持多轮迭代修改 |
| feat | prd-api | 新增 api 执行器，支持调用外部 HTTP API（OpenHands/Bolt 等）生成页面 |
| feat | prd-api | 注册 page-agent.generate::chat AppCallerCode |
| feat | prd-api | 新增 create-executor 技能，引导创建和接入新的执行器类型 |
| feat | prd-admin | Exchange 测试面板支持 doubao-asr-stream 流式模式，SSE 逐帧显示识别进度 |
| feat | prd-admin | Exchange 卡片新增「一键添加到模型池」按钮，预填模型类型和别名 |
| feat | prd-api | ExchangeController 新增 SSE 流式 ASR 测试端点 (带认证，替代 AllowAnonymous 端点) |
| feat | prd-api | TranscriptRunWorker 支持 doubao-asr-stream 流式 ASR 路径（自动检测 Exchange 类型） |
| fix | prd-api | 流式 ASR segment 去重，从最后一帧 utterances 提取带时间戳的精细分段 |
| feat | prd-admin | 转录工作台 UI 重构：双栏持久化布局（左栏素材+右栏编辑） |
| feat | prd-admin | 音频播放器组件（播放/暂停/进度/倍速/文字联动） |
| feat | prd-admin | 段落可编辑（点击即编辑，失焦自动保存） |
| feat | prd-admin | SSE 转录进度条组件（阶段+百分比+实时反馈） |
| feat | prd-admin | 拖拽上传组件 + 文案生成面板独立组件 |
| feat | prd-api | 新增 GET /transcript-agent/runs/{id}/progress SSE 端点 |
| docs | doc | guide.doubao-asr-relay.md 补充 AppCallerCode 接入指南和 Gateway 统一讨论 |
| feat | prd-api | 新增 lobster 龙虾测试执行器（两阶段 LLM：先规划结构再生成），验证执行器接入范式 |
| refactor | prd-api | 重写 create-executor 技能为全自治模式，Claude 自动读代码+生成+注册+自测 |
| fix | cds | Badge 弹窗面板自适应宽度，避免内容折叠 |
| feat | cds | 日志弹窗模态框，支持一键复制和文本选择 |
| perf | prd-api | CDS API 容器添加 GC 堆限制(256MB)、分层编译、NuGet/build 缓存卷，内存限制 384M |
| perf | prd-admin | CDS Admin 容器添加 Node.js 堆限制(192MB)、pnpm store 缓存卷，内存限制 256M |
| perf | prd-api | CDS MongoDB 限制 WiredTiger 缓存 150MB、关闭诊断数据采集，内存限制 256M |
| perf | prd-api | CDS Redis 限制 maxmemory 32MB + allkeys-lru 淘汰策略，内存限制 48M |
| feat | prd-api | CDS 部署模式切换：支持 dev(热重载) / static(编译部署) 两种模式，通过 x-cds-deploy-modes 配置 |
| feat | cds | CDS 分支卡片标签行新增编辑图标，支持批量编辑标签 |
| feat | cds | 预览页新增 AI 操控蓝色边框效果，与 Dashboard 一致的视觉反馈 |
| feat | cds | resolveEnvTemplates 支持从宿主机 process.env 读取环境变量 |
| refactor | prd-api | 清理 12 个未使用的 AppCallerCode 注册项（Desktop 5 个、VisualAgent 1 个、LiteraryAgent 1 个、AiToolbox 2 个、VideoAgent 1 个、ReportAgent 1 个、Admin.Prompts 1 个），从 91 个精简至 79 个 |
| docs | doc | 新增 design.review-agent.md：产品评审员完整技术设计文档 |
| feat | prd-admin | 转录工作台加入百宝箱 BUILTIN_TOOLS |
| feat | prd-api | 新增豆包 ASR (doubao-asr) Exchange 转换器，支持异步 submit+query 模式 |
| feat | prd-api | 新增 IAsyncExchangeTransformer 接口，LlmGateway 支持异步轮询中继 |
| feat | prd-api | 模型中继新增导入模板功能，内置 3 个模板（豆包ASR/流式WebSocket + fal.ai） |
| feat | prd-admin | 模型中继管理页面新增「从模板导入」入口和对话框 |
| feat | prd-api | 新增 DoubaoAsr 认证方案，支持豆包双 Header 认证模式 |
| feat | prd-api | Exchange 测试端点支持音频文件上传测试 (test-audio) |
| feat | prd-admin | Exchange 测试面板新增音频模式，支持文件上传和 URL 测试 |
| feat | prd-api | 新增 DoubaoStreamAsrService，实现豆包 WebSocket 二进制协议流式语音识别（含 PCM 自动重采样） |
| feat | prd-api | 新增 doubao-asr-stream 转换器标记和导入模板 |
| fix | prd-api | 修复流式 ASR 音频格式声明 (wav→pcm) 和结果提取 (result 对象兼容) |
| feat | prd-api | DoubaoStreamAsrService 自动重采样 + ffmpeg 转换（MP3/M4A/OGG/FLAC/WebM/MP4/24bit WAV） |
| feat | prd-api | 流式 ASR SSE 端点 (/api/test/stream-asr/sse)，逐帧推送识别结果 |
| fix | prd-api | 修复 24bit WAV 和截断 WAV 的边界处理 |
| feat | prd-api | Dockerfile + cds-compose.yml 自动安装 ffmpeg |

### 2026-03-28

| 类型 | 模块 | 描述 |
|------|------|------|
| feat | prd-api | 新增 CLI Agent 执行器胶囊（cli-agent-executor），支持调度 Docker 容器中的 CLI 编码工具生成页面/项目，支持多轮迭代修改 |
| feat | prd-admin | 前端注册 CLI Agent 执行器胶囊类型，含图标和 emoji 映射 |
| fix | prd-api | ParseReviewOutput 新增多策略解析：JSON 解析失败时自动用正则兜底提取 key/score 对 |
| fix | prd-api | ParseReviewOutput 现记录详细 parseError 诊断信息，存入 ReviewResult.ParseError |
| fix | prd-api | 处理 LLM 返回空内容的情况，以诊断信息标记而非静默产生 0 分 |
| feat | prd-admin | 评审结果页：当所有维度 0 分时显示诊断面板，含解析错误原因和原始 AI 输出 |
| fix | prd-api | 修复 ReviewAgent AppCallerCode 注册失败：将 ReviewAgent 类移入 AppCallerRegistry 内部，使反射扫描能发现它 |
| fix | prd-admin | 修复评审列表"未通过"误显示（null isPassed 历史记录现显示"已完成"） |
| feat | prd-admin | 评审列表新增"失败"筛选 Tab |
| feat | prd-admin | 全部提交页面新增状态筛选 Tab，与用户筛选联动 |
| refactor | prd-api | 评审提交筛选参数统一为 filter 字符串（passed/notPassed/error） |
| feat | prd-api | ReviewSubmission 新增 IsPassed 快照字段，评审完成时写入，重跑时清除 |
| feat | prd-api | 新增 GET /api/review-agent/submitters 端点，返回去重后的提交人列表 |
| feat | prd-api | GetMySubmissions 支持 isPassed 过滤参数 |
| feat | prd-admin | ReviewAgentPage 新增全部/已通过/未通过筛选 Tab、搜索栏和分页（50条/页） |
| feat | prd-admin | ReviewAgentAllPage 新增返回按钮和用户标签筛选（可展开/收起） |
| feat | prd-admin | ToolCard 新增 review-agent 封面图和封面视频路径映射 |
| feat | prd-admin | reviewAgent 服务新增 getSubmitters 函数，getMySubmissions 支持 isPassed 参数 |
| fix | prd-api | 修复 TryExtractJsonBlock 非贪婪正则导致嵌套 JSON 截断问题，改为先剥离 fence 再用 IndexOf/LastIndexOf 匹配最外层花括号 |
| feat | prd-api | 新增 POST submissions/{id}/rerun 端点，允许重置历史评审结果并重跑 LLM |
| feat | prd-admin | 评审结果页新增"重新评审"按钮，已完成或失败状态均可触发重跑 |
| feat | prd-api | 产品评审员 LLM 提示词严格化：明确评分原则、扣分依据、comment 扩展到100字 |
| feat | prd-admin | 评审维度配置支持编辑明细要求（description），点击展开编辑 |
| feat | prd-admin | 评审结果页维度展开时显示明细要求（蓝色标注区域） |
| feat | prd-api | 新增产品评审员 Agent（review-agent）后端：ReviewAgentController、ReviewSubmission/ReviewResult/ReviewDimensionConfig 模型、7 维度默认评审配置、SSE 流式评审输出、评审完成通知 |
| feat | prd-api | 新增 review-agent 权限常量（use/view-all/manage）及 AppCallerCode 注册 |
| feat | prd-api | MongoDbContext 注册 review_submissions、review_results、review_dimension_configs 三个集合 |
| feat | prd-admin | 新增产品评审员前端：ReviewAgentPage（列表）、ReviewAgentSubmitPage（上传提交）、ReviewAgentResultPage（SSE 实时评审结果）、ReviewAgentAllPage（全部提交，权限门控） |
| feat | prd-admin | toolboxStore.ts 首页新增"产品评审员"卡片（第三排第二位），authzMenuMapping.ts 注册三个权限点 |

### 2026-03-27

| 类型 | 模块 | 描述 |
|------|------|------|
| feat | doc | 新增 Agent 开发入门指南 (guide.agent-onboarding.md)，面向产品经理的 30 分钟全景阅读 |
| feat | .claude/skills | 新增 agent-guide 引导技能 (/help)，支持阶段式新手教程和跨会话进度跟踪 |
| feat | .agent-workspace | 新增 Agent 开发工作区目录，每个 Agent 独立文件夹管理进度 |
| feat | .claude/skills | 新增 scope-check 技能 (/scope-check)，提交前分支受控检查，检测越界修改 |
| feat | prd-api | 新增 transcript-agent 后端骨架（Controller/Models/权限/菜单/AppCaller/MongoDB） |
| feat | prd-admin | 新增 transcript-agent 前端页面（工作区/素材/转写/模板文案/导出） |
| fix | prd-admin | 修复登录跳转（hash URL 兼容 + returnUrl 回跳） |
| fix | prd-admin | 修复上传响应解析、JSON 双重序列化、res.ok→res.success 等前端问题 |
| refactor | prd-admin | 转录工作台 UI 重设计（三栏→导航式渐进深入） |
| fix | prd-api | 修复非团队成员可在团队管理页看到所有团队的权限漏洞：ListTeams 改用 ReportAgentTeamManage 判断全量可见性，而非 ReportAgentViewAll |
| fix | prd-api | 修复 GetTeam 详情端点缺少访问控制的安全漏洞，补充成员/负责人/管理员权限校验 |
| feat | prd-admin | 文学创作支持双模型切换（提示词模型 + 生图模型），与视觉创作体验一致 |
| feat | prd-api | 文学创作新增统一生图模型池端点 + 对话模型池端点 |
| feat | prd-api | 新增文学创作 Agent 偏好设置（双模型选择持久化） |
| feat | prd-api | Gateway CreateClient 支持 expectedModel 参数，用于模型切换调度 |
| refactor | prd-admin | 文学创作头部移除 T2I/I2I 双标签，改为提示词模型+生图模型双下拉菜单 |
| refactor | doc | design 文档模板重构：新增管理摘要、受众分层（前四节禁代码）、技术章节代码 ≤30% + 上下文说明 |
| refactor | doc | 37篇 design 文档批量优化：补管理摘要(30篇)、统一头部格式(21篇)、修正过时状态(8篇)、标注废弃概念(6篇) |
| feat | doc | 新增涌现篇 design.system-emergence.md：四层架构叙事 + 5个涌现场景 + 现实→幻想三维度 |
| feat | doc | 新增 design.visual-agent.md：VisualAgent 统一主文档，15项能力 + 4场景 + 12集合 |
| feat | doc | 新增 design.report-agent.md：周报 Agent 架构，13项能力 + 4场景 + 11集合 |
| feat | doc | 新增 design.rbac-permission.md：权限系统设计，40+权限项 + 5内置角色 |
| feat | doc | 新增 design.marketplace.md：配置市场设计，注册表模式 + Fork机制 |
| feat | doc | 新增 design.llm-gateway.md：LLM Gateway 架构，三级调度 + 6种池策略 |
| refactor | doc | 重写 design.literary-agent.md：从配图扩展为完整Agent全貌，5阶段状态机 + 4场景 |
| refactor | doc | 深化 design.defect-agent.md：补充4个涌现场景（Vision协同、分享、通知） |
| refactor | doc | 深化 design.workflow-engine.md：更新管理摘要 + 补充4个涌现场景 |
| fix | doc | 删除废弃文档 design.im-architecture.md（已被 Run/Worker 替代） |
| fix | doc | 合并 design.literary-agent-v2.md 到 literary-agent.md 后删除 |
| refactor | doc | 结构重排：所有新文档故事靠前设计靠后，接口字段放末尾 |
| refactor | doc | 写作规则固化：故事靠前/永远替换/按应用归属 三条原则写入 doc-types.md |

### 2026-03-25

| 类型 | 模块 | 描述 |
|------|------|------|
| feat | prd-admin | 放大作品广场爱心图标，使其接近头像大小 |
| fix | prd-admin | 生图意图前缀 "Generate an image based on the following description:" 不再泄漏到画布元素和投稿展示 |
| fix | prd-api | 后端存储 ImageAsset.Prompt 和画布占位时自动剥离生图意图前缀 |

### 2026-03-24

| 类型 | 模块 | 描述 |
|------|------|------|
| feat | cds | Activity 面板移除放大缩小控件，改为可拖拽边框调整窗口大小（左边、上边、左上角） |
| feat | cds | Activity 面板新增放大缩小控件 |
| feat | cds | 预览时隐藏右上角绿色人形图标，左下角眼睛图标改为眨眼动效 |
| fix | prd-admin | 修复视觉创作智能模式下生图提示词缺少英文前缀的问题 |
| feat | cds | 标签页标题功能：设置 tag 时用 tag 更新标题，无 tag 时默认用分支短名（去掉/前缀），设置菜单新增开关（默认开启） |
| fix | prd-admin | 智能优化模式默认关闭，仅用户手动开启才生效，禁止程序自动变更 |
| fix | prd-admin | 修复模型选择被自动覆盖的竞态：模型池未加载完时不再误判用户选择 |
| fix | prd-admin | 修复 _disconnected.conf 缺少静态资源处理，CSS/JS 文件被 SPA fallback 以 text/html 返回导致模块加载失败 |
| feat | cds | CDS proxy 在服务启动中 (starting) 时展示 loading 页面，避免请求打到半就绪的 Vite 导致 CSS MIME 错误 |
| feat | cds | Vite 默认构建配置添加 startupSignal，等待 Vite 完全就绪后才路由流量 |
| fix | prd-admin | 修复 VideoLoader 未使用变量、toast 缺少 loading/dismiss 方法、SuggestedQuestions 图标类型不兼容等 TypeScript 编译错误 |
| feat | prd-api | 新增生图提示词澄清端点 POST /api/visual-agent/image-gen/clarify，自动将用户自由文本改写为明确的英文生图提示词 |
| feat | prd-admin | 视觉创作生图流程集成提示词澄清，直连模式下自动优化提示词，降低生图失败率 |
| fix | prd-api | 修复 Gemini 通过 OpenAI 兼容网关代理时生图响应解析失败：增加响应体 candidates 特征检测，不再仅依赖 platformType |
| fix | prd-api | 修复 Google 生图 COS 上传失败时错误被吞为"响应解析失败"：COS 异常不再阻断生图，回退 base64 内联返回 |
| fix | prd-admin | 修复 imageDone URL 为空时的幽灵状态：既不显示图片也不显示错误，现在明确报错并允许重试 |
| feat | prd-admin | 新增生图 watchdog：每 15s 检查卡住超过 2 分钟的 running 项目，自动查询后端恢复图片或标记失败 |
| fix | prd-api | 初始化应用改为增量同步（upsert），保留专属模型池绑定和调用统计 |
| fix | prd-admin | 同步结果弹窗从满屏红色列表改为数字摘要卡片+可折叠详情 |
| refactor | prd-admin | 模型池管理页改为左右分栏 master-detail 布局，减少视觉噪音 |
| fix | prd-api | 修复文学创作预览图片无法显示：GetAssetFile 端点缺少 literary-agent 域搜索路径 |
| fix | prd-api | 修复文学创作工作区详情缺少 AssetIdByMarkerIndex 过滤，导致配图资源无法正确匹配 |
| fix | prd-api | 修复文学创作工作区详情缺少 TrySyncRunningMarkersAsync，导致卡住的配图标记无法自动恢复 |
| fix | prd-api | 修复旧数据配图回填：markers 存在但无 asset 关联时，按时间顺序自动建立关联 |
| feat | prd-admin | 文学配图卡片：图片区改为 4:3 宽高比，prompt 文字默认半可见(2行) hover 全可见(3行)，参考 Pinterest/Dribbble 渐进展示 |
| feat | prd-admin | 统一加载组件体系：PageTransitionLoader(页面级) + MapSectionLoader(区块级) + MapSpinner(行内级)，替代散落 80+ 处的 Loader2 animate-spin |
| refactor | prd-admin | 30 个文件批量迁移到统一加载组件，移除冗余 Loader2 引用 |
| fix | cds | 将 .cds/state.json 从 Git 跟踪中移除并加入 .gitignore，防止敏感环境变量（JWT Secret、云存储密钥等）泄露到仓库 |
| fix | cds | API 端点 GET /build-profiles 和 GET /env 返回值中对敏感字段进行脱敏处理 |
| feat | prd-admin | 页面跳转/懒加载期间播放 CDN 视频加载动画，替代空白等待 |
| fix | prd-admin | 修复视觉创作智能优化/解析模式面板颜色反转（AUTO徽章和橙色边框之前显示在错误的模式上） |
| fix | prd-admin | 生成新图/添加图片时视角只缩小适应不再放大，避免用户反复手动缩小视野 |
| refactor | prd-admin | 「解析模式」重命名为「直连模式」，移除直连模式的 planImageGen 调用，直接将原始输入发给生图模型 |
| feat | prd-admin | 作品广场改为瀑布流布局，图片按原始宽高比展示 |
| feat | prd-admin | 作品广场滚动到底部自动加载下一页（替代手动加载更多按钮） |

### 2026-03-23

| 类型 | 模块 | 描述 |
|------|------|------|
| fix | cds | 构建时锤子图标改为闪烁 + 按钮边缘发光，替代旋转动画 |
| fix | cds | branch-card 支持 server-driven 构建状态动画，外部触发的部署也能联动 |
| fix | prd-api | 修复机器人头像不显示：AvatarUrlBuilder 使用 User 重载以正确解析 BotKind 默认头像 |
| fix | prd-api | 修复用户发送消息时附件ID未保存到 Message 实体，导致图片丢失 |
| fix | prd-api | MessageResponse 和 GroupMessageStreamMessageDto 新增 AttachmentIds 字段 |
| fix | prd-desktop | 用户消息气泡支持渲染图片附件 |
| fix | prd-desktop | 发送消息时保留本地附件信息，SSE 合并时不丢失 |
| fix | prd-api | 修复文学创作投稿只显示 5/8 张图：不再过滤 ArticleInsertionIndex 为 null 的图片，简化为 Space 整体查询 |
| refactor | prd-api | Worker 更新 AssetIdByMarkerIndex 改用 MongoDB 原子 $set，消除并发竞争 |
| fix | prd-desktop | 修复服务器选择下拉框样式错乱，改用自定义下拉组件适配 Glass UI |
| fix | prd-desktop | 更新按钮样式更醒目（实色背景+阴影），提升可发现性 |
| feat | prd-desktop | macOS 更新安装后弹窗提示用户手动退出重启，不再依赖无效的自动重启 |
| fix | prd-desktop | 菜单"检查更新"对话框从无用的 OK 按钮改为"立即更新/稍后"确认框，点击立即更新直接下载安装 |
| feat | prd-desktop | Header 标题右侧显示版本号（v1.x.x），mono 字体偏右下角，亮/暗主题自适应 |
| feat | prd-api | 后端启动自动种子 18 个内置引导提示词到 skills 集合（PM/DEV/QA 各 6 个） |
| refactor | prd-desktop | 服务器选择改为三卡片布局（主站/测试站/备用 + 其他自定义），移除"我是开发者"开关 |
| fix | prd-api | 修复总裁面板排行榜 AppCallerCode 别名未归一化，导致 prd-agent-desktop 等作为独立维度泄漏 |
| fix | prd-api | 修复 Agent 统计端点缺少 report-agent 和 video-agent 的路由前缀和已知 key |
| refactor | prd-api | 提取 ExecutiveController 共享的别名映射和归一化逻辑为类级别方法，消除重复 |
| fix | prd-admin | 修复同项目作品缩略图右侧生硬截断，添加 mask 渐隐提示可滚动 |
| fix | prd-admin | ToolCard hover 缩放从 110% 降为 104%，减少圆角溢出感 |
| fix | prd-admin | 修复文学创作投稿时为每张配图创建独立 visual 投稿导致首页刷屏的问题，改为仅创建一个 workspace 级别的 literary 投稿 |
| fix | prd-admin | 文学创作手动投稿增加配图检查，无配图时提示先生成 |
| feat | prd-admin | 首页作品广场卡片增加管理员悬浮撤稿按钮 |
| feat | prd-api | 新增管理员撤稿 API (DELETE /api/submissions/{id}/admin-withdraw) |
| feat | prd-api | 新增历史数据清理端点 (POST /api/submissions/cleanup-literary-visual)，清除文学创作误建的 visual 投稿 |
| fix | prd-api | 修复文学创作投稿详情只显示 1 张图的问题：Worker 保存图片时未设 ArticleInsertionIndex 且未更新 AssetIdByMarkerIndex |
| fix | prd-api | 修复投稿详情兜底查询将所有无索引图片分到同一组只取 1 张的问题 |
| feat | doc | 新增投稿画廊展示规格文档 (spec.submission-gallery.md)，明确视觉创作单图投稿 vs 文学创作 Space 投稿的粒度差异 |
| feat | prd-admin | 文学创作页新增按时间/按文件夹视图切换，偏好保存到 sessionStorage |
| feat | prd-admin | 文学创作工作区卡片改为 NotebookLM 风格（有配图则显示最新配图，无则用渐变背景） |
| feat | prd-admin | 文学创作卡片按时间视图左上角显示文件夹名，按文件夹视图不显示 |
| feat | prd-admin | 作品广场改为统一等高网格布局（16:10 比例），替代瀑布流，视觉/文学卡片风格统一 |
| feat | prd-admin | 作品广场网格自适应列宽，视窗越宽显示越多列 |
| feat | prd-api | 文学创作列表接口新增 latestIllustrationUrl 字段（每个工作区最新生成的配图 URL） |
| feat | prd-admin | 首页作品广场文学创作专属卡片（LiteraryCard），区分视觉/文学展示风格 |
| feat | prd-admin | 文学创作列表页改为时间线布局，同一文件夹内按天分组陈列 |
| fix | prd-api | 修复 28 个 Controller 的 GetAdminId/GetUserId 回退到 "unknown" 的安全隐患，统一使用 GetRequiredUserId 扩展方法 |
| fix | prd-admin | 全站 localStorage 替换为 sessionStorage，关闭浏览器即清空缓存，部署后强制重新登录 |
| refactor | prd-api | 禁用 MongoDB 自动建索引，改为 DBA 手动执行（doc/guide.mongodb-indexes.md） |
| feat | prd-api | 文件上传自动检测文本/二进制：已知格式用提取器，其他尝试 UTF-8 解码，通过 null 字节和控制字符比例判断 |
| feat | prd-desktop | 三阶段文件上传体验：已知格式直接放行、已知二进制立即拒绝、未知格式标记"探测中"后上传并反馈结果 |
| feat | prd-desktop | 逐文件上传进度面板，实时显示每个文件的状态（排队/检测/上传/成功/失败） |
| feat | prd-admin | 附件和追加文档支持三阶段检测：已知放行、已知拒绝、未知格式客户端快速探测 null 字节 |
| refactor | prd-desktop | 移除文件格式白名单和 read_text_file 命令，所有文件统一走 upload 接口 |
| feat | prd-api | 对话完成后自动生成推荐追问（轻量模型，5秒超时，失败静默） |
| feat | prd-admin | 新增推荐追问 UI 组件，支持点击自动发送 |
| feat | prd-api | Message 模型新增 SuggestedQuestions 字段，支持历史回放 |
| fix | prd-api | 修复 UTF-16 编码文件被 null 字节检测误判为二进制的问题（支持 UTF-16 LE/BE 和 UTF-32 LE BOM 检测） |
| fix | prd-admin | 追加文档和附件上传增加 20MB 前端文件大小校验，避免大文件浪费带宽后被后端拒绝 |

### 2026-03-22

| 类型 | 模块 | 描述 |
|------|------|------|
| feat | prd-api | 成本中心：ModelGroupItem 新增定价字段（InputPricePerMillion/OutputPricePerMillion/PricePerCall），模型统计 API 返回成本估算 |
| feat | prd-admin | 成本中心：新增预估成本 KPI、成本构成面板、明细表增加图片数和预估成本列 |
| fix | prd-api | 移除 LlmRequestLogs/ApiRequestLogs 的 TTL 自动删除机制，改为普通索引，保留全部历史数据 |
| feat | prd-admin | 日常记录新增 Todo 系统标签与下周/下下周目标周选择，Todo 输入提示改为“计划做些什么？”，并支持编辑与展示计划周 |
| feat | prd-api | 日常记录条目新增 planWeekYear/planWeekNumber，Todo 条目保存时强制校验 ISO 周 |
| feat | prd-api | 周报生成在“下周计划”章节优先读取目标周匹配的 Todo 条目（读取所有命中目标周）并作为 AI 与规则兜底的数据源 |
| fix | prd-admin | 日常记录系统标签改为 Todo 与其它系统标签互斥（快速录入与编辑态一致） |
| fix | prd-api | 保存日常记录时增加 Todo 与其它系统标签互斥兜底校验，拦截非法组合 |
| feat | prd-admin | 周报页新增可交互“使用指引”面板：默认收起，支持管理员/成员视角切换与一键跳转操作 |
| feat | prd-admin | “使用指引”升级为全局蒙版模式：仅保留顶部按钮开关，覆盖周报/团队/设置模块，最小化干扰正式页面 |
| fix | prd-admin | 修复全局指引浮层在侧边导航场景下的遮挡与对齐问题，并下调蒙版透明度与浮层高度提升轻量质感 |
| fix | prd-admin | 周报相关界面用户可见文案将“打点”统一调整为“记录”（含提示文案与趋势标签） |
| feat | prd-api | 周报详情新增“浏览记录”能力：记录每次查看事件（精确到秒），提供去重人数与总浏览次数汇总，并按用户标记“常来”（浏览次数>5） |
| feat | prd-admin | 周报详情页头部新增“已阅 N”轻量标签，支持查看浏览明细（秒级最近浏览时间、个人浏览次数与“常来”标识） |
| fix | prd-api | Mongo 索引初始化补齐 channel_tasks 的 CreatedAt TTL 自愈升级，兼容历史普通索引避免部署启动崩溃 |
| fix | prd-api | Mongo 索引冲突识别补充 Code/Message 兜底，避免 CodeName 缺失时未进入 TTL 自愈分支 |
| fix | prd-admin | 修复首页作品广场瀑布流布局空隙问题，从 CSS Grid 改为 CSS columns |
| feat | prd-admin | 统一文学创作和视觉创作的投稿图标为 Send |
| feat | prd-admin | 新增手动投稿按钮，支持将当前页面已生成内容一键投稿（文学创作 + 视觉创作） |
| feat | prd-admin | 实验室新增工具箱 Tab，支持历史素材批量迁移投稿（幂等） |
| fix | prd-admin | 创建用户对话框角色选项从硬编码4个改为使用 ALL_ROLES 动态渲染全部12个角色 |
| fix | prd-desktop | 同步 UserRole 类型定义，补全 HR/FINANCE/RD/TEST/COPYWRITER/CSM/SUPPORT/SALES 8个新角色 |
| fix | prd-admin | 缺陷评论区支持 Markdown 渲染，修复加粗/列表等格式显示为原始标记的问题 |
| fix | prd-api | 修复作品广场水印预览图始终显示"无预览"，PreviewUrl 为运行时计算字段未持久化 |
| fix | prd-api | 已驳回的缺陷不再出现在驳回人（指派人）的列表中，只对提交人可见 |
| fix | prd-admin | 修复缺陷详情面板严重程度下拉菜单被对话框 overflow-hidden 遮挡的问题 |
| fix | prd-admin | 综合排行榜 report-agent 列显示为中文"周报" |
| fix | prd-admin | 维度排行榜长条改为以最高值为100%的相对比例渲染 |
| feat | cds | 分支搜索无匹配时自动在线刷新远程分支，显示搜索中状态 |
| fix | prd-admin | 综合排行榜进度条分母上限封顶30天 |
| refactor | prd-api, prd-admin | 排行榜移除冗余维度(消息/会话/群组/开放/对话)，新增图片生成/工作流/竞技场/周报Agent/视频Agent |
| feat | prd-admin | 维度排行榜卡片按使用人数倒序排列 |
| fix | prd-api | 修复 DefectSeverity 枚举不匹配：后端新增 Trivial 常量，更新 validSeverities 使用 All 数组（DEF-2026-0037） |
| fix | prd-api | 修复清理上下文后消息仍显示：GetGroupMessages 端点新增 reset marker 过滤（DEF-2026-0049） |
| fix | prd-api | 新增 AiScoreWatchdog 后台服务，自动检测并标记超时的 AI 评分任务为失败（DEF-2026-0018） |
| fix | prd-api | 修复水印预览不显示：移除预览端点所有权限制 + 新增自愈重新渲染机制（DEF-2026-0062） |
| fix | prd-api | 修复新用户无模板：ListTemplates 接口在用户无模板时补充内置默认模板（DEF-2026-0020） |
| fix | prd-admin | 修复 AuthUser.role 类型与 UserRole 枚举不一致的 TS 编译错误 |
| fix | prd-admin | 新增 tutorialData.ts 模块，修复 TutorialDetailPage 缺失模块导入错误 |
| fix | prd-admin | 清理 TutorialDetailPage 未使用的导入和变量 |
| fix | prd-admin | 未登录访问根路径默认跳转公开首页(/home)而非登录页，退出登录显式跳转到登录页(/login) |
| fix | prd-admin | 修复下载弹窗卡片内文件名文字重叠 |
| fix | prd-admin | 修复缺陷管理图片预览关闭后残留幽灵遮罩层（灯箱缺少z-index） |
| fix | prd-admin | 修复系统弹窗（驳回/完成缺陷等）被缺陷详情面板盖住的根因，Dialog组件新增zIndex prop |
| feat | prd-api | 新增 POST /api/users/force-expire-all 接口，一键过期所有用户令牌 |
| feat | prd-admin | 用户管理页新增"一键过期"按钮，强制全员重新登录 |
| fix | prd-admin | 修复缺陷管理图片预览弹窗无法关闭且层级错误，改用独立 Radix Dialog 嵌套 |
| fix | prd-admin | 修复切换用户登录后侧边栏头像显示为默认头像（impersonate 未传递 avatarFileName） |
| feat | prd-admin | 首页和 AI 百宝箱智能助手卡片点击后弹窗引导下载桌面端（含缓存+直接下载） |
| fix | prd-admin | 修复 SubmissionCard 中 HeartLikeButton 点赞动效未触发的问题 |
| fix | prd-api | 文学创作投稿详情和工作区详情仅展示当前版本配图，隐藏重新生成的旧版本 |
| feat | prd-admin | 新增作品广场独立全屏页面，替换首页缺陷管理快捷入口 |
| feat | prd-admin | 投稿水印 Tab 复用海鲜市场 MarketplaceWatermarkCard 组件，支持"拿来吧"Fork |
| feat | prd-api | 新增 POST /api/submissions/{id}/fork-watermark 从快照 Fork 水印（不要求原配置公开） |
| feat | prd-api | 投稿详情水印数据补充 forkCount、创建者名称/头像、预览图 URL |
| fix | prd-api | 水印创建者名称兜底：空字符串 → 投稿者名称；旧快照 → submission.OwnerUserName |
| fix | prd-api | fork-watermark 端点 nullable double → non-nullable 类型默认值 |
| feat | prd-admin | 新增 HeartLikeButton 心型点赞特效组件（心跳+粒子+波纹），注册到特效专区 |
| feat | prd-api | 投稿列表接口补充 viewCount 字段 |
| feat | prd-admin | SubmissionCard 观看数圆角胶囊样式，万级自动缩写 |
| feat | prd-admin | SubmissionDetailModal 点赞按钮替换为 HeartLikeButton 特效 |
| feat | prd-api | 水印快照存储完整配置（大小/透明度/位置/偏移/图标/边框/背景/圆角） |
| feat | prd-admin | 投稿详情水印 Tab 使用 WatermarkDescriptionGrid 组件展示完整配置 |

### 2026-03-21

| 类型 | 模块 | 描述 |
|------|------|------|
| fix | cds | SSE 端点添加 30s keepalive 心跳，修复 Cloudflare 524 超时导致 pairing-stream 反复断连 |
| feat | cds | CDS Activity 面板每条记录前显示来源分支 ID（截取最后一段），方便定位请求来源 |
| feat | prd-api | 扩展 UserRole 枚举，新增行政/财务/研发/测试/文案/客成经理/客服/销售 8 个业务角色 |
| feat | prd-admin | 新建 roleConfig.ts 统一角色元数据（中文标签、专属图标、颜色），全站角色显示中文化 |
| refactor | prd-admin | 消除角色颜色定义散落（UserSearchSelect/UsersPage/ExecutiveDashboard），统一引用 ROLE_META |
| fix | prd-admin | 广场排序：CSS columns 改 CSS grid，修复 API 返回顺序被打乱的问题 |
| fix | prd-admin | 详情页增加「参考图」「水印」tab，提示词 tab 包含风格词和系统提示词 |
| fix | prd-admin | 详情页右下角增加同项目作品扇形输出列表 |
| feat | prd-api | 投稿新增 GenerationSnapshot 快照：创建时采集完整输入配方（模型、提示词、参考图、水印），详情 API 返回 4 Tab 完整数据 |
| feat | prd-api | 新增 backfill-snapshots 回填端点，为已有投稿补充生成快照 |
| fix | prd-api | 修复文学配图对技术文档类文章拒绝生成的问题，增加不可拒绝约束和技术文档风格推断 |
| fix | prd-admin | 文学创作单张生成也触发自动投稿（之前只有批量一键导出才触发） |
| fix | prd-api | COS 上传超时从默认 45s 提升到 120s，解决大图上传超时问题 |
| feat | prd-api | 文学投稿改为公开 workspace 模式：广场封面动态取最新资产，新图自动出现 |
| fix | prd-admin | 修复作品广场图片不显示问题(display:none+lazy loading冲突) |
| fix | prd-admin | 修复文学创作tab切换后整个面板消失 |
| feat | prd-admin | 作品广场瀑布流布局重构为Lovart风格有机布局 |
| feat | prd-api | 作品广场排序改为点赞数+时间双降序 |
| feat | prd-api | 作品详情API返回生成参数(模型/图生图/涂抹/系统提示词) |
| feat | prd-admin | 详情弹窗左侧加宽+阴影渐隐，右侧新增生成参数标签 |
| feat | prd-api | 新增文学创作workspace批量迁移投稿端点 |
| feat | prd-api | 新增作品投稿系统：Submission + SubmissionLike 模型、SubmissionsController（公开列表/创建/点赞/取消点赞/自动投稿） |
| feat | prd-admin | 首页新增作品广场瀑布流展示区（ShowcaseGallery），支持分类筛选和分页加载 |
| feat | prd-admin | 视觉创作生图完成后自动投稿到作品广场 |
| feat | prd-admin | 文学创作配图完成后自动投稿到作品广场 |
| feat | prd-admin | 投稿卡片展示：头像+用户名（左下）、爱心+点赞数（右下） |
| feat | prd-admin | 作品详情弹窗：视觉创作（大图+提示词+同项目作品）、文学创作（缩略图列表+大图+正文/提示词tab） |
| feat | prd-api | 作品详情 API（GET /api/submissions/{id}）：含关联资产、文章内容、浏览计数 |
| feat | prd-api | admin 用户历史图片迁移接口（POST /api/submissions/migrate） |
| feat | prd-api | Submission 模型新增 ViewCount 浏览计数字段 |
| feat | prd-api | 百宝箱消息反馈（点赞/踩）API 端点 |
| feat | prd-api | 百宝箱对话分享链接 API（创建+查看） |
| feat | prd-api | 直接对话 SSE 流返回 token 用量 |
| feat | prd-admin | 消息反馈持久化（thumbs up/down） |
| feat | prd-admin | 对话分享功能（生成公开链接） |
| feat | prd-admin | 键盘快捷键（Ctrl+Shift+N/E/Backspace, Esc） |
| feat | prd-admin | 系统提示词可视化（左侧面板折叠展示） |
| feat | prd-admin | 助手消息显示 token 用量 |
| fix | prd-admin | 修复工具箱重发功能：不再重复用户消息，正确携带原始图片附件 |
| feat | prd-admin | 工具箱会话标题自动从首条消息生成，前端实时同步 |
| feat | prd-admin | 内置 Agent 支持"自定义副本"，一键 fork 为可编辑的自定义智能体 |
| feat | prd-admin, prd-api | 会话支持双击重命名（新增 PATCH sessions/{id} 端点） |
| feat | prd-admin, prd-api | 聊天面板展示当前使用的模型名称 |
| feat | prd-admin | 内置 Agent 注册系统提示词，便于 fork 时预填 |
| feat | prd-api | 百宝箱会话搜索：支持按标题模糊匹配 (MongoDB regex) |
| feat | prd-api | 百宝箱会话排序：支持 lastActive/created/messageCount/title |
| feat | prd-api | 百宝箱会话归档：切换归档状态，默认排除已归档 |
| feat | prd-api | 百宝箱会话置顶：切换置顶状态，置顶始终排在最前 |
| feat | prd-admin | 会话列表搜索输入框，防抖300ms |
| feat | prd-admin | 会话排序下拉菜单 (最近活跃/创建时间/消息数/标题) |
| feat | prd-admin | 会话归档按钮 + "显示已归档"开关，归档会话降低透明度 |
| feat | prd-admin | 会话置顶按钮，置顶会话显示 Pin 图标 |
| feat | prd-api | 百宝箱 DirectChat 启用 IncludeThinking 并透传 thinking SSE 事件 |
| feat | prd-admin | 百宝箱对话展示大模型思考过程（可折叠，复用 SseTypingBlock） |
| feat | prd-admin | 文件上传预验证（类型+大小 20MB 限制），拒绝不支持的文件 |
| feat | prd-admin | 上传进度改为逐文件显示文件名和大小，增强附件预览样式 |

### 2026-03-20

| 类型 | 模块 | 描述 |
|------|------|------|
| feat | prd-api | 团队新增“AI分析Prompt”配置能力：`/api/report-agent/teams/{id}/ai-summary-prompt` 支持获取/更新/重置，团队汇总生成链路改为“团队已提交周报 + 生效 Prompt”驱动，并增加团队级默认 Prompt 常量与 `ReportTeam.TeamSummaryPrompt` 持久化字段 |
| feat | prd-admin | 设置页管理区新增“团队周报AI分析Prompt”模块（填充第三列空位），交互对齐“AI生成周报Prompt”（系统默认只读 + 团队自定义可保存/恢复默认 + 状态标识 + 团队切换）并打通对应前端 contracts/api/service 调用链 |

### 2026-03-19

| 类型 | 模块 | 描述 |
|------|------|------|
| fix | prd-api | ModelResolver 强制校验 AppCallerCode 必须已注册到 `llm_app_callers`，未注册时直接报错而非静默回退默认池 |
| fix | prd-api | 移除启动时自动同步 AppCallerRegistry 的 HostedService，改为仅通过管理后台手动「初始化应用」触发 |
| fix | prd-admin | 修复应用模型池管理页分页 Bug（默认 pageSize=50 导致仅加载前 50 条，report-agent 等应用不可见），改为一次加载全部 |
| feat | prd-admin | 初始化应用结果改为模态框展示删除/孤儿清理/新建的完整列表，替代原来的 toast 通知 |
| fix | prd-admin | 补全应用显示名称映射（report-agent、video-agent、workflow-agent 等）；统一周报设置页个人设置与管理设置卡片网格，确保两个模块尺寸与排列一致对齐；“添加扩展源”入口改为敬请期待提示并隐藏具体添加界面；在“我加入的团队”视角隐藏并禁用“团队周报AI分析”入口，仅负责人/副负责人可操作；调大“AI生成周报Prompt”页系统默认 Prompt 只读输入区默认高度，并同步拉长自定义 Prompt 区域默认高度（rows + minHeight 双保险） |
| refactor | prd-admin | 废弃提示词管理页，功能统一迁移至技能管理页：新增魔法棒、拖拽排序、系统指令 Tab |
| refactor | prd-admin | 技能编辑器分简洁/高级模式：核心区只显示名称+角色+提示词，其余字段折叠到「高级配置」 |
| refactor | prd-api, prd-desktop, prd-admin | 彻底移除旧提示词系统：删除 IPromptService/PromptService/PromptStagesController/PromptStagesOptimizeController/PromptSettings 模型、Desktop get_prompts 命令及 PromptClientItem 类型、Admin PromptStagesPage 及 prompts 服务层；SkillParameter 迁移至 Skill.cs；SkillService 移除迁移代码和 IPromptService 依赖 |
| fix | prd-admin | 修复右侧编辑器面板不撑满高度的布局问题；移除无用的文学创作 Tab |
| fix | prd-desktop | 移除旧 get_prompts 5 分钟轮询（技能统一后 ChatInput 已走 get_skills 事件驱动） |
| fix | prd-api | 提示词迁移技能时 SkillKey 从标题生成有意义的名称，替代 legacy-prompt-N-role 格式 |
| fix | prd-api | 全面审计并修复 AppCallerRegistry 一致性：补注册 `prd-agent.skill-gen::chat`、`prd-agent.arena.battle::chat`、`video-agent.video-to-text::chat`、`video-agent.text-to-copy::chat`、`channel-adapter.email::classify`、`channel-adapter.email::todo-extract` 共 6 个缺失 appCallerCode；修复 Controller 中错误类路径引用；移除 AppJsonContext 中 4 个不存在的类型引用 |
| refactor | prd-admin | useSseStream hook 增强：支持 POST/body/headers/动态 URL 覆盖 + connectSse 服务层工具 |
| refactor | prd-admin | 8 个 SSE 组件迁移至 useSseStream/connectSse 基础组件（PromptStagesPage、QuickActionConfigPanel、DesktopLabTab、WorkflowChatPanel、imageGen、literaryAgentConfig、ExecutionDetailPanel、ArenaPage） |
| refactor | prd-admin | ArenaPage handleRetry/handleSend 去重，提取 launchBattle 公共方法 |
| fix | prd-api | ViewShare agentInstructions URL 修复：读取 X-Forwarded-Host/Proto 避免返回容器内部地址 |
| fix | prd-admin | AI 评分 SSE 404 修复：闭包陷阱导致 fetch('') 请求页面路径 |
| enhance | prd-admin | AI 评分面板改为表格布局：表头排列严重度/难度/影响/综合分，点击行展开理由，色块徽章替代进度条 |
| fix | prd-api | 缺陷分享 3 个外部端点(view/report/fix-status)添加 AiAccessKey 认证方案，修复 X-AI-Access-Key 403 |
| fix | prd-admin | 分享复制提示词 X-AI-Impersonate 改为当前用户名，增加 Bearer Token 备选认证方式 |
| feat | prd-api | AI 评论端点 POST share/view/{token}/comments：外部 AI Agent 可在缺陷对话中发表评论 |
| feat | prd-api, prd-admin | DefectMessage 新增 Source/AgentName 字段，前端 AI 消息展示蓝色 AI 徽章 |
| enhance | prd-api | fix-status 端点增强：自动标记 IsAiResolved + ResolvedByAgentName |
| enhance | prd-admin | 分享复制提示词重写为 6 阶段工作流（列清单→评论→报告→修复→验收→标记完成） |
| feat | 技能 | 新增 ai-defect-resolve 技能：AI 辅助缺陷修复标准工作流 + 安全协作规则 |
| feat | prd-api, prd-admin | 附件持久化 AI 图片描述：AddAttachment 接受 description 参数，提交缺陷时保存 Vision 解析结果 |
| enhance | prd-api | ViewShare 返回增强：附件按类型分组(screenshots/logs/files) + 携带 AI 描述 + 消息历史 + 分析优先级指引 |
| feat | cds | CDS 自动更新小组件：proxy 动态注入 vanilla JS widget 到 HTML 响应（零侵入前端项目），支持单服务/全量更新按钮（SSE 实时进度），`/_cds/api/*` 透传路径，可拖拽浮窗 |
| fix | cds | 删除卡片内联部署日志框（挤压布局），部署日志改为仅通过工具栏日志按钮查看 |
| fix | cds | 白天模式日志/终端面板配色修复：改用暖色系浅背景，文字颜色跟随主题变量 |
| fix | cds | Widget 注入修复（/verify 交叉验证）：非 HTML 资源保留压缩传输、支持 gzip/br/deflate 解压注入、304 直接透传、SSE reader 加 catch |
| fix | cds | 白天模式刷新闪烁修复：theme 初始化移至 head 内联脚本，CSS 加载前生效 |
| fix | cds | 自动更新分支选择改为自定义 combobox（可输入+下拉列表），修复 ID 冲突/下拉裁剪/icon 过小/widget 401 认证 |
| feat | cds | 新增"清理非列表分支"功能：一键删除不在 CDS 部署列表中的本地 git 分支（保护 main/master/develop/当前分支） |
| fix | prd-api, prd-admin | LLM 日志用户信息增强：列表和筛选元数据接口补充 DisplayName 字段，前端显示格式改为"姓名 用户名" |
| fix | prd-api | LLM 日志 MECE 全量补全 UserId：覆盖 BeginScope 路径(ArenaRunWorker/DefectAgentController/PreviewAskService/PromptStagesOptimize) + GatewayRequest 路径(Toolbox 全系适配器/VideoGenRunWorker/VideoToDocRunWorker/WorkflowAiFillService/WorkflowAgentController/ImageMasterController/TutorialEmailController) |
| feat | prd-api | LlmRequestLogWriter 写入时检测 UserId 为空自动输出 Warning 日志，防止未来新增调用路径遗漏 |
| feat | prd-api | 模型池自动探活：新增 ModelPoolHealthProbeService 后台服务，周期性探测不健康端点并自动恢复，支持并发锁、冷却期、可配置参数 |
| feat | prd-api | 模型池故障/恢复通知：全池耗尽时创建管理员通知（Key 幂等去重），探活恢复后自动关闭故障通知并发送恢复消息；Gateway 层向请求失败用户发送个人通知 |
| feat | prd-api | 快捷模型池配置 API：新增 POST /api/mds/model-groups/quick-setup 端点，一次性创建带降级链的模型池并可选绑定 AppCaller |
| feat | prd-api | LLM 日志探活标记：LlmRequestLog 新增 IsHealthProbe 字段，探活请求在日志中独立标记，便于管理后台过滤 |
| feat | prd-admin | 工作流创建后直接跳转画布页面，而非编辑器页面（新建、测试模板、导入模板三种入口统一） |
| feat | prd-api, prd-admin | 自定义智能体多格式文件支持：上传 PDF/Word/Excel/PPT 时自动提取文本内容注入 LLM 上下文，新增 IFileContentExtractor 服务（DocumentFormat.OpenXml + PdfPig），Attachment 模型增加 ExtractedText 字段，DirectChat 端点支持 attachmentIds 参数 |
| fix | prd-desktop | 清理冗余桌面图标源 `app-icon.png`，统一仅使用 `icon.png` 生成 `src-tauri/icons/*`，避免替换图标后运行仍显示旧图标 |
| fix | prd-admin | Safari 弹窗显示不全：Dialog 居中方式从 `fixed inset-0 m-auto h-fit` 改为 Overlay flex 居中，修复 Safari 不支持 `height: fit-content` 在 fixed 定位下的布局问题 |
| fix | prd-admin | Safari 兼容性批量修复：`backdrop-filter` 全量补齐 `-webkit-` 前缀（7 处 CSS + 24 处内联样式）、`@property` 动画降级（`@supports` 回退 `transform: rotate`）、`conic-gradient` 添加 `linear-gradient` 回退、内联 `inset: 0` 展开为 `top/right/bottom/left`、`aspect-ratio` 添加 `@supports` 降级 |
| fix | prd-admin | Safari Dialog 输入框 focus 发光被裁剪：`overflow-y-auto` 滚动容器添加 `-mx-1 px-1` 呼吸空间，防止 Safari 裁剪子元素 `box-shadow` 溢出 |
| fix | prd-admin | 文学创作配图卡片入场特效 Safari 降级修复：`transform:rotate` 回退改为静态渐变边框淡入淡出，消除矩形伪元素旋转溢出的对角线伪影 |
| feat | prd-api, prd-desktop, prd-admin | 桌面客户端更新加速：后台自动将 GitHub Release 缓存到 COS，客户端优先走加速端点（3s 超时回退 GitHub），管理后台新增"更新加速"设置页签，支持手动触发缓存和查看状态 |
| feat | prd-desktop | 更新提醒新增"极速下载"标签：加速源命中时通知弹窗和设置页更新面板均显示闪电图标+琥珀色主题，区分 GitHub 回退源 |
| feat | skills | 新增 skill-validation 需求验证技能（/validate）：8 种需求气味检测 + 功能雷同排查 + 七维度 RICE/WSJF/ISO 29148 混合打分 + 综合判定（通过/改进/驳回），融合 ARTA/Paska 学术模式，补全质量保障链条的需求阶段 |
| fix | prd-admin | 百宝箱卡片缩小至原来 1/3~1/4 大小，grid 改用 auto-fill + minmax(140px) 使列数随屏幕宽度自适应；修复 Spotlight 边框溢出；全站补全 agent 封面图映射（首页/百宝箱/Agent切换器 三处统一，新增 arena/shortcuts/workflow/report）；自定义工具卡片底栏显示作者头像+名字+使用次数 |
| feat | prd-desktop | 主题切换升级为 View Transition API 水波纹动效：从按钮位置圆形 clip-path 扩散，替代旧的 520ms 线性过渡，不支持的浏览器自动降级为瞬时切换 |

### 2026-03-18

| 类型 | 模块 | 描述 |
|------|------|------|
| feat | prd-api, prd-admin | 缺陷分享一键分享 + AI SSE 流式评分（实时推送打字效果和逐条评分结果） |
| feat | prd-api | 新增外部 AI Agent 标记缺陷修复状态端点（fix-status），自动通知缺陷提交者 |
| feat | prd-api | ViewShare 端点增强 LLM 友好响应（含 agentInstructions、操作流程、端点 schema） |
| feat | prd-admin | 分享复制剪贴板改为完整 AI 提示词（含 API 地址、认证说明、操作步骤） |
| feat | prd-admin | AI 评分实时面板：阶段提示、LLM 打字效果、评分表逐行动画 |
| rule | 全局 | CLAUDE.md 新增强制规则：LLM 交互过程可视化（禁止空白等待） |
| feat | prd-admin | 新增 SSE 基础组件库：useSseStream hook、SsePhaseBar、SseTypingBlock、SseStreamPanel |
| feat | 全局 | 新增 llm-visibility 技能：LLM 交互过程可视化审计 + 组件指南 |
| feat | cds | ClawHub 暖色调仅亮色模式：H27° 暖米背景、暖褐文字、朱红 accent、海沫绿 success、alpha 透明度边框/阴影、径向暖光晕；暗色模式保持原翡翠绿方案不变（tag: pre-clawhub-theme 可还原） |
| fix | cds | 白天模式颜色修复：背景纯白、饱和度提升、modal/日志面板适配、accent 颜色加深 |
| fix | cds | 重新部署时立即清除之前的拉取/部署错误信息（前后端同步清除） |
| feat | cds | 主题切换按钮移至顶部栏，View Transition API 水波纹动效（圆形clip-path扩散），暗色 #131314/#1E1F20、亮色 #FFFFFF/#F0F4F9 |
| feat | cds | 清理孤儿分支：新增"清理孤儿分支"入口（设置菜单），自动 fetch 远程后对比，删除远程已不存在的本地分支及其容器和 worktree |
| feat | cds | 启动成功标志：设置菜单新增配置入口（基础设施和路由规则之间），为每个服务指定日志中的启动成功字符串（如 "Now listening on"），CDS 监听容器日志检测到后才标记为运行中 |
| feat | cds | 停止状态视觉反馈：停止容器时卡片周围闪烁红光脉冲动画 + 端口徽章红色闪烁 + "正在停止"状态徽章 |
| fix | cds | 部署日志显示不全：内联日志从 8 行增至 20 行、默认高度从 120px 增至 280px、容器日志尾部从 100 行增至 500 行、操作日志持久化容器输出 |
| feat | cds | 中间态 UX 增强：构建中/启动中/停止中端口徽章独立样式、分支卡片状态徽章提示、构建中蓝色脉冲动效 |
| feat | cds | 容器容量检查重构：停止按钮增加下拉三角选择要停止的分支（最早启动排前），显示标签图标+标签名；全部服务运行中的分支无需额外提醒，仅部分运行时显示警告 |
| feat | cds | 无默认分支时自动选中 main/master 作为默认分支 |
| feat | prd-desktop | 缺陷管理列表行补充缺陷编号和截图缩略图显示 |
| feat | prd-desktop | 缺陷列表视图改为单行紧凑布局（对齐 web 端），新增图片预览缩略图及全屏预览 |
| feat | prd-admin | 缺陷列表视图新增图片预览缩略图（状态列左侧），支持 hover 高亮和点击全屏预览 |
| fix | prd-admin | 缺陷列表头部漏光修复：改用 surface-inset 统一样式 |
| fix | prd-admin, prd-desktop | 缺陷管理默认视图改为列表模式，视图切换按钮列表优先 |
| feat | prd-desktop | 缺陷详情面板合并优化：双栏布局、截图画廊+lightbox、[IMG]标签解析、验收/关闭/删除操作、内嵌弹窗替代prompt()、角色标识 |
| feat | prd-desktop | 新增 Tauri 命令：verify_pass_defect、verify_fail_defect、close_defect、delete_defect |
| feat | prd-api | 周报创建接口新增 creationMode（manual/ai-draft），支持创建后自动调用大模型生成草稿并保持 Draft 状态；新增“我的 AI 数据源”接口（默认日常记录+MAP平台工作记录），并将 MAP 开关接入 AI 草稿上下文；新增“我的 AI 生成周报 Prompt”接口（获取/更新/恢复默认），生成链路改为“数据源 + 生效 Prompt + 模板要求”组合提交大模型；AI 自动生成结果补充模型标识字段（autoGeneratedModelId/autoGeneratedPlatformId/autoGeneratedBy）；语雀扩展源支持 spaceId/命名空间/URL 多格式匹配知识库；新增“我的日常记录自定义标签”接口（用户级）用于新增/修改/删除标签持久化；日常记录保存接口增加标签多值归一化（去空白、去重、保序） |
| feat | prd-admin | 周报创建卡片新增“手动填写/AI生成周报草稿”双入口，AI 模式直接回填生成内容并保留失败降级提示，编辑页文案升级为“AI重新生成草稿”并替换原生 confirm 为系统确认弹窗，详情页/详情弹窗评论输入框改为当前板块内就地展开；“我的数据源”改为先展示默认两项并支持 MAP 开关，个人扩展源移除 GitLab，扩展源弹窗增强选中态可读性并补齐语雀 spaceId 配置链路；设置页移除“数据统计/团队数据源”模块并新增“AI生成周报Prompt”模块（系统默认可查看、自定义可保存与恢复默认）；周报 AI 生成提示补充具体生成模型信息（规则兜底时显示“规则兜底”）；周报来源标签映射为配置对应中文名称；“设置”移除自定义打点标签入口，日常记录页保留系统默认分类并新增轻量自定义标签管理（新增/修改/删除），并打磨管理区微交互（更弱 hover、更紧凑编辑态、更轻输入反馈）；标签区新增“管理标签”分割线与独立操作区，固定“其它”末位展示，系统标签与自定义标签统一支持多选、再次点击取消，并在提交前校验至少选择一个标签 |
| fix | prd-api | 修复“AI生成周报草稿”静默失败导致空草稿伪成功：LLM失败/空响应/解析失败/零条目时不再写空模板；新增规则兜底生成（基于日常记录/MAP统计自动产出草稿）保障可用性；创建接口返回 `aiGenerationError` 明确暴露失败原因；增强 LLM 内容解析兼容（OpenAI/Claude 外层包裹、think 标签与文本字段变体）并补充采集统计日志用于定位；新增启动自动同步 AppCallerRegistry 到 `llm_app_callers`，确保新 appCallerCode 无需手动初始化即可在管理台可见 |
| fix | prd-admin | 修复日常记录标签显示与编辑不一致：避免未显式选择时误显示“其它”，新增与编辑统一为同一套多选标签规则并保持顺序一致；修复时间戳缺失导致左侧圆点/文本列宽不一致引发的列表错位，对时间列采用固定宽度占位对齐；周报编辑页新增空结果防御，并消费创建接口 `aiGenerationError` 精准提示失败原因 |
| chore | scripts | 优化 Cloud Agent 启动环境：预热 prd-admin pnpm 缓存、统一 pnpm 安装策略，并在启动阶段直接验证 `dotnet build prd-api` 与 `pnpm -C prd-admin tsc --noEmit` |
| feat | prd-desktop, prd-api | 增强"保存为技能"：支持多轮对话选择器，从用户教导+AI回复中提炼技能草案（含标题/描述/分类/图标自动建议） |
| feat | prd-api | 新增 SkillMdFormat 序列化器：Skill 模型与 SKILL.md 跨平台标准格式双向转换，prd-agent: 命名空间扩展兼容 Claude Code/Cursor/Copilot 等 14+ 平台 |
| feat | prd-api | 新增技能导出/导入 API：GET /api/prd-agent/skills/{key}/export 导出 SKILL.md、POST /api/prd-agent/skills/import 从 SKILL.md 创建技能 |
| feat | prd-api | generate-from-conversation 端点同步返回 skillMd 字段，AI 提炼后直接生成标准 SKILL.md 内容 |
| feat | prd-desktop | SaveAsSkillModal 新增两步流程：对话选择 → SKILL.md 预览，支持"保存为文件"和"保存到账户"双路径 |
| feat | prd-desktop | SkillManagerModal 新增导入/导出功能：导入 SKILL.md 文本创建技能、导出个人技能为 SKILL.md 文件 |
| feat | prd-desktop | 新增 Tauri 命令：export_skill、import_skill、save_skill_to_file（系统保存对话框） |
| refactor | prd-api | 合并提示词系统到技能系统：promptstages 数据启动时自动迁移到 skills 集合，ChatService 改用 ISkillService 解析 promptKey，客户端 /api/v1/prompts 端点改读 skills |
| fix | prd-admin | 修复 favicon 和左上角 Logo 引用不存在的文件导致破图，统一使用 favicon.jpg |
| fix | prd-admin | 侧边栏导航项图标与文字拉近，圆角矩形统一包裹图标+文字 |
| fix | prd-admin | 海鲜市场路由移入 AppShell 内部，保留侧边导航栏 |
| fix | prd-admin | 通知弹窗按钮(去处理/标记已处理/一键处理)添加 hover 和 active 反馈效果 |

### 2026-03-17

| 类型 | 模块 | 描述 |
|------|------|------|
| fix | prd-api | 修复 SSE 流占位消息跳过发送者信息解析导致机器人头像显示为默认头像 |
| fix | prd-desktop | 修复群列表右键菜单非群主也显示"解散该群"的问题，改为仅群主可见 |

### 2026-03-16

| 类型 | 模块 | 描述 |
|------|------|------|
| feat | prd-desktop | 移植缺陷管理列表页面从管理后台到桌面客户端 |

### 2026-03-15

| 类型 | 模块 | 描述 |
|------|------|------|
| feat | prd-desktop | 群组管理功能：解散群、退出群、添加成员、系统消息展示 |

### 2026-03-14

| 类型 | 模块 | 描述 |
|------|------|------|
| fix | prd-api | CDS 重启时仅终止 node/tsx 进程，避免误杀其他端口占用者 |
| fix | prd-api | 解决 CDS 重启端口冲突（EADDRINUSE） |

### 2026-03-13

| 类型 | 模块 | 描述 |
|------|------|------|
| docs | doc | 新增周报功能完整操作指南 |
| refactor | doc | 重命名 research.ai-report-systems → design.ai-report-systems |

### 2026-03-12

| 类型 | 模块 | 描述 |
|------|------|------|
| feat | prd-admin | 团队周报 UX 改进：设置页使用 GlassCard、分支卡片三区布局重设计 |
| fix | prd-admin | CDS 分支卡片移除多余标签，修复布局问题 |
| feat | prd-admin | 新增XX功能 |
| fix | prd-api | 修复XX问题 |
| `feat` | 新功能 |
| `fix` | 缺陷修复 |
| `refactor` | 重构（不改变外部行为） |
| `docs` | 文档变更 |
| `perf` | 性能优化 |
| `chore` | 构建/工具/依赖变更 |

## [1.7.0] - 2026-03-20

> 🚀 **用户更新项**
> - 新增群组管理功能（解散群、退出群、添加成员）
> - 修复机器人头像显示为默认头像的问题
> - 桌面端新增缺陷管理列表

### 2026-03-17
...（原有日条目保留）

---

## [未发布]
（新的未发布条目从这里开始）
```

版本标题下的 `用户更新项` 区块用于：
1. Tauri 自动更新弹窗的 `body` / `notes` 展示
2. GitHub Release Notes
3. 内部通知 / 群公告
