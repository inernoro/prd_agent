| ops | scripts | 修复 LLM Gateway 生产 shadow seed 中 video-to-doc 与 workflow video-to-text ASR 入口未使用带权限 seed 用户导致 403 的问题 |
| fix | prd-api | 修复 workflow video-to-text ASR 后台执行未继承强制 shadow 采样上下文的问题 |
| ops | scripts | 增强 LLM Gateway shadow coverage 报告失败样本字段，直接展示模型、模型池、平台类型、fallback 与上游错误 |
| ops | scripts | 增强 LLM Gateway 视频 canary，支持多模型探测并识别视频供应商余额不可用为发布阻断项 |
| ops | scripts | LLM Gateway shadow coverage 支持跳过全局聚合单元，用于视频暂缓时执行非视频 scoped gate |
| ops | scripts | 为 LLM Gateway MAP shadow seed 增加视频提交预算闸门，默认阻止高成本视频批量取证 |
| docs | doc | 记录 LLM Gateway 生产视频 shadow 取证成本风险债务与后续约束 |
| ops | scripts | 拆分 LLM Gateway `canary-asr` 生产灰度阶段，允许 ASR/字幕独立于视频生成推进 |
