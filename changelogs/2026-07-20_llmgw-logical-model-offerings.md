| feat | llmgw | 新增面向调用方的逻辑模型目录与多上游 Offering 管理，支持优先级、权重、协议、端点、并发和速率配置 |
| feat | prd-api | 视觉创作按逻辑模型 PublicId 调用 Gateway，并在上游失败时按候选协议重建图片请求 |
| fix | prd-api | 修复 Offering 跨实例速率限制、健康回写、入口并发治理和自定义端点路径语义 |
| fix | prd-api | 修复 MAP 到 Serving 二次解析丢失逻辑模型并误退回旧池，跨进程保留图片协议重建契约 |
| fix | prd-api | 逻辑模型在 MAP 处于 inproc 迁移期时仍强制交给独立 Gateway 解析与发送，禁止同名旧模型池静默接管 |
| fix | prd-api | 视觉创作任务独立保存逻辑模型公开 ID，禁止上游模型名覆盖用户选择并被同名旧模型池重新接管 |
| fix | prd-api | 生图后台任务通过显式必需逻辑模型契约进入独立 Gateway，不再依赖后台目录反推并硬拒绝旧池回退 |
| fix | prd-admin | 视觉创作生成记录以稳定逻辑模型为主展示，上游模型仅保留在 Gateway 审计日志中 |
| docs | llmgw | 将模型池教程重写为逻辑模型目录、多上游路由、故障切换与日志验收实战 |
| fix | prd-api | 显式逻辑模型在生图 Worker 中跳过 MAP 模型池预解析，保留公开 ID 并由独立 Gateway 单次解析上游 |
| fix | prd-api | 显式逻辑模型的解析与发送强制共用独立 Gateway HTTP 边界，不再受 MAP 全局 inproc 模式影响 |
| fix | prd-api | 预览环境 Run 队列作用域加入 commit revision fencing，阻止同分支残留旧 Worker 抢走新架构任务 |
| ops | prd-api | 生图 Run 管理员查询返回部署作用域，支持精确审计任务由哪个项目、分支和 revision 入队 |
| fix | prd-api | 生图客户端以 logical-model 平台标记恢复稳定模型身份并强制独立 Gateway，阻断参数缺失时退回同名旧模型池 |
| fix | prd-api | 将逻辑模型公开 ID 随 Run 上下文贯穿执行链，并在 Shadow 网关四条发送路径硬隔离旧模型池 |
| refactor | prd-api | 视觉创作所有生图请求统一跨进程进入独立 Gateway，默认池和故障兜底不再由 MAP 进程内发送 |
