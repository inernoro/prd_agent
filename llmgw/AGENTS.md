# LLM Gateway 开发规则

本目录继承仓库根 `AGENTS.md` 的全部规则。

## 模块与校验

| 模块 | 路径 | 必跑校验 |
|---|---|---|
| 控制台 API | `llmgw/console-api` | `dotnet build llmgw/console-api/prd-llmgw.csproj --no-restore` |
| Web 控制台 | `llmgw/web` | `pnpm --dir llmgw/web build` |
| Serving host | `llmgw/serving` | `dotnet build llmgw/serving/PrdAgent.LlmGateway.csproj --no-restore` |
| Gateway 回归 | `prd-api/tests` | `dotnet test prd-api/PrdAgent.sln --no-build --filter "Category!=Integration&Category!=Manual"` |

## 不变量

- 不得通过目录迁移重命名 HTTP 路径、Mongo 集合、环境变量、镜像或容器。
- `llmgw/serving` 只负责 host 装配与 HTTP 端点，核心实现仍由明确的 ProjectReference 复用。
- Web 包管理器只允许 pnpm。
- 任何代码变更必须写 changelog 碎片。
