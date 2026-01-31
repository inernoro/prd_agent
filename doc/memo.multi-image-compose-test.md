# 多图组合功能测试备忘录

> 创建时间：2026-01-30 04:15
> 状态：待验证（上游生成服务临时过载）

## 当前状态

### 已完成的代码修复

1. **VLM 多模态序列化修复** (`OpenAIClient.cs`)
   - 问题：VLM 请求（图片+文字）使用 Source Generator 序列化时，图片数据被丢弃
   - 修复：检测到图片附件时，使用默认 `JsonSerializer` 而非 Source Generator

2. **多图组合服务修复** (`MultiImageComposeService.cs`)
   - 问题：只发送文字描述给 VLM，没有发送实际图片
   - 修复：通过 `LLMAttachment` 直接发送图片 URL 给 VLM

3. **图片生成客户端修复** (`OpenAIImageClient.cs`)
   - 问题：`reqObj` 是 `Dictionary<string, object>` 但代码尝试转换为类型化对象
   - 修复：在日志记录和请求发送时检查 `reqObj` 类型，分别处理

### 已验证通过

- [x] VLM 意图解析调用成功（`visual-agent.compose::vision`）
- [x] 使用 `doubao-1.5-vision-pro-250328` 模型
- [x] 正确理解多图关系并生成英文 Prompt
- [x] 生成调用正确发起（`visual-agent.compose::generation`）

### 待验证

- [ ] 图片生成完整流程（等待上游服务恢复）
- [ ] 生成的图片质量是否符合 Prompt 预期

## 下次操作步骤

### 1. 检查上游服务状态

```powershell
# 测试基本图片生成是否恢复
$body = @{
    prompt = "A cute cat"
    size = "1024x1024"
    responseFormat = "url"
} | ConvertTo-Json
Invoke-RestMethod -Uri "http://localhost:8000/api/visual-agent/image-gen/generate" -Method Post -Headers @{"X-AI-Access-Key"="123"; "X-AI-Impersonate"="admin"; "Content-Type"="application/json"} -Body $body -TimeoutSec 60
```

如果返回 `success: true`，继续下一步。

### 2. 运行完整组合测试

```powershell
# 测试完整的多图组合功能
$body = @{
    instruction = "把小猫放进房间里"
    images = @(
        @{index=1; assetId="417849bc127c45ada8c5ec0687d39679"; name="小猫"},
        @{index=2; assetId="05bd15a695a341ec89f2525313c5ef30"; name="房间"}
    )
    parseOnly = $false
    size = "1024x1024"
    responseFormat = "url"
} | ConvertTo-Json -Depth 3
$response = Invoke-RestMethod -Uri "http://localhost:8000/api/visual-agent/image-gen/compose" -Method Post -Headers @{"X-AI-Access-Key"="123"; "X-AI-Impersonate"="admin"; "Content-Type"="application/json"} -Body $body -TimeoutSec 120
$response | ConvertTo-Json -Depth 5
```

### 3. 运行集成测试

```bash
cd d:\project\prd_agent\prd_agent\prd-api
dotnet test tests/PrdAgent.Tests/PrdAgent.Tests.csproj --filter "FullyQualifiedName~FullDispatchChainTrace" -v n
```

### 4. 检查测试输出

```powershell
$latestDir = Get-ChildItem -Path "d:\project\prd_agent\prd_agent\prd-api\tests\PrdAgent.Tests\GeneratedImages\MultiImageCompose" -Directory | Sort-Object LastWriteTime -Descending | Select-Object -First 1
Get-Content "$($latestDir.FullName)\2_response.json"
Get-ChildItem $latestDir.FullName
```

预期结果：
- `2_response.json` 中 `success: true`
- 存在 `6_result_image_1.png` 文件

### 5. 如果需要切换生成模型池

当前默认生成模型池是 `nano-banana-pro`，如果持续不可用，可以切换：

```powershell
# 查看可用的生成模型池
Invoke-RestMethod -Uri "http://localhost:8000/api/mds/model-groups" -Headers @{"X-AI-Access-Key"="123"; "X-AI-Impersonate"="admin"} | ForEach-Object { $_.data } | Where-Object { $_.modelType -eq "generation" } | ForEach-Object { Write-Host "$($_.id): $($_.name) - isDefault=$($_.isDefaultForType)" }
```

## 相关文件

- 设计文档：`doc/design.multi-image-compose.md`
- 测试用例：`prd-api/tests/PrdAgent.Tests/MultiImageComposeIntegrationTests.cs`
- 组合服务：`prd-api/src/PrdAgent.Infrastructure/Services/VisualAgent/MultiImageComposeService.cs`
- 图片描述服务：`prd-api/src/PrdAgent.Infrastructure/Services/VisualAgent/ImageDescriptionService.cs`
- 控制器：`prd-api/src/PrdAgent.Api/Controllers/Api/ImageGenController.cs` (Compose 端点)

## 测试用 Asset IDs

| ID | 名称 | URL |
|----|------|-----|
| 417849bc127c45ada8c5ec0687d39679 | 可爱小猫 | https://i.pa.759800.com/visual-agent/img/s4kazw6vyngzemeijgjx72epve.jpg |
| 05bd15a695a341ec89f2525313c5ef30 | 场景图2 | https://i.pa.759800.com/visual-agent/img/pgiq7lh7w5r53lhr3dwmwepeg4.jpg |
| c79b14d5028f45449d58975296b04c79 | 场景图3 | https://i.pa.759800.com/visual-agent/img/bxiiju255eibrplott7vsfj7wa.jpg |

## 模型池配置

| 用途 | 模型池名称 | 模型 | isDefaultForType |
|------|-----------|------|------------------|
| Vision | grok-4 | doubao-1.5-vision-pro-250328 | true |
| Generation | nano-banana-pro | nano-banana-pro | true |
