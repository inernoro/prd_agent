# prd-llmgw —— AI 大模型网关观测后端

物理隔离的独立 .NET 8 minimal-API 服务，给独立前端 `prd-llmgw-web/` 提供登录与 LLM 请求日志观测能力。

## 是什么

- 自包含服务，不引用任何 prd-api 项目，仅依赖 NuGet 包。
- 与 MAP（prd-api）共享同一个 MongoDB，只读共享集合 `llmrequestlogs`。
- 拥有独立的 JWT 账户体系（独立密钥，存 `llmgw_users` 集合），与 MAP 账户/密钥完全隔离。
- 监听端口 8090（容器内由 `ASPNETCORE_URLS` 指定）。

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `MongoDB__ConnectionString` | `mongodb://localhost:27017` | 与 prd-api 同一 key，共享 DB |
| `MongoDB__DatabaseName` | `prdagent` | 同上 |
| `LlmGwJwt__Secret` | `llmgw-dev-secret-change-me-please-0001`（开发占位，必须改） | HS256 密钥，>=32 字符。独立于 MAP |
| `LlmGwJwt__Issuer` | `prdagent-llmgw` | JWT issuer |
| `LLMGW_ADMIN_USER` | `admin` | 启动时幂等播种的管理员用户名 |
| `LLMGW_ADMIN_PASSWORD` | `llmgw-admin-2026` | 管理员初始口令（PBKDF2 入库） |
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
  -d '{"username":"admin","password":"llmgw-admin-2026"}'
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
