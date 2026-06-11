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
