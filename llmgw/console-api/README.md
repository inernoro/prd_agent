# llmgw/console-api —— LLM Gateway 控制台 API

物理隔离的独立 .NET 8 minimal-API 服务，为 `llmgw/web/` 提供租户、成员、密钥、模型池、路由、治理、费用与请求活动等控制台能力。

## 是什么

- 自包含服务，不引用任何 prd-api 项目，仅依赖 NuGet 包。
- MAP 继续负责自身业务；本服务以 `TenantId` 隔离 Gateway 控制面数据，并读取租户范围内的请求日志作为活动视图。
- 拥有独立的控制台 JWT 会话；服务端从会话或 service key 解析租户，不接受请求自报 `tenantId` 作为授权依据。
- 监听端口 8090（容器内由 `ASPNETCORE_URLS` 指定）。

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `MongoDB__ConnectionString` | `mongodb://localhost:27017` | 与 prd-api 同一 key，共享 DB |
| `MongoDB__DatabaseName` | `prdagent` | MAP 业务库；GW 只读 `llmrequestlogs` 等观测集合 |
| `LlmGateway__DatabaseName` | `llm_gateway` | GW 租户、账号、密钥、路由、治理和审计状态库 |
| `LlmGwJwt__Secret` | `llmgw-dev-secret-change-me-please-0001`（开发占位，必须改） | HS256 密钥，>=32 字符。独立于 MAP |
| `LlmGwJwt__Issuer` | `prdagent-llmgw` | JWT issuer |
| `LLMGW_ADMIN_PASSWORD` | 无 | 空库首次引导或显式恢复所用的独立强口令（12–1024 位）；必须由部署方安全注入，不得提交仓库 |
| `LLMGW_ADMIN_FORCE_RESET` | 空 | 启用受控恢复；必须同时提供口令、目标账号 ID 与操作编号，不创建账号 |
| `LLMGW_ADMIN_RECOVERY_USER_ID` | 空 | 恢复目标的不可变账号 ID，32 位 UUID 无连字符格式 |
| `LLMGW_ADMIN_RECOVERY_ID` | 空 | 每次经批准恢复生成新的 32 位 UUID；相同编号永不重复覆盖后续改密 |
| `LLMGW_ADMIN_ENV_AUTHORITY` | 空 | 已停止支持长期覆盖；真值将拒绝启动，需迁移为一次性受控恢复 |
| `LLMGW_TRUSTED_PROXIES` | 空 | 逗号分隔的直接代理 IP；只信任最近一跳，不接受任意转发头 |
| `GIT_COMMIT` | `""` | 由 CI 注入，`/gw/healthz` 回显 |

环境变量用 `__` 双下划线映射到配置层级里的 `:`。

## 端点（路由前缀 `/gw`）

| 方法 | 路径 | 鉴权 |
|------|------|------|
| GET | `/gw/healthz` | 匿名 |
| GET | `/gw/readyz` | 匿名；真实校验控制台 Mongo 持久层 |
| POST | `/gw/auth/login` | 匿名 |
| GET | `/gw/logs` | JWT |
| GET | `/gw/logs/meta` | JWT |
| GET | `/gw/logs/timeseries` | JWT |
| GET | `/gw/logs/sessions` | JWT |
| GET | `/gw/logs/{id}` | JWT |

除 `/gw/healthz`、`/gw/readyz` 外，业务端点返回 `{ success, data, error }` 信封，JSON 字段 camelCase。

## 本地运行

```bash
cd llmgw/console-api
dotnet run
# 默认监听 ASPNETCORE_URLS（未设置时由 Kestrel 默认端口；容器内为 8090）
# 本地可显式：ASPNETCORE_URLS=http://0.0.0.0:8090 dotnet run
```

首次接入由部署管理员安全注入独立强口令，然后在控制台以 `admin` 登录并完成强制改密。没有引导材料时服务不会创建所有者，仓库已知口令无法领取账号。已有任何账号的库不会新增默认所有者，也不会激活或覆盖已有账号；普通重启不重新开放引导。首次成功后移除引导口令环境变量。

恢复时先核对账号的不可变 ID，再注入新强口令、恢复目标 ID、新操作编号和恢复开关。恢复会使旧会话失效并要求改密，成功后移除恢复配置。相同操作编号不覆盖用户后续改密；冲突必须先核对，再创建新操作，不能通过删除领取记录、恢复旧库或修改默认账号来重开入口。MAP 联邦会话原有恢复路径保持不变。

登录预算以数据库服务器的 UTC 分钟为窗口：每账号 5 次、每 IP 20 次、全局 120 次，成功和失败都计入。多个控制台实例必须共享同一网关库，预算不会随重启清空。IPv4 映射地址归一，IPv6 按 /64 归组；代理配置为空时按直接连接地址计数，部署前应核实反代地址与转发头契约。超过预算返回 429 和 60 秒重试提示；数据库故障返回 503，不降级放行。

已准入的失败保留原审计；超额请求只累计数量，各实例每分钟写一次汇总，不逐次插入审计。汇总保留最近写入时刻和累计拒绝/不可用次数；进程崩溃可能丢失尚未刷新的一分钟计数，写入结果未知不自动重放避免重复计数。它不是完整逐次取证记录。

一次性引导/恢复台账位于 `llmgw_owner_bootstrap`，准入与拒绝汇总位于 `llmgw_login_admission`，只依赖内置 `_id` 唯一索引；MongoDB 需支持 `$dateTrunc`（5.0+）。引导/恢复记录不得按 TTL 清除。恢复过程中临时保留口令哈希，完成后移除；整个网关数据库应按账号凭据库保护。没有新增自动建索引。

## 容器构建

构建上下文为 `./llmgw/console-api`：

```bash
docker build --build-arg GIT_COMMIT="$(git rev-parse --short HEAD)" \
  -t prdagent-llmgw ./llmgw/console-api
docker run -p 8090:8090 \
  -e MongoDB__ConnectionString="mongodb://host.docker.internal:27017" \
  -e MongoDB__DatabaseName="prdagent" \
  -e LlmGwJwt__Secret="please-change-this-to-a-strong-secret-0001" \
  prdagent-llmgw
```

## 密钥维护的并发前置条件

旧共享密钥策略保存必须提交最近读取的 `expectedPolicyRevision`；GET 的新增 `policyRevision` 为策略编辑版本，业务调用观测不改变它。确认客户端切换必须提交用户实际确认的 `expectedSuccessorKeyId`。字段缺失返回 HTTP 428（`LEGACY_POLICY_REVISION_REQUIRED` / `ROTATION_EXPECTATION_REQUIRED`），旧写客户端须先读取并升级请求，服务端不会代填最新值。

策略版本失配返回 `LEGACY_POLICY_CONFLICT`；后继已变化返回 `ROTATION_PAIR_CHANGED`，均在写入前拒绝。旧共享密钥的永久撤销不可被陈旧策略恢复。轮换仍沿用既有两份密钥记录的阶段校验；这项前置条件不提供跨文档事务，写后审计或部分阶段失败仍须读取核对，不能盲重提。
