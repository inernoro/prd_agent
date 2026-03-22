# 更新记录

> 记录 PRD Agent 全栈项目的所有变更。版本发布时自动插入版本标记行。
>
> **格式规范**：见底部 [维护规则](#维护规则)。

---

## [未发布]

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
