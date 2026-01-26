# 测试组织

## 原则

**默认所有测试都是 CI 测试，只标记需要排除的。**

## 运行命令

```bash
# CI（排除集成测试）
dotnet test --filter "Category!=Integration"

# 本地全量
dotnet test

# 仅集成测试
dotnet test --filter "Category=Integration"
```

## 标记方式

只有需要真实外部服务的测试才加标记：

```csharp
[Trait("Category", TestCategories.Integration)]
public class TencentCosStorageTests { ... }
```

普通测试不需要任何标记。

## 当前集成测试

| 测试类 | 依赖 | 环境变量 |
|--------|------|---------|
| TencentCosStorageTests | 腾讯云 COS | `TENCENT_COS_*` |

## 添加新集成测试

```csharp
[Trait("Category", TestCategories.Integration)]
public class MyExternalServiceTests
{
    [Fact]
    public async Task Test()
    {
        var key = Environment.GetEnvironmentVariable("MY_API_KEY");
        if (string.IsNullOrEmpty(key)) return; // 无环境变量时跳过

        // 测试逻辑
    }
}
```
