| fix | prd-api | 区分生图无图片与描述或参考图被模型拒绝，返回可操作的调整提示 |
| test | prd-api | 补充结构化 IMAGE_RECITATION 的正向归类与自由文本反向回归测试 |
| fix | prd-api | 在标准生图响应归一化边界保留请求拒绝语义，避免文学图生图回退为服务故障 |
| test | prd-api | 补充 canonical 生图边界的 IMAGE_RECITATION 贯穿回归测试 |
| fix | prd-api | 保留 canonical 请求拒绝错误在 MAP 生图消费者中的稳定语义，并补齐未知无图与服务故障反例 |
| fix | prd-api | 将首个失败图片的稳定错误码与脱敏文案汇总到 run 终态和 runDone 事件，避免轮询与 SSE 结论分裂 |
| test | prd-api | 增加真实 Mongo 与事件存储边界测试，锁定失败原因持久化及成功、取消清理旧错误行为 |
| fix | prd-api | 为生图请求拒绝返回可执行恢复动作，避免开放接口误导用户原样重试 |
