| feat | llmgw | 新增面向调用方的逻辑模型目录与多上游 Offering 管理，支持优先级、权重、协议、端点、并发和速率配置 |
| feat | prd-api | 视觉创作按逻辑模型 PublicId 调用 Gateway，并在上游失败时按候选协议重建图片请求 |
| fix | prd-api | 修复 Offering 跨实例速率限制、健康回写、入口并发治理和自定义端点路径语义 |
| fix | prd-api | 修复 MAP 到 Serving 二次解析丢失逻辑模型并误退回旧池，跨进程保留图片协议重建契约 |
| fix | prd-api | 逻辑模型在 MAP 处于 inproc 迁移期时仍强制交给独立 Gateway 解析与发送，禁止同名旧模型池静默接管 |
| docs | llmgw | 将模型池教程重写为逻辑模型目录、多上游路由、故障切换与日志验收实战 |
