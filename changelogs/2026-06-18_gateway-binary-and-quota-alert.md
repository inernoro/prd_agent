| fix | prd-api | LlmGateway 二进制响应改为「先无损读字节再判类型」+ 文件魔数嗅探(LooksBinary)：彻底修复图生视频成片下载被当文本损坏（mp4 标成 application/json 也能识别），不再依赖单一 ExpectBinaryResponse 标志 |
| feat | prd-api | 大模型额度用尽/限额及时提醒：网关识别 OpenRouter "Key limit exceeded"/402 等限额错误 → 专门错误码 LLM_QUOTA_EXCEEDED + 清晰中文提示 + 主动站内告警(去重)，避免额度不足时各功能静默失败、用户无从知晓 |
