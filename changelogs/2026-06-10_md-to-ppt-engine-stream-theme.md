| fix | prd-api | 修复 CDS Agent 会话事件按 payload 内容判重导致重复 delta token 被丢弃（Agent 引擎生成 PPT 全文乱码的根因），改为按 CDS seq 水位线去重并随轮询增量拉取 |
| feat | prd-admin | MD 转 PPT 生成/精修全程流式可视化：等待面板实时滚动展示 AI 正在输出的 HTML 与已接收字符数，不再静止转圈干等 |
| fix | prd-admin | 风格语义纠偏：删除前端 !important CSS 换皮覆盖层，风格是 AI 生成时参照的设计语言；生成后切换风格改为 AI 参照新风格整体重绘 |
| fix | prd-api | MD 转 PPT patch 接口支持 theme 字段，换风格重绘按对应风格系统提示词执行 |
| refactor | prd-api | MD 转 PPT 移除 MAP 直出引擎与模型列表接口，convert/patch 全部走 CDS Agent 会话；Agent 路径补发 model 事件（模型可见性） |
| refactor | prd-admin | MD 转 PPT 删除引擎/模型选择 UI（含 ModelChipPopover），模型名改为只读 chip 回显 |
| feat | prd-admin | 生成等待面板重设计：幻灯页进度卡逐张点亮（解析流式 HTML 的 section 与页标题）+ 总进度条 + 阶段文案 + 代码流尾巴，消除空等体感 |
| feat | prd-admin | 生成等待主视觉升级为实况渲染（对标 Gamma）：每页 HTML 流式闭合后立即在 iframe 真实渲染成幻灯页，默认跟随最新完成页，底部页卡可点击回看；首页出现前用骨架幻灯过渡 |
| feat | prd-api | 新增 /api/md-to-ppt/prewarm：大纲确认期间预创建并启动 CDS Agent 会话，convert 自动复用，把 5-15s 环境启动开销藏进用户阅读大纲的时间 |
| feat | prd-admin | 大纲生成成功后静默预热 Agent 会话（fire-and-forget，失败不打扰用户） |
| feat | prd-api | MD 转 PPT 透传推理模型 thinking 事件到 SSE（deepseek-v3.2 实测思考占总耗时 90%，思考期必须有内容可看） |
| feat | prd-admin | 等待面板新增 AI 思考过程实时流（思考期主视觉），状态行显示已思考字数 |
| feat | prd-admin | 百宝箱「MD 转网页 PPT」摘除 wip 标记（预览环境真人路径验收通过：8 页 deck 生成/渲染/翻页全链路跑通） |
| fix | claude-sdk-sidecar | 修复假流式根因：官方 SDK 路径开启 include_partial_messages，token 级 text_delta/thinking_delta 实时产出（此前正文等整条消息生成完一次性爆发），完整消息块去重防正文双倍 |
| feat | prd-admin | MD 转 PPT 历史生成：右上「历史」入口列出过往 runs，点击载入旧 deck 继续精修/编辑/换模板/发布 |
| feat | prd-api | MD 转 PPT 自定义模板：上传参考图由视觉模型提取风格规范（配色/字体/版式），生成与重绘时作为 AI 设计参照；模板 CRUD 接口 + md_to_ppt_templates 集合 |
| feat | prd-admin | 右侧空状态改为模板画廊：官方 5 套大卡片迷你预览 + 自定义模板卡片 + 上传参考图新建，模板不再藏在设置里；工具栏色点扩展自定义模板，「风格」统一更名「模板」 |
| feat | prd-admin | 知识库引用升级大模态：库列表 → 文档列表 → 内容预览 → 确认引用，不再盲选 |
| feat | prd-admin | 思考流移入对话气泡（对话归对话，中间只放 PPT 预览）；输入框聚焦整圈高亮（边框+光环）；左侧对话栏宽度可拖拽（280-640px，localStorage 记忆） |
| fix | prd-admin | 输入框聚焦内圈浏览器默认 outline 残留清除（只留外壳整圈高亮）；知识库预览复用全站 MarkdownContent 渲染（不再裸文本） |
| fix | prd-admin | 调整大纲不再按文本长度重估页数（沿用上一版页数，除非用户明确要求增减）；生成等待的「Agent 环境准备」移入对话气泡，预览区只留产物 |
| fix | prd-admin | 编辑模式可编辑范围扩展 .stat/.stat-l/.lead/.eyebrow/.chip/.quote（大数字等 div 文本块此前点不中） |
| feat | prd-admin | 大纲右侧编辑器：大纲生成后在右侧大空间逐页编辑（标题/要点/增删页/上下移），即改即存且刷新恢复（outline-ready 状态持久化）；头部常驻「确认生成」，底部「让 AI 调整」输入 |
| feat | prd-api | 大纲接口扩展澄清问卷：需求确有歧义时模型返回最多 3 题（单选/多选/填空），无歧义不出题 |
| feat | prd-admin | 澄清问卷卡（opendesign 式）：右侧填写 → 保存并发送给 AI 重排大纲，可跳过；对话输入在大纲阶段直接路由为 AI 调整大纲 |
| feat | prd-admin | 大纲编辑器页卡改网格布局（一排 3-4 个自适应列宽，「添加一页」为网格末位虚线卡） |
| feat | skills | 验收标准 v2.5 两条硬门禁：报告必含「验收地址」段（标的物深链+分支+commit，与报告同域名）；证据必须步骤式（>=3 个「## 步骤 N」逐段配图，集中 EVIDENCE 在证据板渲染为空）——archive_report.py 机检同步 |
| fix | prd-api | 澄清问卷出题阈值微调：未指明受众/正式程度且显著影响内容时应出 1-2 题（需求明确时仍禁止出题） |
| feat | prd-admin | 大纲规划等待改产物形状动画（3:4 骨架卡逐张脉冲浮现，替代居中转圈）；页卡改 3:4 竖卡比例 |
| feat | prd-admin | 大纲卡拖拽换位（替代上下按钮），换位区间序号 1.6s 紫色渐变高亮——变化必须被看见 |
| fix | prd-admin | AI 调整大纲时编辑器保持在场（内联蒙层+状态条），不再切全屏规划态造成"大纲全消失"错觉；调整返回后仅改动页渐变高亮 |
| fix | prd-api | 调整任务硬约束：未被调整要求点名的页 title/bullets 逐字原样保留（修"定向修改结果全文案被重写"） |
| feat | rules | 新增 miduo-review-lens.md：用户审查习惯六镜头（等待产物感/比例美感/交互成本/变化可感知/AI最小惊讶/证据闭环），交付前强制自查 |
| feat | prd-api | 并行逐页生成编排（用户架构提案落地）：大纲定稿 → deck 壳子确定（设计系统 head）→ 4 路子智能体并行各画一页 → 每页完成即推 page 事件 → 服务端拼装；frame/page 新 SSE 事件 |
| feat | prd-api | 逐页提示词反「套模板」：组件类降级为可选工具箱，每页给版式自由 + 相邻页差异化指令 + 版式轮换建议 |
| feat | prd-admin | 等待面板 pages 模式：页卡按真实完成并行点亮（可点已亮页卡先看该页实况渲染），进度 X/Y 页为服务端真实进度——不再依赖 token 流，绕开 sidecar 假流式 |
| fix | prd-admin | 刷新恢复对账：run 完成/失败时翻转聊天里残留的「正在生成」气泡（修"图片返回了还显示生成中"）；等待计时改用服务端 run.createdAt 基准（修刷新后计时归零） |
| fix | prd-api | 大纲提示词加厚：每页 3-5 条要点、每条 12-30 字带具体落点，禁止空壳短语（修"大纲内容太少"） |
| feat | prd-api | 官方模板扩容至 10 套：新增极光渐变 / 日落炽橙 / 森林有机 / 鎏金深紫 / 海洋玻璃（参照 Gamma 系风格族谱），每套含完整设计 token 与气质描述 |
| feat | prd-admin | 模板画廊卡升级：真渐变/格纸纹理迷你幻灯预览 + 主题字体示例标题 + 角标数据 + 一句话气质描述（替代原始的"Aa 标题示意"色块条） |
| refactor | prd-admin | 删除头部「设置」收起面板（模板 chips 与画廊重复）：生成前选模板唯一入口为右侧画廊，生成后切换走预览工具栏色点 |
| docs | doc | plan.md-to-ppt-next-wave 新增 §9 用户模板共享走海鲜市场（IForkable + CONFIG_TYPE_REGISTRY 方案）与 §10 官方模板扩容节奏清单 |
| fix | prd-api | P0 修复并行逐页生成的页面黑屏：section 根元素 inline display/min-height:100vh 覆盖 reveal 隐藏规则导致当前页被推出视口；新增 SanitizeSection 消毒（布局样式挪入 pp-root 包裹层、尺寸定位属性剥离、vh 单位替换）+ 5 条回归测试 |
| feat | prd-api | deck 壳子注入溢出自适应守卫脚本：内容高于 700px 设计框时对 pp-root 等比缩小（兜底） |
| fix | prd-api | 逐页提示词版面硬约束：禁止 vh/vw、根元素禁止 style、内容预算（要点不超过 5 条）、横向时间线最多 4 项且每项 min-width 170px（修文字逐字竖排挤压） |
| feat | prd-api | 新增 GET /api/md-to-ppt/profiles + convert/patch/prewarm 支持 runtimeProfileId：用户在 PPT 页随时切换生成模型（与基础设施运行配置同数据源）；预热会话与所选模型不匹配时弃用重建 |
| feat | prd-admin | 输入框旁新增模型 chip + 切换弹层：任何时候可换模型，选择持久化并随生成/精修/预热下发 |
| feat | prd-admin | 生成期底部页卡升级为真实缩略图（完成页用同一设计系统迷你渲染，一眼看到每页效果），未完成页骨架占位 |
| feat | prd-admin | 并行生成全程对话同步：壳子确定/每页完成/最终汇总都更新聊天气泡（左侧保持主力语言交互，不再静默） |
| feat | prd-admin | 预览工具栏新增「重绘本页」：定向只重绘当前页（修复溢出/挤压排版），内容逐字保留其余页不动 |
| feat | prd-admin | 生成后切换模板改为先确认再重绘（确认条说明耗时与影响），杜绝误触模板色点白白触发 1 分钟整体重绘 |
| fix | prd-admin | 模型切换弹层补点击外部关闭（fixed 背板），不再只能点 chip 收起 |
| feat | prd-api | 定向单页 patch：SlideIndex 命中时只把目标页交给单个子智能体重画并原位替换（页级提示词+消毒+心跳），不再整篇 58KB 重出（旧路径实测 7 分钟未完成）；失败回落整篇路径 |
| fix | prd-api | 标签碎片守卫：上游偶发丢字符（deepseek/OpenRouter 实测 finalText 缺 26 个 "<"）导致标签当正文渲染——ExtractSection 检测损坏自动走重试/兜底链路 + 3 条回归测试 |
| fix | prd-admin | 输入框底部工具行视觉修整：快捷键提示挪进 placeholder/按钮 title（原被模型 chip 挤成两行折叠）；模型 chip 只显示短名（vendor 前缀去掉，全名在 tooltip） |
| feat | prd-api | 官方模板 +2 套（借鉴 open-design.ai 招牌设计系统）：工坊拼贴 Atelier Zero（暖纸/珊瑚单热点/Inter 800 混 Playfair Italic/罗马数字章节/mono 微注）与 Kami 纸墨（羊皮纸/墨蓝 ≤5%/衬线单字重 500 禁粗禁斜/四级暖灰/实色 tag） |
| feat | prd-admin | 模板画廊新增工坊拼贴 / Kami 纸墨两张卡（官方共 12 套），迷你预览含纸面径向晕影与衬线示例标题 |
| feat | prd-admin | 基础设施服务页模型运行配置补全 CRUD 接线：卡片新增 编辑/设为默认/测试连通/两击确认删除（后端 PUT/DELETE/test 早已就绪，此前 UI 只读改不了）；表单区分新增/修改模式（编辑留空 key 沿用原 key）；新增「从模型管理导入」一键建配置 |
| feat | prd-admin | /infra-services 支持 ?tab=config 深链直达配置 tab；失效连接默认折叠（12 条尸体卡不再占满首屏）；PPT 模型弹层只有一条配置时给出去基础设施新增的引导链 |
| fix | prd-admin | 基础设施操作台整段上移到页面第二屏（原埋在测试台/架构介绍下第四屏，用户两次找不到模型配置）；「配置」tab 排第一并设为默认——进页即见模型运行配置 |
| feat | prd-api | 模型池直选（用户提案落地）：GET /api/md-to-ppt/pool-models 列出启用池模型 + POST profiles/from-pool 一键物化为运行配置（幂等复用平台 baseUrl/key，零手填）；无池调度概念——选中哪个就把哪个的配置原样传给 CDS，由 CDS 自行发请求 |
| feat | prd-admin | PPT 模型弹层新增「从模型池直选」组：搜索模型/平台、点选即自动建配置并选中、已物化标「已就绪」；不再要求用户去基础设施页手抄 baseUrl/key |
| feat | prd-api | InfraAgentRuntimeProfileService 新增 ImportFromPoolAsync：任选池内模型物化为运行配置（协议/runtime 自动推断、key 加密存储、不抢默认位） |
| feat | prd-api | 流式逐页大纲 POST /api/md-to-ppt/outline-stream：模型按 JSONL 输出（首行 meta 含整体配色/排字/气质，随后每页一行含 design 设计意图），服务端逐行解析每成功一页立刻推 SSE——第一页几秒内可见；兜底整 JSON 解析 |
| feat | prd-api | 页级 design 字段贯通：大纲设计意图（版式/视觉装置/排字/强调）随 OutlinePages 直接喂给并行子智能体的页级提示词（设计闭环非摆设） |
| feat | prd-admin | 大纲编辑器流式化：meta 到达即出编辑器骨架（脉冲占位卡），每页到达填充真卡并渐变高亮；卡片新增可编辑设计意图行；流式中确认禁用、序列化大纲带设计行 |
| feat | cds | Agent 请求观测台（用户信任诉求落地）：新页 /agent-requests/:projectId——一条条请求实时列表（title/clientApp/clientUser/model/状态/耗时/事件数 + 收发内容预览）、按用户/应用/状态/关键字筛选、行展开看完整事件流；项目卡心电图按钮直达 |
| feat | cds | 会话打标 + 聚合端点：POST agent-sessions 接受 title/clientUser/clientApp；GET /projects/:id/agent-requests 合并 live 会话与持久历史（state 持久 ring buffer 500 条，重启后历史可查）；结构性事件发布 agent-session.activity 到全局 SSE 总线（text_delta 不发防洪水）+ 5 条路由测试 |
| feat | prd-api | MAP 创建 CDS 会话补传观测台标签：title/clientUser(userId)/clientApp；CreateInfraAgentSessionRequest 加 ClientApp，MdToPpt 全部会话标记 md-to-ppt |
| fix | prd-api | CDS 会话失联秒级对账：CDS 自更新/重启清空内存会话后，MAP 轮询撞 session_not_found 立即标记会话 failed + 落 error 事件（此前空转 4 分钟才超时）——页级重试随即重建新会话（两次真实事故根因：并行 agent 频繁 self-update 生产 CDS） |
| feat | prd-admin | 锚定 deck 前端适配：实况/缩略图改为完整单页 deck（prefix+active slide+suffix，模板自带运行时缩放居中）；iframe 控制协议双模式（reveal + zhangzara 方向键/active 类，MutationObserver 报页码）；编辑器序列化兼容无 reveal 结构 |
| fix | prd-admin | SSE 断线不再误报"生成失败"：error 前先对账 run 真实状态，活着转后台跟踪轮询到终态（修用户截图实锤的 network error 误报） |
| fix | prd-admin | 锚定 deck 页码桥 v2：active/is-active/current 类 + 视口中心 elementFromPoint 反查 + 800ms 兜底轮询（monochrome 等不打类标的运行时页码也跟手） |
| feat | prd-admin | 输入框大气化（用户点名）：composer 加高加圆角、聚焦上浮+饱满光环；页卡缩略图 hover 浮起投影（交互灵动） |
| fix | prd-admin | looksLikeDeck 识别锚定 deck（div.slide）：retro-zine 等 div 容器模板生成完被误判"结果异常"丢弃的问题 |
| fix | prd-api | 单页故障绝不杀整本：RunAgentOnceAsync 永不抛（传输异常折叠为页错误走重试/兜底）+ 并行任务体全链路兜底页（实测单页 HttpClient 100s 超时异常逃逸炸掉整个 deck） |
| fix | prd-admin | PPT 工作台修复加号菜单「引用知识库/添加文件」点不动：composer 卡 focus-within transform 创建 stacking context 导致 z-10 菜单被 z-5 关闭蒙层盖住，移除 translate 保留光环动效 |
| feat | prd-api | PPT 锚定模板新增 2 套暗色 deck（cyber-terminal/dark-graph，来自 open-design hermes/graphify）：Tech 极黑、极光渐变不再映射到浅色锚，提取器 v3 支持非 zhangzara 目录、is-active 修饰符、注释取版式名并为无运行时静态 deck 附加通用键盘导航 |
| fix | prd-api | 暗色锚定 deck 翻页失效修复：提取时剥掉模板自带 Static-preview fallback 样式块（强制所有 slide 可见），导航运行时类切换即可真实翻页 |
| fix | prd-api | 模型池直选凭据预检：pool-models 返回 available/unavailableReason，平台 key 缺失或解密失败的模型提前标记；from-pool 报错区分「未配 key」与「key 解密失败（环境加密密钥不匹配）」并给出修复指引 |
| fix | prd-admin | 模型池弹层把凭据预检不过的模型置灰显示原因，不再让用户点了才撞「缺少 API key」报错 |
| fix | cds | Jwt__Secret 注入改为项目环境变量优先、CDS 全局值仅兜底：根治换 CDS_JWT_SECRET 跨项目穿透打哑其他项目存量密文的联动事故 |
| feat | prd-api | 新增 PlatformKeyIntegrityWorker：启动及每 6 小时自检平台 API key 可解密性，发现环境密钥不匹配立即 LogError + 全局站内告警（幂等，恢复后自动关闭），杜绝密钥哑掉两小时无人知的静默故障 |
| chore | - | 删除过期验收驱动 e2e/lifecycle.mjs（写死旧分支 URL 的一次性脚本）；新增 .claude/rules/cross-project-isolation.md 跨项目隔离原则与共享通道清单 |
| chore | - | 合并 main（218 个提交）进开发分支：container.ts 环境构建采用 main 的 resolveProfileRuntimeEnv 重构并移植 Jwt 项目级优先修复，remote-hosts.ts 合并双方 import；CDS 1932 测试、API 943 测试、admin 419 测试全绿 |
| feat | prd-api | 平台密钥自愈端点 POST /api/mds/platforms/:id/restore-key-from-profile：密钥环境不匹配时从仍可解密的运行配置（DataProtection）服务端恢复平台 key 并用当前密钥重加密，明文不出进程、同 host 守卫防错配 |
| fix | prd-admin | 重绘单页不再冒充全部重绘：单页 patch 保持整份 deck 可见，仅顶部状态条提示「仅重绘第 N 页」，不再铺满 8 张等待骨架（后端本就只 splice 替换目标 section，是前端骨架误导） |
| fix | prd-admin | 大纲卡片由 3:4 竖比例改 1:1，减约 1/4 高度，消除内容只占一半的空白 |
| fix | prd-admin | 页码指示器改为视口可见度优先判定（cur），修复锚定 deck 末页仍显示 1/N 的问题（诉求 6） |
| fix | prd-admin | 编辑模式下锚定 deck 所有页平铺可滚动可编辑，不再只能编辑第一页（诉求 8） |
| feat | prd-admin | 全屏改为自定义演示模式，底部新增子页缩略条（点击跳页 + 方向键 + Esc 退出），不再只有单张全屏 PPT（诉求 9） |
| fix | prd-api | 锚定页提示词新增硬约束：内容不得压到页脚、视觉装置（图表/SVG/大数字）不得留空占位（诉求 4/7） |
| fix | prd-api | 兜底页不再裸奔：子智能体两次输出无效时，降级页继承版式范本的装饰块（网格/扫描线/背景 SVG）与页脚，仍穿设计系统的衣服 |
| polish | prd-admin | 演示模式缩略条加渲染微光占位，iframe 逐张渐进渲染期间不再是黑块 |
| fix | prd-admin | 刷新中断对账：大纲规划（客户端 SSE 无服务端 run）被刷新打断后，气泡不再永远停在「正在规划大纲」，挂载时翻转为可重试的中断提示 |
| fix | prd-api | dark-graph 锚定模板范本去 emoji（PR #799 Codex P1）：图标位 pictograph 全部替换为终端风等宽字符标记，全锚定资产 emoji 清零 |
| fix | - | AGENTS.md 修正 cdscli 路径（.Codex/skills 不存在，实际在 .claude/skills，Bugbot Medium）；cdscli 去重 _repo_name_from_git_ref 双定义并让 _fallback_project_slug 与 _project_slug_hints 共用同一优先序（Bugbot Medium/Low），pytest 125 绿 |
| security | cds | 只读 SQL Console 危险关键字检查扩到全部放行语句头：堵 PostgreSQL EXPLAIN ANALYZE UPDATE 绕过写权限门（PR #799 Codex P1，main 既有） |
| feat | prd-api,prd-admin | 大纲生成纳入服务器权威性（server-authority.md）：大纲也是一次 Run（op=outline），结果落库 OutlineJson，客户端刷新/断开后后台跑完仍可按 runId 取回，不再「刷新即丢」「永远转圈」 |
| fix | - | 验收技能 L0 档步骤式证据门禁按档位缩放（Bugbot Medium）：L0 轻量验收不再被「>=3 步骤」硬卡，下限=min(档位截图下限,3) |
