| feat | prd-api | ModelExchange 新增 Models:List<ExchangeModel> 字段，中继升级为"虚拟平台"：一条 Exchange = N 个模型 |
| feat | prd-api | PlatformsController GET /api/mds/platforms 返回合并列表（真实平台 + 虚拟中继平台, kind:"real"\|"exchange"） |
| feat | prd-api | PlatformsController GET /{id}/available-models 同时支持 Exchange.Id 查询，返回其 Models 列表 |
| feat | prd-api | ModelResolver 新增按 Exchange.Id 查找分支，同时保留"__exchange__" 旧路径，向后兼容 |
| feat | prd-api | ExchangeController 新增 POST /exchanges/{id}/models/{modelId}/try-it 一键体验端点 |
| feat | prd-api | ExchangeController /for-pool 返回真实 Exchange.Id 作为 platformId，不再是硬编码 __exchange__ |
| feat | prd-api | gemini-native 模板预置 5 个结构化模型（chat + generation 混合） |
| feat | prd-admin | 中继管理页重构：表单新增"模型列表"区域（ModelId / 显示名 / 类型 / 启用），取代扁平的别名文本框 |
| feat | prd-admin | 中继卡片展示模型表格，每行一个"一键体验"按钮（调用 try-it 端点）|
| feat | prd-admin | Platform 类型新增 kind/isVirtual 字段；ModelPoolManagePage 不再硬编码合成 "__exchange__" 虚拟平台 |
| fix | prd-admin | PlatformAvailableModelsDialog 通过 platform.kind 识别虚拟中继，不再依赖 "__exchange__" 魔术字符串 |
