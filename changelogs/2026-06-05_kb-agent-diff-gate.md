| feat | prd-admin | 知识库「AI 文档对话」写回前新增 diff 预览确认闸：replace/append 显示逐行红删绿增、new 可改标题，确认后才落库，让用户感知改动 |
| feat | prd-admin | 知识库「AI 文档对话」面板顶部展示当前调用的「模型 · 平台」（从流式 onStart 透出，不硬编码），提升 AI 调用可观测性 |
| feat | prd-api | AgentUniverse 流式新增 model 事件：内置智能体（文学/PRD/缺陷）适配器透出 gateway 真实解析到的模型·平台，对齐 ai-model-visibility 规则 |
| feat | prd-api | 知识库新增目录列表接口 GET stores/{id}/folders；apply-content 的 new 模式支持 parentId 落到指定目录（校验同库文件夹） |
| feat | prd-admin | 知识库「AI 文档对话」另存为新文档可选择落点目录（目录选择器，按层级缩进），让智能体产出能填充到指定目录 |
