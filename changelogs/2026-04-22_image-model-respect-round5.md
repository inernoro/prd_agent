| fix | prd-api | FindPreferredModel 撤回 Tier4 归一化匹配（命名由系统自动填充不会漂移，无需兜底）；Tier3 恢复严格健康守门，池内全部 Unavailable 时返回 null，让前端做明确的用户引导 |
| feat | prd-admin | 视觉创作新增"智能切换"偏好（默认开启，sessionStorage 持久化）：picker 里选的模型被判为不可用时前端弹窗三选一（切换到可用模型/仍使用原模型/取消），禁止后端静默换模型；关闭开关进入严格模式，直接按用户选择发送不弹窗 |
| feat | prd-admin | 用户消息气泡下方新增「用户期望：xxx」紫色徽标，来自 @model token，让用户发送后直观看到自己期望使用的模型 |
