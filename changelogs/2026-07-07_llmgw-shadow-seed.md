| ops | prd-agent | 新增 LLM Gateway shadow 证据采样脚本，支持通过 MAP 真实文本、send 与图片 raw 入口产生 shadow 样本 |
| ops | prd-agent | LLM Gateway shadow 证据采样脚本支持按 baseline 轮询 send/stream/raw 增量，避免异步落库误报 |
| fix | prd-agent | 修复 commit 发布被 PRD_AGENT_*_IMAGE 环境覆盖导致实际镜像漂移的问题 |
| fix | prd-agent | LLM Gateway 发布 gate 将后台单张生图 raw 入口纳入全量与图片灰度证据要求 |
| ops | prd-agent | LLM Gateway shadow 采样脚本新增 ImageGenRunWorker 文生图路径，补齐后台生图 raw 证据入口 |
| ops | prd-agent | LLM Gateway shadow 采样脚本新增 ImageGenRunWorker 图生图与多图 vision 路径，支持用既有图片资产 SHA 取证 |
| ops | prd-agent | LLM Gateway shadow 采样脚本新增视频提交、转写 ASR 与文档字幕 ASR 真实业务入口取证 |
| ops | prd-agent | LLM Gateway shadow 采样脚本支持失败后继续执行并输出 JSON 证据，便于生产 gate 归档 |
| ops | prd-agent | LLM Gateway 生产阶段脚本支持显式运行 MAP shadow seed 并归档证据 |
| ops | prd-agent | LLM Gateway 发布阶段新增 video/ASR upstream readiness 解析门，防止缺池缺 key 进入灰度或全量 |
| ops | prd-agent | LLM Gateway canary-video-asr 与 http-full 阶段在部署前执行 upstream readiness，避免上游配置不可用时先发镜像 |
| ops | prd-agent | LLM Gateway video-asr 发布门覆盖视频转文档与视频转文字 ASR 入口，并新增生产 ASR 模型池引导脚本 |
| fix | prd-agent | 修正 upstream readiness 对 /gw/v1/resolve 脱敏响应的误判，密钥解密改由 ServingKeyIntegrity 和 raw seed 证明 |
| ops | prd-agent | 记录生产 ASR raw seed 返回 Invalid X-Api-Key 的阻断证据，禁止 video-asr 灰度误放行 |
| ops | prd-agent | LLM Gateway shadow-start 高采样失败时输出恢复采样告警 |
| ops | prd-agent | 新增 LLM Gateway shadow 安全恢复脚本，并在高采样 shadow-start 失败时自动恢复低采样 |
| ops | prd-agent | LLM Gateway shadow 安全恢复脚本默认持久化低采样环境配置，避免后续 compose 重启恢复高采样 |
| docs | prd-agent | 在全量迁移计划中补充 shadow 证据不足时的采样方式和 raw gate 边界 |
