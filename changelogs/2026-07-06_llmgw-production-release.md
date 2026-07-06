| ops | prd-agent | 生产发布脚本的不可变 commit 发布同步钉住 llmgw、llmgw-serve、llmgw-web 三个网关镜像，避免 API 已切 sha 但网关仍漂在 latest |
| ops | prd-agent | 发布 manifest 补充网关三镜像 ref，便于正式环境部署前后核对 |
| ci | prd-agent | branch-image 手动触发改为全组件构建，确保正式环境热修前能补齐同一 sha 的 API/Admin/GW 镜像组 |
| test | prd-api | 修正跨进程 LLM Gateway pools 错 key 用例断言，确保 401 鉴权失败按 fail-closed 契约暴露而不是伪装成空模型池 |
| test | prd-api | 扩展 LLM Gateway 直连棘轮，显式跟踪模型池探活和 Infra Agent profile 校验中的手写上游 HTTP 待迁移债务 |
| refactor | prd-api | 模型池健康探活改走 LLM Gateway raw pinned 调用，保留 IsHealthProbe 日志标记并收紧手写上游 HTTP baseline |
| fix | prd-api | LLM Gateway raw 非 Exchange 路径按协议设置 Claude 和 Google 原生鉴权头，避免探活或 raw 请求误用 Bearer |
| refactor | prd-api | Infra Agent runtime profile 连通性测试改走 llmgw-serve profile-test 契约，清零手写 completion/messages 上游 HTTP baseline |
| ops | prd-agent | 新增 execdep.sh 兼容入口并补发布 gate 守卫，确保 LLMGW_MODE=http 时 shadow 证据钉到同一不可变 commit |
| ops | prd-agent | 发布 gate 支持按 shadow kind 与 appCaller+kind 强制最小样本数，避免全量切 http 时仅靠 resolve-only 证据放行 |
| ops | prd-agent | 发布 gate 支持输出 JSON 与 Markdown 证据报告，并由 exec_dep.sh 透传报告路径，便于正式发布前第三方复核 |
| ops | prd-agent | 发布 gate 增加 serving health 连续采样与 commit 稳定性检查，正式 LLMGW_MODE=http 前默认 3 次探活 |
| ops | prd-agent | 正式部署透传 LLMGW_HTTP_APP_CALLER_ALLOWLIST 与 LLMGW_SHADOW_FULL_SAMPLE_PERCENT，并让 allowlist canary 发布也强制执行 GW release gate |
| security | prd-llmgw | 控制台改密、平台启停、模型启停、默认池切换写入 llm_gateway.llmgw_operation_audits，补齐 GW 自有操作审计 |
| security | prd-llmgw | 首次 bootstrap、破玻璃 reset、admin 重新激活和历史账号禁用也写入 llmgw_operation_audits，补齐启动级账号审计 |
| ops | prd-agent | 发布 gate 支持 shadow sinceHours 新鲜度窗口，exec_dep.sh 默认只接受最近 24 小时样本，避免旧证据误放行 http/canary |
| ops | prd-agent | 新增 LLMGW http/canary 紧急回滚脚本，一键将 MAP API 切回 inproc 且不回滚数据库或 GW 证据 |
| ops | prd-agent | 新增 LLMGW 全量迁移 readiness audit，总结直连、multipart、发布脚本、回滚 dry-run 与 live release gate 证据 |
| ops | prd-agent | readiness audit 支持 --run-smoke，把 gw-smoke.py D 层真机冒烟纳入 S5/S6 发布前总 gate |
| ops | prd-agent | 全量 LLMGW_MODE=http 发布默认要求 send 与 stream 两类 shadow 样本达标，避免只靠总样本或 resolve-only 证据放行 |
| ops | prd-agent | gw-smoke.py D 层真机冒烟扩展到 /stream 与 /client-stream，覆盖流式和 ILLMClient 跨进程发布风险 |
| ops | prd-agent | exec_dep.sh 在 http/canary 发布时默认强制运行 gw-smoke.py，避免人工漏跑 D 层真机冒烟 |
| ops | prd-agent | 新增 llmgw-shadow-coverage-report.py，生成 appCaller x kind shadow 覆盖矩阵供 S5/S6 发布前复核 |
| ops | prd-agent | 新增 llmgw-serving-probe.py，发布前连续检查 serving health commit 稳定性与受保护端点未认证拒绝 |
| ops | prd-agent | exec_dep.sh 在 http/canary 发布时默认强制运行 serving probe，防止滚动未稳定或鉴权裸奔时进入发布 |
| ops | prd-agent | exec_dep.sh 在 shadow 采样证据期启动时强制 serving/smoke 预检，避免坏 serving 产生无效 shadow 证据 |
| ops | prd-agent | readiness audit 新增 CDS runtime 检查，要求预览/灰度网关后端与 serving 以 express 预构建镜像运行并匹配发布 commit，避免源码容器或旧容器假阳性 |
| test | prd-api | 新增 HttpLlmGatewayClientFailureTests，覆盖 serving 不可达或 401 时 send/stream/raw/profile-test/resolve/pools/client-stream 全部显式失败且不伪成功 |
| ops | prd-agent | serving 运行态探针扩展到所有 /gw/v1 受保护边界，覆盖 GET pools/shadow 与 POST resolve/send/stream/client-stream/raw/profile-test 的无 key 401 |
| ops | prd-agent | 生产 compose 不再强制要求 LLMGW_ADMIN_PASSWORD，网关控制台恢复 admin/admin 首登改密引导，env 仅作首次 bootstrap 或破玻璃输入 |
| feat | prd-api | ShadowLlmGateway 为 raw 图片/ASR/视频原始代理增加采样 shadow 证据，发布 gate 全量 http 默认要求 raw 样本和核心 appCaller 覆盖 |
| fix | prd-api | 补齐 Claude 流式 tool_use 到 OpenAI tool_calls delta 的网关归一，避免切 http 后流式工具调用丢失 |
| test | prd-api | 将 Claude 流式 tool_use 纳入 LLM Gateway 协议保真矩阵，B 层数据驱动 cell 从 91 扩展到 93 |
| test | prd-agent | 扩展 llmgw-readiness-audit --run-dotnet，发布前总 gate 覆盖协议矩阵、跨进程矩阵、shadow/raw、媒体合同与 HTTP 边界 |
| ops | prd-agent | 全量 LLMGW_MODE=http 发布默认要求图片、视频、ASR 等 raw appCaller 逐个具备 raw shadow 样本，避免入口级证据搭车过关 |
| ops | prd-agent | 灰度 LLMGW_HTTP_APP_CALLER_ALLOWLIST 发布必须声明 LLMGW_CANARY_STAGE，并按阶段限制入口与自动补齐 send/stream/raw 样本门 |
| ops | prd-agent | fast.sh 写入 release intent，exec_dep.sh 校验同一 commit/tag/repo 后才继续部署，防止正式发布时 API 与 LLMGW 镜像组漂移 |
| ops | prd-agent | LLM Gateway release gate 增加 shadow 覆盖时长检查，http/canary 发布默认要求每个证据格覆盖 24 小时 |
| polish | prd-llmgw-web | Shadow 页面展示影子比对覆盖时长，便于人工复核 S5 灰度观察窗口 |
| ci | prd-agent | 新增 LLM Gateway shadow watch 定时巡检，持续归档 serving 探针、shadow 覆盖矩阵与 live release gate 证据 |
| security | prd-agent | readiness audit 证据报告脱敏子命令中的 --key 参数，避免上传 GW key |
| ops | prd-agent | 调整 LLM Gateway 正式部署 gate 顺序，发布前只校验 shadow 证据，compose 起新镜像后再校验 serving commit 与 D 层 smoke |
| ops | prd-agent | 新增 LLM Gateway 生产阶段推进脚本，统一 shadow、canary、http 全量和 inproc 回滚入口，避免正式发布手工拼环境变量 |
| ops | prd-agent | LLM Gateway 生产阶段推进脚本新增 JSONL 台账和同 commit 顺序校验，防止跳过 shadow/canary 证据阶段 |
| ops | prd-agent | LLM Gateway 生产阶段台账 success 前强制校验 stage、serving probe、gw-smoke 与 release gate 证据 verdict=pass |
| ops | prd-agent | LLM Gateway 生产阶段推进默认要求前一阶段 success 至少观察 24 小时，防止连续跳过 canary 观察窗口 |
| ops | prd-agent | LLM Gateway 生产阶段新增 rollback-rehearsal，同一 commit 未演练回滚脚本时禁止进入 canary/http 阶段 |
| ops | prd-agent | LLM Gateway readiness 新增 rollout ledger 完成态审计，http-full 未落同 commit 证据时不能宣称全量迁移完成 |
| ops | prd-agent | LLM Gateway 生产阶段执行前强制校验发布 commit 包含最新 main，并在阶段证据中记录 main ref/SHA |
| test | prd-api | 扩展 LLM Gateway 手写上游 HTTP 守卫到 text/image/audio/video endpoint，防止图片、ASR、视频请求绕过 llmgw-serve 后仍被测试漏放 |
| ops | prd-agent | LLM Gateway 生产阶段越级推进必须填写原因并写入 stage report 与 rollout ledger，避免 allow-out-of-order 成为无记录后门 |
