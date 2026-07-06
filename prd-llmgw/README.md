# prd-llmgw —— AI 大模型网关观测后端

物理隔离的独立 .NET 8 minimal-API 服务，给独立前端 `prd-llmgw-web/` 提供登录与 LLM 请求日志观测能力。

## 是什么

- 自包含服务，不引用任何 prd-api 项目，仅依赖 NuGet 包。
- MAP 继续负责自己的日志；本服务只读 MAP 库里的 `llmrequestlogs` 作为观测视图。
- 拥有独立的 JWT 账户体系（独立密钥，账号存 `llm_gateway.llmgw_console_users`），与 MAP 账户/密钥完全隔离。
- 监听端口 8090（容器内由 `ASPNETCORE_URLS` 指定）。

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `MongoDB__ConnectionString` | `mongodb://localhost:27017` | 与 prd-api 同一 key，共享 DB |
| `MongoDB__DatabaseName` | `prdagent` | MAP 业务库；GW 只读 `llmrequestlogs` 等观测集合 |
| `LlmGateway__DatabaseName` | `llm_gateway` | GW 自有账号、登录审计等状态库 |
| `LlmGwJwt__Secret` | `llmgw-dev-secret-change-me-please-0001`（开发占位，必须改） | HS256 密钥，>=32 字符。独立于 MAP |
| `LlmGwJwt__Issuer` | `prdagent-llmgw` | JWT issuer |
| `LLMGW_ADMIN_PASSWORD` | 未设置时 `admin` | 仅首次 bootstrap 或 `LLMGW_ADMIN_FORCE_RESET=1` 破玻璃时使用；已有账号以数据库哈希为权威 |
| `LLMGW_ADMIN_FORCE_RESET` | 空 | 设为 `1`/`true`/`yes`/`on` 时显式重置 admin 口令 |
| `GIT_COMMIT` | `""` | 由 CI 注入，`/gw/healthz` 回显 |

环境变量用 `__` 双下划线映射到配置层级里的 `:`。

## 端点（路由前缀 `/gw`）

| 方法 | 路径 | 鉴权 |
|------|------|------|
| GET | `/gw/healthz` | 匿名 |
| POST | `/gw/auth/login` | 匿名 |
| GET | `/gw/logs` | JWT |
| GET | `/gw/logs/meta` | JWT |
| GET | `/gw/logs/timeseries` | JWT |
| GET | `/gw/logs/sessions` | JWT |
| GET | `/gw/logs/{id}` | JWT |

除 `/gw/healthz` 外，业务端点返回 `{ success, data, error }` 信封，JSON 字段 camelCase。

## 本地运行

```bash
cd prd-llmgw
dotnet run
# 默认监听 ASPNETCORE_URLS（未设置时由 Kestrel 默认端口；容器内为 8090）
# 本地可显式：ASPNETCORE_URLS=http://0.0.0.0:8090 dotnet run
```

登录（默认管理员）：

```bash
curl -s http://localhost:8090/gw/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"admin"}'
```

## 容器构建

构建上下文为 `./prd-llmgw`：

```bash
docker build -t prd-llmgw ./prd-llmgw \
  --build-arg GIT_COMMIT="$(git rev-parse --short HEAD)"
docker run -p 8090:8090 \
  -e MongoDB__ConnectionString="mongodb://host.docker.internal:27017" \
  -e MongoDB__DatabaseName="prdagent" \
  -e LlmGwJwt__Secret="please-change-this-to-a-strong-secret-0001" \
  prd-llmgw
```
