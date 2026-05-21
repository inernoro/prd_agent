# AppCallerCode 注册规则

任何对 `ILlmGateway` 的调用都必须传 `AppCallerCode`。这个 code 不允许在 Controller / Service 里写裸字符串字面量——必须先在 `prd-api/src/PrdAgent.Core/Models/AppCallerRegistry.cs` 用 `[AppCallerMetadata]` 注册一条 `public const string`，再在调用处 `= AppCallerRegistry.X.Y.Z` 引用。

## 强制规则

### 1. 不允许裸字符串

```csharp
// ❌ 错误：硬编码字面量，注册表不知道有这条 caller
var req = new GatewayRequest
{
    AppCallerCode = "my-agent.feature::chat",  // 运行时炸 "appCallerCode 未注册"
    ModelType = ModelTypes.Chat,
    ...
};

// ✅ 正确：先在 Registry 加常量，再引用
// 在 AppCallerRegistry.cs:
//   public static class MyAgent {
//     public static class Feature {
//       [AppCallerMetadata("功能-描述", "...", ModelTypes = new[]{ ModelTypes.Chat }, Category = "...")]
//       public const string Chat = "my-agent.feature::chat";
//     }
//   }
var req = new GatewayRequest
{
    AppCallerCode = AppCallerRegistry.MyAgent.Feature.Chat,
    ModelType = ModelTypes.Chat,
    ...
};
```

### 2. 命名必须 kebab-case

`AppCallerCode` 整体格式：`{app-prefix}.{path-segments}.{...}::{model-type}`。每段（点分割）只能用**小写字母 / 数字 / 连字符**。

```
✅ prd-admin.changelog.ai-summary::chat
✅ visual-agent.image-gen.batch-generate::generation
✅ pr-review.summary::chat

❌ prd-admin.changelog.aiSummary::chat       —— camelCase
❌ prd-admin.changelog.ai_summary::chat      —— 下划线
❌ PrdAdmin.Changelog.AiSummary::chat        —— PascalCase
```

允许的应用前缀已在 `AppCallerCodeRegistryGuardTests.AllowedPrefixes` 列出；`ModelType` 必须是 `chat / vision / generation / intent / embedding / rerank / long-context / code` 之一。

### 3. 注册即可被同步到 DB

`AppCallerRegistrySyncService`（hosted service）启动时反射扫 `AppCallerRegistry` 静态类，把所有 `[AppCallerMetadata]` 的常量同步到 `llm_app_callers` 集合。这意味着：

- 加完常量 → 重启服务 → DB 自动有这条记录
- 不需要手工写 init script、不需要前端 admin 页面手动建
- "应用注册表已与代码定义同步"对话框里看到 `+1 已新增` 就说明成功

### 4. 子类组织

按"应用 → 模块 → 功能"的三级嵌套静态类组织：

```csharp
public static class Admin                    // 应用大类
{
    public const string AppName = "PRD Agent Web";

    public static class Changelog            // 模块
    {
        [AppCallerMetadata("更新中心-AI总结", "...", ModelTypes = new[]{ModelTypes.Chat}, Category = "Document")]
        public const string AiSummary = "prd-admin.changelog.ai-summary::chat";  // 功能常量
    }
}
```

`Category` 字段用来做后台管理 UI 分组，可选值参考已有项（`Chat` / `Document` / `Analysis` / `Management` / `Testing` / `Workflow` / `System` / ...）。

## CI 守卫

`prd-api/tests/PrdAgent.Tests/AppCallerCodeRegistryGuardTests.cs` 在 CI 强制：

1. **`EveryAppCallerCodeLiteral_ShouldBeRegistered`**：扫全仓 `*.cs`，找到所有形如 `"...::chat"` 的字面量（含 camelCase / 下划线等违规命名），逐一去 `AppCallerRegistrationService.FindByAppCode` 校验，没注册就 fail
2. **`RegisteredCodes_ShouldUseKebabCase`**：遍历所有已注册项，发现 camelCase / 下划线 / 大写就 fail，给出"请把 aiSummary 改成 ai-summary"这种提示

`PrdAgent.Tests` 已加入 `PrdAgent.sln`，CI workflow 的 `dotnet test PrdAgent.sln --filter "Category!=Integration&Category!=Manual"` 会自动跑这两个测试。

## 历史教训

| 时间 | 事件 |
|------|------|
| 2026-04-27 PR #504 | `ChangelogController` 硬编码 `"prd-admin.changelog.aiSummary::chat"` 但没注册到 Registry，导致点击"AI 总结"运行时报 `appCallerCode 未注册`。逾越守卫的双重原因：(a) 测试正则 `[a-z0-9-]` 段不允许大写，camelCase 被静默跳过 (b) `PrdAgent.Tests` 项目压根没在 `PrdAgent.sln` 里，CI 根本没跑这个测试 |
| 2026-05-09 fix | 放宽正则到 `[a-zA-Z0-9-]` + 新增 kebab-case 强制测试 + `PrdAgent.Tests` 加入 sln，三层兜底 |
| 2026-05-21 二次回归 | `MarketplaceSkillsController.GenerateSummaryAsync` 硬编码 `"marketplace-skill.summary::chat"` 没注册，运行时炸 `APP_CALLER_INVALID`。同代码族还有 `page-agent.generate::chat`（CapsuleExecutor 3 处）也未注册。**漏在哪**：CI 守卫的 `IsKnownPrefix` 是封闭式白名单（`prd-agent / visual-agent / ...`），新加的 `marketplace-skill / page-agent / prd-agent-web / document-store / open-platform-agent` 前缀都不在表里 —— 凡是 prefix 不在表里的 caller-code 字面量都被 `if (!IsKnownPrefix(code)) continue;` 静默跳过，CI 既没报错也没报警。**这次补哪**：（a）测试改为 default-deny —— 删掉 `AllowedPrefixes / IsKnownPrefix`，扫到的所有 `*::modelType` 字面量都必须在 Registry 找到；如确需豁免（虚构示例），写入 `KnownNonRegisteredLiterals` 显式 set 并加注释。（b）补登 `marketplace-skill.summary / draft-description` + `page-agent.generate` 三个注册项 |

## 排查清单

在 PR / push 前自查：

- [ ] 我新加的 `AppCallerCode` 字面量出现在哪？grep 查一下 `"my-agent\."` 或类似前缀
- [ ] 出现位置是不是只在 `AppCallerRegistry.cs`？如果在别处直接写裸字符串，立刻改成引用常量
- [ ] 常量名 / 值是不是 kebab-case？没有大写、没有下划线？
- [ ] 本地跑 `dotnet test PrdAgent.sln --filter "FullyQualifiedName~AppCallerCodeRegistry"` 能过？

任何一项 ❌，先修再 push。
