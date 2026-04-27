| feat | prd-admin | 应用模型池管理新增「+ 配置模型」一键流（流程 A）— 用户在功能行点该按钮 → picker 选模型 → 系统自动建池（auto 命名/默认 FailFast 策略/优先级 50）+ 自动绑定到该 AppCaller。前端编排既有 createModelGroup + updateAppCaller 两个 API，绑定失败时自动 deleteModelGroup 回滚孤儿池。零后端改动、零数据库改动、零既有数据/日志/调度影响 |
| feat | prd-admin | LegacySingle 行新增「升级为模型池」按钮（流程 B）— 把当前直连的单模型预选进 picker，用户可继续添加备用模型，确认后自动建池+绑定到 AppCaller。原有 LegacySingle 的 LLMConfig 不动（保留作实验直连通道），但本 AppCaller 的调度优先级会因新池的存在而走专属池路径 |
| refactor | prd-admin | 应用模型池管理「绑定模型池」按钮文案调整 — 未配置时改为「选择已有池」（次操作，主操作让位给「+ 配置模型」），降低新用户认知负担 |
