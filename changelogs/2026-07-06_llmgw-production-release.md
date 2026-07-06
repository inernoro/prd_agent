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
