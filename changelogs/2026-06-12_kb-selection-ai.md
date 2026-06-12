| feat | prd-admin | 知识库划词 AI 局部编辑：选中文字浮层从「添加评论」扩展为 评论 / AI 改写 / 配图 动作条；AI 改写支持润色/精简/扩写/书面化/纠错 + 自定义指令，流式生成 + diff 对比 + 替换原文（唯一定位校验，歧义禁替换）/ 插到原文后；配图内嵌视觉创作 mini 面板，按选区与文档上下文生成并插入选区段落之后 |
| feat | prd-api | 新增知识库划词改写 SSE 端点 POST /api/document-store/entries/{id}/selection-rewrite（服务端定位选区 + 截取上下文窗口喂 LLM）与动作清单端点 GET /api/document-store/selection-rewrite/actions（SelectionRewriteActionRegistry 为 SSOT），注册 AppCallerCode document-store.selection-rewrite::chat |
| test | prd-admin | 新增 selectionEdit 纯函数单测 16 例（选区定位/DOM 序号指认/歧义拒绝/替换/段落后插入/frontmatter 前缀拼接/图片 markdown 清洗） |
| fix | prd-admin | 划词改写选区定位改为 DOM 序号指认（Bugbot High）：同文多处出现时 useContentSelection 的 offset/contextBefore 恒指向第一处，旧逻辑会替换错位置；现从真实 DOM Range 数"选区前同文出现次数"指认第几处，序号与正文统计不一致即禁用替换 |
| fix | prd-admin | 划词改写浮层展示模型 thinking 流（Codex P2）：推理模型先吐思考时不再只有 spinner |
| fix | prd-admin | 分享阅读页「返回我的知识库」按钮常驻显示：旧逻辑仅登录态渲染，未登录标签页里入口整个消失（用户反馈"找不到回知识库"）；匿名点击走登录，文案如实标注 |
