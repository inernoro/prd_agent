| ops | prd-agent | 生产发布脚本的不可变 commit 发布同步钉住 llmgw、llmgw-serve、llmgw-web 三个网关镜像，避免 API 已切 sha 但网关仍漂在 latest |
| ops | prd-agent | 发布 manifest 补充网关三镜像 ref，便于正式环境部署前后核对 |
| ci | prd-agent | branch-image 手动触发改为全组件构建，确保正式环境热修前能补齐同一 sha 的 API/Admin/GW 镜像组 |
| test | prd-api | 修正跨进程 LLM Gateway pools 错 key 用例断言，确保 401 鉴权失败按 fail-closed 契约暴露而不是伪装成空模型池 |
| test | prd-api | 扩展 LLM Gateway 直连棘轮，显式跟踪模型池探活和 Infra Agent profile 校验中的手写上游 HTTP 待迁移债务 |
| refactor | prd-api | 模型池健康探活改走 LLM Gateway raw pinned 调用，保留 IsHealthProbe 日志标记并收紧手写上游 HTTP baseline |
| fix | prd-api | LLM Gateway raw 非 Exchange 路径按协议设置 Claude 和 Google 原生鉴权头，避免探活或 raw 请求误用 Bearer |
| refactor | prd-api | Infra Agent runtime profile 连通性测试改走 llmgw-serve profile-test 契约，清零手写 completion/messages 上游 HTTP baseline |
