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
