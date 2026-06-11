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
