# 开发身份与诊断边界交接

**一句话**：交接 KD-15 的开发认证、Stub 访问与 resolver 诊断边界，以及仍需完成的端点验收。
**谁该读**：接手 KD-15 的后端工程师、负责隔离环境复验的测试人员，以及审阅配置变更的维护者。
**读完能做什么**：配置受控的 Development Stub，确认旧测试 Key 的迁移要求，复跑隔离检查，并据此安排完整服务链路、MCP、真实会话撤销、图片解码与诊断响应的剩余验收。

## 使用与契约

- 固定 `OpenPlatform:TestApiKey` 不再产生身份；清除非 Development 配置中的该项，否则启动失败。开发联调使用受管凭据。
- Stub 仅在 Development 且 `DevelopmentStub:Enabled=true` 注册；配置至少 32 字符的随机 `DevelopmentStub:ApiKey`，每次请求（包括 assets）携带对应 Bearer。不要把开发密钥写入仓库。浏览器裸图片 URL 不再可匿名加载，联调客户端需认证取图。
- Stub 每请求最多 4 张、每边最多 1024；输入像素最多 4 Mi、单帧；请求上限 4 MiB；进程最多 2 个执行中的请求，忙时 429；缓存最多 64 项/32 MiB，淘汰最早资源。超出输出数量和尺寸仍沿用原有 clamp 行为。
- resolver 要求登录及当前 `access` + `mds.read`（或 super），API Key 不可提升为人类管理员。供应商 URL/原始异常不返回，内部 ID 哈希化；日志仅记录哈希主体、是否允许和 trace。
- 没有数据库迁移；没有生产操作或付费模型调用。Program.cs 的集成改动只有旧配置门禁及 Stub MVC 注册约定，需与 KD-16/17 串行核对。

## 检查和证据

已应用仓库 task-handoff-checklist 技能。环境为 Linux Docker、.NET SDK 8.0 镜像。`git diff --check` 检查与隔离门禁执行证据保留于当前执行环境 `/tmp/prd-security-check.log`。

| 检查 | 结果 |
|---|---|
| Production Stub（即使开关与密钥有效） | 过滤器 404 |
| Development Stub 未开启 / 缺密钥 / 正确密钥 | 过滤器 404 / 401 / 放行 |
| resolver 匿名 / 已登录无权限 / 当前获准管理员 / API Key | 过滤器 401 / 403 / 放行 / 403 |
| 完整 solution restore（直接及代理） | NU1301，无法读取 NuGet service index |
| 完整 build、测试套件、真实 HTTP 端点矩阵 | 尚未通过；不得以过滤器结果替代 |

临时隔离 harness 编译并执行真实过滤器，但用替身提供权限服务接口与 Stub 控制器类型。相同门禁场景已保存至 `DevelopmentSecurityGateTests.cs`，完整项目测试尚未运行。无权威预览地址。

## 必须续接

恢复容器到 NuGet 的访问后，先 `dotnet restore`、`dotnet build --no-restore`，修复任何编译问题，再执行非 Integration/Manual 测试。补全无付费模型的 Production/Development HTTP 端点矩阵，包含正常 JWT、受管 Key、撤销、intent/MCP 核心授权路径、缓存/像素/字节及并发边界、取消释放和诊断脱敏审计。尚未关闭债务 `2026-11-17-development-security-boundaries`。

主要风险为未经完整构建和真实服务回归，不应直接部署。后端接续负责人需取得依赖恢复成功与上述证据后评估交付；目前不需要生产凭据或付费授权。

## 续接复核（2026-11-17，恢复后）

恢复包 `38acbd82f25e7f383f956d4e4b2b51ad141fdcfa477eb395155053838ca52c50` 与原 12 文件哈希一致，未重建候选。复用现有官方 SDK 8.0 镜像；未修改网络安全配置、未切换包源或镜像。再次执行 solution restore 仍为 NU1301（api.nuget.org/v3/index.json），终止持续失败的本任务 restore 容器。未能取得完整依赖图，因此不能断言只有某个包缺失；现有容器为临时容器，未发现可复用的完整 NuGet 缓存。本轮新增持久缓存目录 `/workspace/kd15-nuget-cache`，并非依赖已缓存成功。

新增尚未编译/执行的测试：
- `DevelopmentSecurityHttpTests`：真实 loopback Kestrel、JWT 验签、现有 API Key handler、真实 Stub/intent/resolver controller 路由；环境注册、匿名资源、旧测试 Key、受管 Key 撤销和当前权限撤销。空 intent 输入与空 resolver 参数使请求在进入模型/数据库前停止。
- `DevelopmentStubBudgetTests`：缓存数量/字节硬上限与输出尺寸上限。
- 原 `DevelopmentSecurityGateTests` 补并发第三请求 429 和释放槽位验证。

这些测试使用独立 host，不覆盖 Program 全部 middleware、JWT 会话撤销机制、MCP transport、实际生图解码、HTTP 字节上限和成功诊断响应的全部脱敏字段；以上均仍需补验。不得把测试代码已写等同于测试通过。新增 HTTP 测试当前使用数据库/模型依赖隔离，未访问生产或付费模型。

依赖恢复后从仓库根目录执行（仅官方现有镜像，不更改网络策略）：

```sh
docker run --rm -v "$PWD:/src" -v /workspace/kd15-nuget-cache:/root/.nuget/packages -w /src/prd-api mcr.microsoft.com/dotnet/sdk:8.0 dotnet restore --disable-parallel
docker run --rm -v "$PWD:/src" -v /workspace/kd15-nuget-cache:/root/.nuget/packages -w /src/prd-api mcr.microsoft.com/dotnet/sdk:8.0 dotnet build --no-restore
docker run --rm -v "$PWD:/src" -v /workspace/kd15-nuget-cache:/root/.nuget/packages -w /src/prd-api mcr.microsoft.com/dotnet/sdk:8.0 dotnet test tests/PrdAgent.Api.Tests/PrdAgent.Api.Tests.csproj --no-restore --filter 'FullyQualifiedName~DevelopmentSecurity|FullyQualifiedName~DevelopmentStubBudget'
docker run --rm -v "$PWD:/src" -v /workspace/kd15-nuget-cache:/root/.nuget/packages -w /src/prd-api mcr.microsoft.com/dotnet/sdk:8.0 dotnet test --no-restore --filter 'Category!=Integration&Category!=Manual'
```

运行失败时保留完整退出码及日志，并先修编译错误。当前债务仍为 in-progress；无新提交 SHA。

## 2026-11-18 验证更新

从 Library v2 恢复的补丁可直接应用于主干 `038163a370495ffac572abf6dd8208da714df818`。通过无凭据代理恢复官方 NuGet 依赖。官方 SDK 8.0.428 在断网容器中完成 solution 构建（0 错误）和 9 项定向测试（全部通过）。HTTP 测试覆盖三种独立环境配置，仍保留前文未覆盖的完整服务链路。NuGet 继续报告现有 ImageSharp 和 MailKit 依赖告警。
