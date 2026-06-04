| feat | prd-api | 开放接口 Phase 3：model 走 Key 模型白名单（客户可在白名单内自选，越界 400 model_not_allowed，第一个为默认，空=默认池）+ GET /api/v1/key 密钥自省 + 响应 id 与日志 requestId 同源 + X-RateLimit-* 头 + 输入大小上限(400 input_too_large) |
| feat | prd-admin | 开放接口 tab 绑定改为模型白名单编辑（chips 增删 + 首个为默认）；/v1/models 反映白名单 |
| docs | doc | 新增 guide.open-api 接入指南（quickstart + 契约 + 白名单语义 + 自省/限流/可观测性） |
