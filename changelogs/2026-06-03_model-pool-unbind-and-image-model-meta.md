| fix | prd-api | 模型分组删除受阻时新增 usage/unbind 端点，支持查询占用应用并一键解绑 |
| fix | prd-admin | 模型池删除被应用占用时改为弹窗列出占用应用并支持一键解绑/解绑全部并删除 |
| fix | prd-admin | 模型池详情面板每个模型新增「从池中移除」按钮，修复无法删除单个模型的问题 |
| feat | prd-admin | 生图模型选择下拉框重设计：每个模型加副标题/描述、推荐徽标（当前推荐 gpt-image-2-all），文案前端临时内置、预留后端下发 |
| fix | prd-admin | 视觉创作结果尺寸徽标改读后端真实出图尺寸（effectiveSize），修复"请求 1:1 但实际 16:9 仍显示 1K·1:1" |
| fix | prd-admin | 视觉创作模型徽标统一显示模型池名（与"用户期望"/选择器一致），实际 modelId 不同时以淡色后缀+ tooltip 露出，便于核对"选 A 给 B" |
| fix | prd-admin | 视觉创作画布标题/引用名走 cleanDisplayTitle 清洗，修复标题自我拼接、引用图标泄漏；并在引用 label 注入处断掉逐代递归 |
| fix | prd-api | image_gen 持久化的 [GEN_DONE] 消息补充 actualModel/effectiveSize/isAdaptive 字段，使尺寸与模型展示刷新后不丢失 |
