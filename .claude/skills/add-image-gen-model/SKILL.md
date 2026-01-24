# Add Image Gen Model Skill

## Trigger

当用户说 "添加生图模型"、"新增生图模型配置"、"add image gen model"、"配置新的生图模型" 时触发此 skill。

## Purpose

帮助用户添加新的生图模型适配器配置，包括后端和前端的配置。

## Prerequisites

用户需要提供以下信息（如果没有提供，需要询问）：
1. **模型名匹配模式**（ModelIdPattern）：如 `doubao-seedream-4-5*`，支持通配符 `*`
2. **显示名称**（DisplayName）：如 "豆包 Seedream 4.5"
3. **提供商**（Provider）：如 "字节跳动 (火山引擎)"
4. **支持的尺寸**（AllowedSizes）：如 `["1024x1024", "2048x2048"]`
5. **支持的比例**（AllowedRatios）：如 `["1:1", "16:9", "9:16"]`
6. **尺寸约束类型**（SizeConstraintType）：
   - `whitelist` - 仅支持固定尺寸白名单
   - `range` - 支持范围内任意尺寸
   - `aspect_ratio` - 仅支持比例枚举
7. **备注**（Notes）：如 `["支持 1K/2K/4K 档位"]`

可选参数：
- MustBeDivisibleBy：宽高必须整除的值（如 8、32）
- MaxWidth/MaxHeight：最大宽高
- MinWidth/MinHeight：最小宽高
- MaxPixels：最大像素总量
- SupportsImageToImage：是否支持图生图
- SupportsInpainting：是否支持局部重绘

## Files to Modify

### 1. 后端配置文件

**文件路径**：`prd-api/src/PrdAgent.Infrastructure/LLM/ImageGenModelConfigs.cs`

在 `Configs` 列表末尾添加新的配置项：

```csharp
// ===== {显示名称} =====
new ImageGenModelAdapterConfig
{
    ModelIdPattern = "{模型名匹配模式}",
    DisplayName = "{显示名称}",
    Provider = "{提供商}",
    SizeConstraintType = SizeConstraintTypes.{约束类型},
    SizeConstraintDescription = "{约束描述}",
    AllowedSizes = new List<string>
    {
        // 尺寸列表
    },
    AllowedRatios = new List<string> { /* 比例列表 */ },
    SizeParamFormat = SizeParamFormats.WxH, // 或 WidthHeight, AspectRatio
    MustBeDivisibleBy = null, // 可选
    MinWidth = null, MinHeight = null, // 可选
    MaxWidth = null, MaxHeight = null, // 可选
    MaxPixels = null, // 可选
    Notes = new List<string> { /* 备注列表 */ },
    SupportsImageToImage = false,
    SupportsInpainting = false,
},
```

### 2. 前端配置文件

**文件路径**：`prd-admin/src/lib/imageGenAdapterConfigs.ts`

在 `IMAGE_GEN_ADAPTER_CONFIGS` 数组末尾添加新的配置项：

```typescript
{
  modelIdPattern: '{模型名匹配模式}',
  displayName: '{显示名称}',
  provider: '{提供商}',
  sizeConstraintType: '{约束类型}', // 'whitelist' | 'range' | 'aspect_ratio'
  allowedRatios: [/* 比例列表 */],
  notes: [/* 备注列表 */],
},
```

## Execution Steps

1. **询问模型信息**（如果用户没有提供完整信息）
2. **读取后端配置文件** `ImageGenModelConfigs.cs`
3. **在 Configs 列表末尾添加新配置**
4. **读取前端配置文件** `imageGenAdapterConfigs.ts`
5. **在 IMAGE_GEN_ADAPTER_CONFIGS 数组末尾添加新配置**
6. **总结变更**

## Example

用户说："添加一个新的生图模型配置，模型名是 my-new-model*，显示名称是 My New Model，提供商是 MyCompany，支持 1024x1024 和 2048x2048 尺寸，比例支持 1:1 和 16:9"

执行后会在两个文件中添加对应的配置项。

## Notes

- 后端和前端的配置需要保持一致
- 模型名匹配模式支持通配符 `*`，如 `my-model*` 会匹配 `my-model-v1`、`my-model-pro` 等
- 如果尺寸约束类型是 `range`，需要提供 Min/Max 宽高限制
- 如果尺寸约束类型是 `aspect_ratio`，主要填写 `AllowedRatios`
