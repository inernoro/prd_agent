# Skill: Update Image Generation Model Size Configuration

## Description

This skill helps maintain the image generation model size configurations in `ImageGenModelConfigs.cs`. When triggered, it provides a structured prompt template for requesting official model documentation from external tools (like Manus), then guides through comparing and applying changes.

## Trigger Phrases

- "更新 [模型名] 的尺寸"
- "更新大模型尺寸"
- "update model size"
- "更新生图模型尺寸配置"

## Workflow

### Step 1: Generate Request Prompt for Manus

When triggered, provide the user with this prompt template to send to Manus:

```
请帮我查询以下生图模型的官方 API 文档，获取最新的尺寸配置信息：

模型名称：[MODEL_NAME]
需要的信息：
1. 支持的所有图片尺寸（宽 x 高，如 1024x1024）
2. 每个尺寸对应的宽高比（如 1:1、16:9）
3. 尺寸约束类型（固定白名单/范围/仅比例）
4. 分辨率档位（1K/2K/4K）的划分标准
5. 官方文档链接

请按以下格式返回：
- 官方文档 URL：
- 约束类型：whitelist / range / aspect_ratio
- 1K 档位尺寸列表：
  - [尺寸] ([比例])
- 2K 档位尺寸列表：
  - [尺寸] ([比例])
- 4K 档位尺寸列表：
  - [尺寸] ([比例])
- 其他限制（最大/最小宽高、像素总量、整除要求等）：
```

### Step 2: Compare with Existing Configuration

After receiving the response from Manus, compare with the existing configuration:

1. Read the current configuration from `ImageGenModelConfigs.cs`
2. Identify the model by pattern matching (e.g., `doubao-seedream-4-5*`)
3. Compare each field:
   - SizesByResolution (grouped by 1k/2k/4k)
   - SizeConstraintType
   - Max/Min Width/Height
   - MaxPixels
   - MustBeDivisibleBy

### Step 3: Report Changes

Present the changes in a clear format:

```
## 配置变更对比：[MODEL_NAME]

### 新增尺寸
- [1K] 新增：1920x1080 (16:9)

### 移除尺寸
- [2K] 移除：2048x1536 (4:3)

### 属性变更
| 属性 | 旧值 | 新值 |
|------|------|------|
| MaxPixels | 16777216 | 25000000 |

### 官方文档
- URL: [新文档链接]
- LastUpdated: [日期]
```

### Step 4: Apply Changes (with user confirmation)

Only after user confirms:
1. Update the configuration in `ImageGenModelConfigs.cs`
2. Update the `LastUpdated` field to today's date
3. Update the `OfficialDocUrl` if provided
4. Run the unit test to verify: `dotnet test --filter "PrintAllAdapterSizeConfigs"`

## Configuration File Location

```
prd-api/src/PrdAgent.Infrastructure/LLM/ImageGenModelConfigs.cs
```

## Example Configuration Structure

```csharp
new ImageGenModelAdapterConfig
{
    ModelIdPattern = "doubao-seedream-4-5*",
    DisplayName = "豆包 Seedream 4.5",
    Provider = "字节跳动 (火山引擎)",
    OfficialDocUrl = "https://www.volcengine.com/docs/6791/1361006",
    LastUpdated = "2026-01-29",
    SizeConstraintType = SizeConstraintTypes.Range,
    SizesByResolution = new Dictionary<string, List<SizeOption>>
    {
        ["1k"] = new(), // 不支持 1K
        ["2k"] = new()
        {
            new("2048x2048", "1:1"),
            new("2560x1440", "16:9"),
            // ...
        },
        ["4k"] = new()
        {
            new("4096x4096", "1:1"),
            // ...
        },
    },
    // ...
}
```

## Verification

After applying changes, run:

```bash
cd prd-api && dotnet test tests/PrdAgent.Tests/PrdAgent.Tests.csproj \
  --filter "FullyQualifiedName~PrintAllAdapterSizeConfigs" \
  --logger "console;verbosity=detailed"
```

This will print all configurations for manual verification against official documentation.

## Notes

- Always preserve the existing model ID pattern format
- Ensure all sizes use "WxH" format (e.g., "1024x1024", not "1024*1024")
- Ensure all aspect ratios use "W:H" format (e.g., "16:9", not "16/9")
- The 1k/2k/4k tiers are based on total pixel count:
  - 1K: ~1 million pixels (e.g., 1024x1024)
  - 2K: ~4 million pixels (e.g., 2048x2048)
  - 4K: ~16 million pixels (e.g., 4096x4096)
