# 多图生成设计文档 - Vision API 方案

## 1. 问题背景

### 当前限制
- `OpenAIImageClient` 的图生图（img2img）使用 `/v1/images/edits` 端点
- 该端点只支持**单张参考图**（multipart/form-data 格式）
- 当前 Worker 只加载第一张图片：
  ```csharp
  var firstRef = parseResult.ResolvedRefs.FirstOrDefault();
  ```
- 其他图片只通过「图片对照表」文字描述，模型无法真正"看到"

### 用户期望
用户输入 `@img16@img17 把这两张图融合成一张`，期望模型能同时看到两张图片进行创作。

---

## 2. 设计方案：Vision API

### 2.1 nanobanana 支持的格式

根据 API 文档，nanobanana 支持 Vision API 格式（`/v1/chat/completions`），可传递 1-6 张图片：

```json
POST /v1/chat/completions
{
  "model": "nano-banana-pro",
  "messages": [
    {
      "role": "user",
      "content": [
        {
          "type": "text",
          "text": "@img16@img17 把这两张图融合成一张\n\n【图片对照表】\n@img16 对应 风格参考图\n@img17 对应 目标图片"
        },
        {
          "type": "image_url",
          "image_url": {
            "url": "data:image/jpeg;base64,/9j/4AAQ..."
          }
        },
        {
          "type": "image_url",
          "image_url": {
            "url": "data:image/jpeg;base64,/9j/4BBR..."
          }
        }
      ]
    }
  ],
  "max_tokens": 4096
}
```

### 2.2 响应格式

```json
{
  "id": "chatcmpl-xxx",
  "object": "chat.completion",
  "created": 1234567890,
  "model": "nano-banana-pro",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "data:image/png;base64,iVBORw0KGgo..."
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 1000,
    "completion_tokens": 500,
    "total_tokens": 1500
  }
}
```

---

## 3. 架构修改

### 3.1 新增 Vision API 请求模型

```
PrdAgent.Core/Models/LLM/
├── VisionRequest.cs          # 请求模型
├── VisionMessage.cs          # messages 数组元素
├── VisionContentItem.cs      # content 数组元素（text/image_url）
└── VisionResponse.cs         # 响应模型
```

### 3.2 OpenAIImageClient 修改

新增方法：
```csharp
/// <summary>
/// 使用 Vision API 生成图片（支持多图参考）
/// </summary>
public async Task<ImageGenerateResult> GenerateWithVisionAsync(
    string platformId,
    string modelId,
    string prompt,
    List<ImageRefData> imageRefs,  // 多张图片
    string size,
    CancellationToken ct = default);
```

### 3.3 ImageGenRunWorker 修改

修改图片加载逻辑，从只加载第一张改为加载所有图片：

```csharp
// 修改前（只加载第一张）
var firstRef = parseResult.ResolvedRefs.FirstOrDefault();
if (firstRef != null) { /* 加载单图 */ }

// 修改后（加载所有图片）
var loadedImages = new List<ImageRefData>();
foreach (var resolvedRef in parseResult.ResolvedRefs)
{
    var imageData = await LoadImageFromCos(resolvedRef.AssetSha256, ct);
    if (imageData != null)
    {
        loadedImages.Add(new ImageRefData
        {
            RefId = resolvedRef.RefId,
            Base64 = imageData.Base64,
            MimeType = imageData.MimeType,
            Label = resolvedRef.Label
        });
    }
}
```

### 3.4 路由决策

```csharp
if (loadedImages.Count == 0)
{
    // 文生图：/v1/images/generations
    result = await imageClient.GenerateAsync(...);
}
else if (loadedImages.Count == 1)
{
    // 单图生图：/v1/images/edits（保持兼容）
    result = await imageClient.GenerateAsync(..., initImageBase64: loadedImages[0].Base64);
}
else
{
    // 多图生图：/v1/chat/completions（Vision API）
    result = await imageClient.GenerateWithVisionAsync(..., imageRefs: loadedImages);
}
```

---

## 4. 数据流

```
┌─────────────────────────────────────────────────────────────────┐
│                         Frontend                                 │
│  用户输入: "@img16@img17 把这两张图融合成一张"                      │
│  附带: imageRefs = [{refId:16, sha256:..., label:"风格参考图"},   │
│                     {refId:17, sha256:..., label:"目标图片"}]     │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    ImageMasterController                         │
│  1. 记录请求日志（含所有 imageRefs）                               │
│  2. 创建 ImageGenRun 记录                                        │
│  3. 触发 Worker 执行                                             │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                     ImageGenRunWorker                            │
│  1. MultiImageDomainService.ParsePromptRefs() 解析引用           │
│  2. 遍历所有 resolvedRefs，从 COS 加载图片                        │
│  3. BuildFinalPromptAsync() 构建增强 prompt（含图片对照表）        │
│  4. 根据图片数量选择 API：                                        │
│     - 0张 → GenerateAsync (text2img)                            │
│     - 1张 → GenerateAsync (img2img)                             │
│     - 2+张 → GenerateWithVisionAsync (Vision API)               │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                     OpenAIImageClient                            │
│  GenerateWithVisionAsync():                                      │
│  1. 构建 Vision API 请求体                                       │
│  2. POST /v1/chat/completions                                   │
│  3. 解析响应，提取生成的图片                                       │
│  4. 返回 ImageGenerateResult                                     │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                       nanobanana API                             │
│  接收: messages 数组（包含 text + 多个 image_url）                │
│  处理: 分析多图意图，融合生成                                      │
│  返回: 生成的图片（base64 或 URL）                                │
└─────────────────────────────────────────────────────────────────┘
```

---

## 5. 图片对照表保留

即使使用 Vision API 传递真实图片，仍然保留「图片对照表」文字说明：

```
用户原始输入：@img16@img17 把这两张图融合成一张

增强后的 prompt：
@img16@img17 把这两张图融合成一张

【图片对照表】
@img16 对应 风格参考图
@img17 对应 目标图片
```

**原因**：
1. 帮助模型理解每张图片的用途（风格参考 vs 目标图片）
2. 图片在 messages 中的顺序与 @imgN 的编号对应
3. Label 提供了用户的意图描述

---

## 6. 限制与边界

| 限制项 | 值 | 说明 |
|--------|-----|------|
| 最大图片数 | 6 | nanobanana Vision API 限制 |
| 单图最大尺寸 | 20MB | base64 编码后约 27MB |
| 支持格式 | JPEG, PNG, WebP, GIF | 常见图片格式 |
| 响应超时 | 120s | 多图处理可能较慢 |

---

## 7. 错误处理

```csharp
// 图片数量超限
if (loadedImages.Count > 6)
{
    _logger.LogWarning("[多图处理] 图片数量超过限制(6张)，将只使用前6张");
    loadedImages = loadedImages.Take(6).ToList();
}

// 某张图片加载失败
if (loadedImages.Count < parseResult.ResolvedRefs.Count)
{
    _logger.LogWarning("[多图处理] 部分图片加载失败，继续使用已加载的 {Count} 张", loadedImages.Count);
}

// Vision API 调用失败，降级到单图模式
catch (Exception ex)
{
    _logger.LogError(ex, "[多图处理] Vision API 调用失败，降级到单图模式");
    result = await imageClient.GenerateAsync(..., initImageBase64: loadedImages[0].Base64);
}
```

---

## 8. 测试计划

### 8.1 单元测试
- `MultiImageDomainService` 解析多图引用
- Vision API 请求体构建
- 响应解析

### 8.2 集成测试
- 真实调用 vveai nano-banana-pro
- 发送 2 张图片
- 验证生成结果

### 8.3 测试用例

```csharp
[Fact]
public async Task MultiImage_VisionApi_TwoImages_ShouldGenerateImage()
{
    // Arrange: 准备两张测试图片的 base64
    var imageRefs = new List<ImageRefData>
    {
        new() { RefId = 16, Base64 = "data:image/jpeg;base64,...", Label = "风格参考图" },
        new() { RefId = 17, Base64 = "data:image/jpeg;base64,...", Label = "目标图片" }
    };
    var prompt = "@img16@img17 把这两张图融合成一张";

    // Act: 调用 Vision API
    var result = await client.GenerateWithVisionAsync(
        platformId: "vveai",
        modelId: "nano-banana-pro",
        prompt: prompt,
        imageRefs: imageRefs,
        size: "1024x1024");

    // Assert
    Assert.True(result.Success);
    Assert.NotNull(result.Images.FirstOrDefault()?.Url);
}
```

---

## 9. 实施步骤

1. **Phase 1**: 创建 Vision API 模型类
2. **Phase 2**: 实现 `GenerateWithVisionAsync` 方法
3. **Phase 3**: 修改 Worker 加载所有图片
4. **Phase 4**: 添加路由决策逻辑
5. **Phase 5**: 集成测试验证
6. **Phase 6**: 前端适配（如需）

---

## 10. 回滚方案

如果 Vision API 不稳定，可通过配置开关回退到单图模式：

```json
{
  "ImageGen": {
    "EnableVisionMultiImage": false  // 关闭后回退到只使用第一张图
  }
}
```
