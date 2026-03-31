# 更新记录

> 记录 PRD Agent 全栈项目的所有变更。版本发布时自动插入版本标记行。
>
> **格式规范**：见底部 [维护规则](#维护规则)。

---

## [未发布]

### 2026-03-29

| 类型 | 模块 | 描述 |
|------|------|------|
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


### 2026-03-22

| 类型 | 模块 | 描述 |
|------|------|------|
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

---

## 维护规则

### ⚠ 禁止直接编辑此文件

日常开发请在 `changelogs/` 目录创建碎片文件（见 `CLAUDE.md` 规则 4），发版时执行 `bash scripts/assemble-changelog.sh` 自动合并。

### 碎片文件格式

文件名：`changelogs/YYYY-MM-DD_<短描述>.md`，内容为纯表格行：

```markdown
| feat | prd-admin | 新增XX功能 |
| fix | prd-api | 修复XX问题 |
```

### 类型定义

| 类型 | 含义 |
|------|------|
| `feat` | 新功能 |
| `fix` | 缺陷修复 |
| `refactor` | 重构（不改变外部行为） |
| `docs` | 文档变更 |
| `perf` | 性能优化 |
| `chore` | 构建/工具/依赖变更 |

### 模块名

`prd-api` · `prd-desktop` · `prd-admin` · `prd-video` · `doc` · `scripts` · `infra` · `cds` · `skills`

### 合并规则

- 同一天、同一类型、同一模块的多条变更合并为一条，用顿号分隔要点
- 例：`| feat | prd-desktop | 群组管理：解散群、退出群、添加成员 |`

### 版本发布标记

发布版本时，先执行 `bash scripts/assemble-changelog.sh`，再将 `[未发布]` 下的条目包裹进版本号标题：

```markdown
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
