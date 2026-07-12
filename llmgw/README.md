# LLM Gateway

`llmgw/` 是 LLM Gateway 的单一产品根目录。控制台 API、Web 控制台和 serving host 在这里共同演进；仓库根 Compose、CDS 与 CI 只引用本目录，不保留旧目录兼容副本。

## 目录

```text
llmgw/
├── console-api/  控制台、租户、密钥、治理和观测 API，端口 8090
├── web/          React Web 控制台，容器端口 80
├── serving/      四协议 serving host，端口 8091
├── deploy/       部署边界与运行契约说明
└── docs/         Gateway 文档入口
```

`serving/` 继续通过显式 ProjectReference 复用 `prd-api` 的 Core 与 Infrastructure。该依赖不改变 `ILlmGateway`、Mongo 集合、配置键或 HTTP 协议语义。

## 本地校验

```bash
dotnet build llmgw/console-api/prd-llmgw.csproj --no-restore
dotnet build llmgw/serving/PrdAgent.LlmGateway.csproj --no-restore
pnpm --dir llmgw/web build
```

完整后端与 Gateway 测试仍由 `prd-api/PrdAgent.sln` 统一执行；该 solution 使用相对路径引用 `llmgw/serving`。

## 不变量

- 外部 URL 仍为 `/llmgw/*` 与 `/gw/v1/*`，不因源码目录改变。
- Mongo 数据库、集合、索引和 `TenantId` 语义不变。
- 镜像、容器与环境变量名称不变。
- tenant 只从服务端会话或 service key 解析。
- 不保留旧目录、符号链接或双写构建入口。
