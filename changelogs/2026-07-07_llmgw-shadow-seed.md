| ops | prd-agent | 新增 LLM Gateway shadow 证据采样脚本，支持通过 MAP 真实文本、send 与图片 raw 入口产生 shadow 样本 |
| ops | prd-agent | LLM Gateway shadow 证据采样脚本支持按 baseline 轮询 send/stream/raw 增量，避免异步落库误报 |
| fix | prd-agent | 修复 commit 发布被 PRD_AGENT_*_IMAGE 环境覆盖导致实际镜像漂移的问题 |
| fix | prd-agent | LLM Gateway 发布 gate 将后台单张生图 raw 入口纳入全量与图片灰度证据要求 |
| docs | prd-agent | 在全量迁移计划中补充 shadow 证据不足时的采样方式和 raw gate 边界 |
