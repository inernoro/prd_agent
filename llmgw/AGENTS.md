# LLM Gateway 开发规则

本目录继承仓库根 `AGENTS.md` 的全部规则。

## 模块与校验

| 模块 | 路径 | 必跑校验 |
|---|---|---|
| 控制台 API | `llmgw/console-api` | `dotnet build llmgw/console-api/prd-llmgw.csproj --no-restore` |
| Web 控制台 | `llmgw/web` | `pnpm --dir llmgw/web build` + `pnpm --dir llmgw/web test`；涉及页面/共享布局时另跑 `pnpm --dir e2e test:content-density` |
| Serving host | `llmgw/serving` | `dotnet build llmgw/serving/PrdAgent.LlmGateway.csproj --no-restore` |
| Gateway 回归 | `prd-api/tests` | `dotnet test prd-api/PrdAgent.sln --no-build --filter "Category!=Integration&Category!=Manual"` |

## 不变量

- 不得通过目录迁移重命名 HTTP 路径、Mongo 集合、环境变量、镜像或容器。
- `llmgw/serving` 只负责 host 装配与 HTTP 端点，核心实现仍由明确的 ProjectReference 复用。
- Web 包管理器只允许 pnpm。
- 任何代码变更必须写 changelog 碎片。

## 内容前置回归

页面与共享布局遵守 `.claude/rules/content-fills-canvas.md` 的任务优先边界。密度检查使用同视口与数据的浏览器几何、遮挡与操作路径；静态扫描只产生候选。`e2e/llmgw-content-density.mjs` 覆盖桌面/触控窄屏、明暗、空少多数据、错误/只读、二级标签与共享详情；其确定性夹具不能替代真实公开预览验收。
