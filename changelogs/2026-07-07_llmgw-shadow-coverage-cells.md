| fix | llmgw | 修正 shadow coverage 报告为显式 appCaller/kind 单元，避免不适用组合误报 |
| ops | llmgw | shadow 累计器支持传递显式 kind 与 appCaller:kind 发布证据门 |
| security | llmgw | shadow 累计器日志脱敏 seed flags 中的口令、token 与视频 URL 参数 |
| ops | llmgw | 新增 shadow 累计器只读监控脚本，检测采样比例未恢复的高风险状态 |
| ops | llmgw | 收紧全量 http 发布默认 app-kind gate，覆盖 OpenAI-compatible API 与核心 send/stream 入口 |
| ops | llmgw | shadow seed 增加 OpenAI-compatible chat/image 真实入口，并修正 OpenPlatform 代理证据采样 |
| fix | prd-api | 修复流式调用方在 done 后提前结束枚举时漏写 LLM Gateway shadow comparison 的问题 |
| ops | llmgw | 将 OpenPlatform 发布门样本类型对齐为真实流式调用链，避免要求不存在的 send 格子 |
