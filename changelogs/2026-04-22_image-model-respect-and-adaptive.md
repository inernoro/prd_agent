| fix | prd-api | ModelResolver 在 expectedModel 命中候选池时优先尊重前端指定的模型，避免 DedicatedPool 静默换模型 |
| feat | prd-api | 新增「自适应模型」适配类型 SizeConstraintTypes.Adaptive + SizeParamFormats.None：尺寸由 prompt 决定，请求体不注入 size/n/quality/aspect_ratio |
| feat | prd-api | 注册 gpt-image-2-all（自适应）、gpt-image-1.5（标准 size 白名单）、nano-banana-2（aspectRatio 驼峰参数）三个新生图模型适配 |
| feat | prd-api | ImageGenRunWorker SSE runStart / imageDone 事件加上实际调度结果（modelId、modelGroupName、isAdaptive、resolutionType），前端可用此覆盖原本"前端选中的模型"展示 |
| feat | prd-admin | 视觉创作生图卡片显示后端实际使用的模型（来自 SSE），不再误显示前端 picker 选中的模型；自适应模型尺寸标签显示"自适应"而非"1K · 1:1" |
| feat | prd-admin | 模型适配信息（getVisualAgentAdapterInfo / getModelAdapterInfo*）返回 isAdaptive 字段，组合面板的尺寸 chip 在自适应模型下展示"自适应" |
