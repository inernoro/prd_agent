# 云端 AI 开发测试策略

> **目标**：让 AI 在提交代码前能自主验证，减少人工验收循环

---

## 云端环境测试能力（实测结果）

> **实测日期**：2026-02-01 | **环境**：Ubuntu 24.04 + Node.js 22

### 可用测试

| 测试类型 | 命令 | 状态 | 说明 |
|---------|------|------|------|
| 前端单元测试 (vitest) | `cd prd-admin && pnpm test` | ✅ 可用 | 148 个测试通过 |
| TypeScript 类型检查 | `cd prd-admin && pnpm tsc` | ✅ 可用 | 编译期错误检查 |
| ESLint 检查 | `cd prd-admin && pnpm lint` | ✅ 可用 | 代码规范检查 |

### 不可用测试（网络限制）

| 测试类型 | 原因 | 替代方案 |
|---------|------|----------|
| 后端单元测试 (dotnet test) | NuGet 无法联网下载依赖 | 本地运行/CI 流水线 |
| E2E 测试 (Playwright) | 无法下载 Chromium | 本地运行/CI 流水线 |

### 环境检测命令

```bash
# 检查 Node.js 环境
node --version    # v22.22.0
pnpm --version    # 10.28.1

# 检查 .NET 环境（需先安装）
# 安装命令：curl -sSL https://dot.net/v1/dotnet-install.sh | bash -s -- --channel 8.0
~/.dotnet/dotnet --version    # 8.0.417（安装后可用，但无法 restore）
```

### 云端 AI 工作流（适应网络限制）

```
┌─────────────────────────────────────────────────────────────┐
│  云端 AI 测试策略（网络受限）                                │
│                                                             │
│  1. 前端改动 → 跑 pnpm test (vitest) → 必须通过             │
│  2. 后端改动 → 写好测试代码 → 本地/CI 验证                   │
│  3. TypeScript → 跑 pnpm tsc → 无类型错误                   │
│  4. 代码规范 → 跑 pnpm lint → 无 ESLint 错误                │
└─────────────────────────────────────────────────────────────┘
```

---

## 核心原则

```
┌─────────────────────────────────────────────────────────────┐
│  云端 AI 开发的黄金法则：                                    │
│                                                             │
│  "写代码前先写测试，改代码后先跑测试"                         │
│                                                             │
│  AI 必须在每次代码变更后运行相关测试，                        │
│  测试通过后才能提交。                                        │
└─────────────────────────────────────────────────────────────┘
```

## 测试金字塔

```
                    ┌───────────┐
                    │   E2E     │  ← 页面流程测试 (Playwright)
                    │  Tests    │     验证完整用户流程
                   ─┴───────────┴─
                 ┌─────────────────┐
                 │  Integration    │  ← API 契约测试
                 │    Tests        │     验证前后端接口契约
                ─┴─────────────────┴─
              ┌───────────────────────┐
              │     Unit Tests        │  ← 单元测试
              │                       │     验证业务逻辑
             ─┴───────────────────────┴─
```

## 快速命令参考

### 后端测试 (prd-api)

```bash
# 运行所有单元测试
cd prd-api && dotnet test

# 运行特定测试类
dotnet test --filter "ClassName=LlmGatewayTests"

# 运行特定测试方法
dotnet test --filter "FullyQualifiedName~SendAsync_Should"

# 运行契约测试（验证前后端接口）
dotnet test --filter "Category=Contract"

# 运行快速验证（不需要外部依赖）
dotnet test --filter "Category=Fast"

# 详细输出
dotnet test --logger "console;verbosity=detailed"
```

### 前端测试 (prd-admin)

```bash
# 运行所有单元测试
cd prd-admin && pnpm test

# 监听模式（本地开发用）
pnpm test:watch

# 运行 E2E 测试
pnpm test:e2e

# 运行特定 E2E 测试
pnpm test:e2e --grep "模型管理"
```

---

## 第一层：单元测试

### 后端单元测试规范

位置：`prd-api/tests/PrdAgent.Api.Tests/`

```csharp
// 命名规范：{被测类}Tests.cs
// 方法命名：{方法名}_{场景}_{期望结果}

[Fact]
public void ResolveModel_WithDedicatedPool_ReturnsPoolModel()
{
    // Arrange - 准备
    var resolver = new ModelResolver(...);

    // Act - 执行
    var result = resolver.Resolve("visual-agent.image::generation");

    // Assert - 断言
    Assert.Equal("gpt-4o", result.ModelId);
}
```

### 前端单元测试规范

位置：`prd-admin/src/**/__tests__/`

```typescript
// 命名规范：{模块名}.test.ts

describe('ThemeSystem', () => {
  it('should apply liquid glass theme correctly', () => {
    // Arrange
    const theme = createTheme('liquid-glass');

    // Act
    const result = applyTheme(theme);

    // Assert
    expect(result.backdropBlur).toBe('20px');
  });
});
```

---

## 第二层：API 契约测试（重点）

> **这是解决云端开发痛点的关键层**

### 为什么需要契约测试

1. AI 无法启动完整服务进行调试
2. 契约测试可以验证接口格式是否正确
3. 不需要真实数据库/外部服务

### 契约测试目录结构

```
prd-api/tests/PrdAgent.Api.Tests/
├── Contract/                         # 契约测试目录
│   ├── Requests/                     # 请求格式测试
│   │   ├── ChatRequestContractTests.cs
│   │   ├── ImageGenRequestContractTests.cs
│   │   └── ...
│   ├── Responses/                    # 响应格式测试
│   │   ├── ChatResponseContractTests.cs
│   │   └── ...
│   └── Flows/                        # 流程契约测试
│       ├── ChatRunFlowContractTests.cs
│       └── ImageGenFlowContractTests.cs
```

### 契约测试示例

```csharp
[Trait("Category", "Contract")]
public class ImageGenRequestContractTests
{
    /// <summary>
    /// 前端发送多图生图请求的契约验证
    /// </summary>
    [Fact]
    public void CreateImageGenRun_MultiImage_RequestContract()
    {
        // 这是前端发送的 JSON 格式
        var frontendRequest = """
        {
            "prompt": "@img1@img2 融合这两张图",
            "targetKey": "canvas-element-abc123",
            "platformId": "vveai",
            "modelId": "nano-banana-pro",
            "size": "1024x1024",
            "imageRefs": [
                {
                    "refId": 1,
                    "assetSha256": "abc123...",
                    "url": "https://example.com/img1.jpg",
                    "label": "风格图"
                },
                {
                    "refId": 2,
                    "assetSha256": "def456...",
                    "url": "https://example.com/img2.jpg",
                    "label": "内容图"
                }
            ]
        }
        """;

        // 验证能正确反序列化
        var request = JsonSerializer.Deserialize<CreateWorkspaceImageGenRunRequest>(
            frontendRequest,
            new JsonSerializerOptions { PropertyNameCaseInsensitive = true }
        );

        Assert.NotNull(request);
        Assert.Equal(2, request.ImageRefs.Count);
        Assert.Contains("@img1", request.Prompt);
    }

    /// <summary>
    /// 响应契约验证
    /// </summary>
    [Fact]
    public void CreateImageGenRun_Response_ContainsRequiredFields()
    {
        var response = new CreateImageGenRunResponse
        {
            RunId = "run_123",
            Status = "pending",
            CreatedAt = DateTime.UtcNow
        };

        var json = JsonSerializer.Serialize(response);
        var doc = JsonDocument.Parse(json);

        // 验证必需字段存在
        Assert.True(doc.RootElement.TryGetProperty("runId", out _));
        Assert.True(doc.RootElement.TryGetProperty("status", out _));
    }
}
```

### 流程契约测试

```csharp
[Trait("Category", "Contract")]
public class ChatRunFlowContractTests
{
    /// <summary>
    /// 完整对话流程的契约验证
    /// 验证：创建会话 → 创建 Run → 轮询状态 → 获取消息
    /// </summary>
    [Fact]
    public void ChatFlow_FullCycle_ContractVerification()
    {
        // Step 1: 创建会话请求
        var createSessionRequest = new { name = "测试会话" };
        var sessionResponse = new { id = "sess_123", name = "测试会话" };

        // Step 2: 创建 Run 请求
        var createRunRequest = new
        {
            sessionId = "sess_123",
            content = "你好",
            platformId = "openai",
            modelId = "gpt-4o"
        };
        var runResponse = new { runId = "run_456", status = "queued" };

        // Step 3: 轮询状态响应
        var statusResponse = new { runId = "run_456", status = "completed" };

        // Step 4: 获取消息响应
        var messagesResponse = new
        {
            messages = new[]
            {
                new { role = "user", content = "你好" },
                new { role = "assistant", content = "你好！有什么可以帮助你的？" }
            }
        };

        // 验证契约字段
        Assert.NotNull(sessionResponse.id);
        Assert.NotNull(runResponse.runId);
        Assert.Equal("completed", statusResponse.status);
        Assert.Equal(2, messagesResponse.messages.Length);
    }
}
```

---

## 第三层：E2E 页面测试

### Playwright 配置

```typescript
// prd-admin/playwright.config.ts
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 30000,
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
  ],
  webServer: {
    command: 'pnpm dev',
    url: 'http://localhost:5173',
    reuseExistingServer: !process.env.CI,
  },
});
```

### E2E 测试示例

```typescript
// prd-admin/e2e/visual-agent.spec.ts
import { test, expect } from '@playwright/test';

test.describe('VisualAgent 工作区', () => {
  test.beforeEach(async ({ page }) => {
    // 登录
    await page.goto('/login');
    await page.fill('[data-testid="username"]', 'admin');
    await page.fill('[data-testid="password"]', 'password');
    await page.click('[data-testid="login-btn"]');
    await expect(page).toHaveURL('/dashboard');
  });

  test('创建新工作区', async ({ page }) => {
    await page.goto('/visual-agent');

    // 点击创建按钮
    await page.click('[data-testid="create-workspace-btn"]');

    // 填写工作区名称
    await page.fill('[data-testid="workspace-name"]', '测试工作区');
    await page.click('[data-testid="confirm-btn"]');

    // 验证工作区创建成功
    await expect(page.locator('[data-testid="workspace-title"]'))
      .toContainText('测试工作区');
  });

  test('上传图片到画布', async ({ page }) => {
    await page.goto('/visual-agent/workspace/ws_123');

    // 上传文件
    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles('./fixtures/test-image.png');

    // 验证图片显示在画布上
    await expect(page.locator('[data-testid="canvas-image"]')).toBeVisible();
  });
});
```

---

## AI 开发工作流

### 修改代码前

```bash
# 1. 先理解现有测试
cd prd-api && dotnet test --filter "ClassName~{相关模块}" --list-tests

# 2. 运行相关测试确保绿灯
dotnet test --filter "ClassName~{相关模块}"
```

### 修改代码后

```bash
# 1. 运行受影响的单元测试
dotnet test --filter "ClassName~{修改的模块}"

# 2. 运行契约测试
dotnet test --filter "Category=Contract"

# 3. 如果修改了前端
cd prd-admin && pnpm test

# 4. 全部通过后再提交
```

### AI 必须遵守的规则

```
┌─────────────────────────────────────────────────────────────┐
│  AI 测试规则                                                 │
│                                                             │
│  1. 新增功能 → 必须同时新增测试                              │
│  2. 修复 Bug → 必须先写失败测试，再修复                      │
│  3. 重构代码 → 必须先跑测试确保绿灯                          │
│  4. 提交前 → 必须跑 dotnet test 和 pnpm test                │
│  5. 测试失败 → 不允许提交，必须修复                          │
└─────────────────────────────────────────────────────────────┘
```

---

## 测试数据管理

### Mock 数据规范

```csharp
// prd-api/tests/PrdAgent.Api.Tests/Fixtures/TestData.cs
public static class TestData
{
    public static class Users
    {
        public static readonly User Admin = new()
        {
            Id = "user_admin",
            Username = "admin",
            Role = SystemRole.Admin
        };
    }

    public static class Sessions
    {
        public static readonly Session Default = new()
        {
            Id = "sess_test_001",
            Name = "测试会话",
            UserId = Users.Admin.Id
        };
    }
}
```

### Fixture 文件

```
prd-api/tests/PrdAgent.Api.Tests/Fixtures/
├── TestData.cs           # 共享测试数据
├── MockServices.cs       # 模拟服务
└── TestHelpers.cs        # 测试辅助方法
```

---

## 常见问题排查

### 测试失败时的检查清单

1. **序列化问题**
   - 检查 JSON 属性名大小写
   - 检查 nullable 类型标注

2. **时间相关问题**
   - 使用 `IClock` 接口注入时间
   - 测试中使用固定时间

3. **数据库相关问题**
   - 单元测试不应依赖真实数据库
   - 使用 In-Memory 或 Mock

4. **外部 API 问题**
   - 使用 `HttpMessageHandler` Mock
   - 契约测试不调用真实 API

---

## 测试覆盖率目标

| 层级 | 目标覆盖率 | 说明 |
|------|-----------|------|
| 核心业务逻辑 | 80%+ | Gateway, Resolver, Services |
| Controller | 契约测试 | 验证请求/响应格式 |
| 工具类 | 90%+ | 纯函数，易测试 |
| UI 组件 | 快照测试 | 防止意外变更 |

---

## 下一步行动

如果你是 AI，请在开始开发前：

1. 运行 `dotnet test` 确认基线绿灯
2. 识别你要修改的模块
3. 找到对应的测试文件
4. 如果没有测试，先创建测试
5. 修改代码
6. 运行测试确认通过
7. 提交代码
