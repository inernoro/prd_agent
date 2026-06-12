| feat | prd-admin | 知识库划词 AI 局部编辑：选中文字浮层从「添加评论」扩展为 评论 / AI 改写 / 配图 动作条；AI 改写支持润色/精简/扩写/书面化/纠错 + 自定义指令，流式生成 + diff 对比 + 替换原文（唯一定位校验，歧义禁替换）/ 插到原文后；配图内嵌视觉创作 mini 面板，按选区与文档上下文生成并插入选区段落之后 |
| feat | prd-api | 新增知识库划词改写 SSE 端点 POST /api/document-store/entries/{id}/selection-rewrite（服务端定位选区 + 截取上下文窗口喂 LLM）与动作清单端点 GET /api/document-store/selection-rewrite/actions（SelectionRewriteActionRegistry 为 SSOT），注册 AppCallerCode document-store.selection-rewrite::chat |
| test | prd-admin | 新增 selectionEdit 纯函数单测 14 例（选区定位分级回退/歧义拒绝/替换/段落后插入/frontmatter 前缀拼接/图片 markdown 清洗） |
