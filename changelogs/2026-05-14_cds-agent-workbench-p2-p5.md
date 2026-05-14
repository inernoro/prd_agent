| feat | cds | 新增 CDS Agent session 最小生命周期与 fake runtime stream 接口 |
| feat | prd-api | 接入 CDS Agent session start/send/stream/logs/tool approval 代理能力 |
| feat | prd-admin | 基础设施服务页新增 CDS Agent 测试台，支持会话、消息、事件和日志查看 |
| fix | prd-api | 后台 CDS sidecar discovery 解密 longToken 失败时不再把刚授权连接误标为 revoked |
| test | prd-api | 同步 DynamicSidecarRegistryTests fake 连接服务签名，覆盖 solution 编译路径 |
| fix | prd-api | CDS paired sidecar 自动发现改为显式开关，默认不读取基础设施连接凭据 |
| fix | prd-api | longToken 解密读取失败不再自动撤销 CDS 连接，连接状态仅由显式探活或授权流程更新 |
| fix | prd-api | CDS 授权完成和近期探活成功作为连接可用性依据，避免异步状态写入阻断 Agent 会话创建 |
| fix | cds | auth 中间件放行 MAP/CDS longToken 调用项目级 agent-sessions 路由，避免 start/send 被全局 AI key 校验拦截 |
| fix | prd-api | start/send/stop 共用连接检查同步近期健康判断，避免创建成功后启动仍被误判不可用 |
| fix | prd-api/cds | CDS Agent fake runtime 补日志事件，MAP 日志读取失败时返回可见诊断快照而非 502 |
| feat | prd-api/prd-admin | 新增 CDS Agent Hook profile API、启动/停止 hook 事件和新建会话配置弹窗 |
| fix | prd-api/cds | 修复 CDS stream 事件序号错位导致工具调用未导入的问题，并补齐危险工具等待审批事件 |
| feat | prd-admin | CDS Agent 工作台工具事件和日志支持复制，并标记危险工具审批提示 |
