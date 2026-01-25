using System.Text.Json;
using System.Text.Json.Nodes;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

/// <summary>
/// Canvas 回填逻辑测试
///
/// 关键测试场景：
/// 1. 使用 id 字段查找元素（与前端保持一致）
/// 2. running 状态的占位元素能被正确回填
/// 3. 新元素使用 id 字段创建
///
/// 运行方式：dotnet test --filter "FullyQualifiedName~CanvasPatchLogicTests"
/// </summary>
[Trait("Category", TestCategories.CI)]
[Trait("Category", TestCategories.Unit)]
public class CanvasPatchLogicTests
{
    /// <summary>
    /// 模拟后端的 TryPatchWorkspaceCanvas 核心查找逻辑
    /// </summary>
    private static bool TryFindCanvasElement(string payloadJson, string targetKey, out JsonObject? target, out JsonArray? elements)
    {
        target = null;
        elements = null;
        
        if (string.IsNullOrWhiteSpace(payloadJson)) return false;
        
        JsonNode? root;
        try { root = JsonNode.Parse(payloadJson); } catch { return false; }
        if (root == null) return false;
        
        elements = root["elements"] as JsonArray;
        if (elements == null) return false;
        
        foreach (var n in elements)
        {
            var o = n as JsonObject;
            if (o == null) continue;
            // 前端保存时使用 "id" 字段，这里也用 "id" 查找（兼容 "key" 字段以防旧数据）
            var k = (o["id"]?.GetValue<string>() ?? o["key"]?.GetValue<string>() ?? string.Empty).Trim();
            if (string.Equals(k, targetKey, StringComparison.Ordinal))
            {
                target = o;
                return true;
            }
        }
        
        return false;
    }
    
    /// <summary>
    /// 模拟后端回填元素（模拟 TryPatchWorkspaceCanvasAsync 的核心逻辑）
    /// </summary>
    private static string PatchElement(string payloadJson, string targetKey, string assetId, string url, string sha256, string prompt)
    {
        var root = JsonNode.Parse(payloadJson)!;
        var elements = root["elements"] as JsonArray;
        if (elements == null)
        {
            elements = new JsonArray();
            root["elements"] = elements;
        }
        
        JsonObject? target = null;
        foreach (var n in elements)
        {
            var o = n as JsonObject;
            if (o == null) continue;
            var k = (o["id"]?.GetValue<string>() ?? o["key"]?.GetValue<string>() ?? string.Empty).Trim();
            if (string.Equals(k, targetKey, StringComparison.Ordinal))
            {
                target = o;
                break;
            }
        }
        
        if (target == null)
        {
            // 找不到元素，创建新元素
            var newElement = new JsonObject
            {
                ["id"] = targetKey,
                ["kind"] = "image",
                ["status"] = "done",
                ["syncStatus"] = "synced",
                ["prompt"] = prompt,
                ["src"] = url,
                ["assetId"] = assetId,
                ["sha256"] = sha256,
            };
            elements.Add(newElement);
        }
        else
        {
            // 找到元素，更新属性
            target["kind"] = "image";
            target["status"] = "done";
            target["syncStatus"] = "synced";
            target["syncError"] = null;
            target["src"] = url;
            target["assetId"] = assetId;
            target["sha256"] = sha256;
            if (!string.IsNullOrWhiteSpace(prompt)) target["prompt"] = prompt;
        }
        
        return root.ToJsonString();
    }
    
    [Fact]
    public void ShouldFindElementById()
    {
        // Arrange: 前端保存的格式使用 id 字段
        var payload = """
        {
            "schemaVersion": 1,
            "elements": [
                {
                    "id": "gen_123456",
                    "kind": "image",
                    "status": "running",
                    "x": 100,
                    "y": 200,
                    "w": 1024,
                    "h": 1024
                }
            ]
        }
        """;
        
        // Act
        var found = TryFindCanvasElement(payload, "gen_123456", out var target, out _);
        
        // Assert
        Assert.True(found);
        Assert.NotNull(target);
        Assert.Equal("gen_123456", target!["id"]?.GetValue<string>());
        Assert.Equal("running", target["status"]?.GetValue<string>());
    }
    
    [Fact]
    public void ShouldFindElementByKeyForBackwardCompatibility()
    {
        // Arrange: 旧版本可能使用 key 字段
        var payload = """
        {
            "schemaVersion": 1,
            "elements": [
                {
                    "key": "old_key_format",
                    "kind": "image",
                    "status": "running"
                }
            ]
        }
        """;
        
        // Act
        var found = TryFindCanvasElement(payload, "old_key_format", out var target, out _);
        
        // Assert
        Assert.True(found);
        Assert.NotNull(target);
    }
    
    [Fact]
    public void ShouldNotFindNonExistentElement()
    {
        // Arrange
        var payload = """
        {
            "schemaVersion": 1,
            "elements": [
                {
                    "id": "existing_element",
                    "kind": "image"
                }
            ]
        }
        """;
        
        // Act
        var found = TryFindCanvasElement(payload, "non_existent_key", out var target, out _);
        
        // Assert
        Assert.False(found);
        Assert.Null(target);
    }
    
    [Fact]
    public void ShouldPatchRunningPlaceholderToDone()
    {
        // Arrange: running 状态的占位元素
        var payload = """
        {
            "schemaVersion": 1,
            "elements": [
                {
                    "id": "gen_backend_test",
                    "kind": "image",
                    "status": "running",
                    "name": "测试生成",
                    "x": 100,
                    "y": 200,
                    "w": 1024,
                    "h": 1024
                }
            ]
        }
        """;
        
        // Act: 模拟后端回填
        var patched = PatchElement(
            payload, 
            "gen_backend_test", 
            assetId: "asset-123",
            url: "https://cdn.example.com/image.png",
            sha256: "abc123sha256",
            prompt: "测试生成"
        );
        
        // Assert
        var root = JsonNode.Parse(patched);
        var elements = root!["elements"] as JsonArray;
        Assert.NotNull(elements);
        Assert.Single(elements!);
        
        var element = elements[0] as JsonObject;
        Assert.NotNull(element);
        Assert.Equal("gen_backend_test", element!["id"]?.GetValue<string>());
        Assert.Equal("done", element["status"]?.GetValue<string>());
        Assert.Equal("synced", element["syncStatus"]?.GetValue<string>());
        Assert.Equal("https://cdn.example.com/image.png", element["src"]?.GetValue<string>());
        Assert.Equal("asset-123", element["assetId"]?.GetValue<string>());
        Assert.Equal("abc123sha256", element["sha256"]?.GetValue<string>());
        
        // 原有位置信息应保留
        Assert.Equal(100, element["x"]?.GetValue<int>());
        Assert.Equal(200, element["y"]?.GetValue<int>());
        Assert.Equal(1024, element["w"]?.GetValue<int>());
        Assert.Equal(1024, element["h"]?.GetValue<int>());
    }
    
    [Fact]
    public void ShouldCreateNewElementWhenNotFound()
    {
        // Arrange: 空画布
        var payload = """
        {
            "schemaVersion": 1,
            "elements": []
        }
        """;
        
        // Act: 后端创建新元素
        var patched = PatchElement(
            payload, 
            "backend_created_element", 
            assetId: "new-asset-id",
            url: "https://cdn.example.com/new-image.png",
            sha256: "newsha256",
            prompt: "后端创建的图片"
        );
        
        // Assert
        var root = JsonNode.Parse(patched);
        var elements = root!["elements"] as JsonArray;
        Assert.NotNull(elements);
        Assert.Single(elements!);
        
        var element = elements[0] as JsonObject;
        Assert.NotNull(element);
        Assert.Equal("backend_created_element", element!["id"]?.GetValue<string>());
        Assert.Equal("done", element["status"]?.GetValue<string>());
        Assert.Equal("https://cdn.example.com/new-image.png", element["src"]?.GetValue<string>());
    }
    
    [Fact]
    public void ShouldHandleMultipleElements()
    {
        // Arrange: 多个元素
        var payload = """
        {
            "schemaVersion": 1,
            "elements": [
                {
                    "id": "done_image",
                    "kind": "image",
                    "status": "done",
                    "src": "https://existing.com/1.png"
                },
                {
                    "id": "running_placeholder",
                    "kind": "image",
                    "status": "running",
                    "name": "待生成"
                },
                {
                    "id": "generator_widget",
                    "kind": "generator",
                    "prompt": "Generator"
                }
            ]
        }
        """;
        
        // Act: 只回填 running_placeholder
        var patched = PatchElement(
            payload, 
            "running_placeholder", 
            assetId: "asset-456",
            url: "https://cdn.example.com/generated.png",
            sha256: "gensha256",
            prompt: "待生成"
        );
        
        // Assert
        var root = JsonNode.Parse(patched);
        var elements = root!["elements"] as JsonArray;
        Assert.NotNull(elements);
        Assert.Equal(3, elements!.Count);
        
        // 验证目标元素被更新
        var target = elements.FirstOrDefault(e => 
            (e as JsonObject)?["id"]?.GetValue<string>() == "running_placeholder") as JsonObject;
        Assert.NotNull(target);
        Assert.Equal("done", target!["status"]?.GetValue<string>());
        Assert.Equal("https://cdn.example.com/generated.png", target["src"]?.GetValue<string>());
        
        // 验证其他元素未受影响
        var existing = elements.FirstOrDefault(e => 
            (e as JsonObject)?["id"]?.GetValue<string>() == "done_image") as JsonObject;
        Assert.NotNull(existing);
        Assert.Equal("https://existing.com/1.png", existing!["src"]?.GetValue<string>());
        
        var generator = elements.FirstOrDefault(e => 
            (e as JsonObject)?["id"]?.GetValue<string>() == "generator_widget") as JsonObject;
        Assert.NotNull(generator);
        Assert.Equal("generator", generator!["kind"]?.GetValue<string>());
    }
    
    [Fact]
    public void ShouldHandleEmptyPayload()
    {
        // Arrange
        var payload = "";
        
        // Act
        var found = TryFindCanvasElement(payload, "any_key", out var target, out _);
        
        // Assert
        Assert.False(found);
        Assert.Null(target);
    }
    
    [Fact]
    public void ShouldHandleInvalidJson()
    {
        // Arrange
        var payload = "{ invalid json }";
        
        // Act
        var found = TryFindCanvasElement(payload, "any_key", out var target, out _);
        
        // Assert
        Assert.False(found);
        Assert.Null(target);
    }
    
    [Fact]
    public void ShouldHandleMissingElementsArray()
    {
        // Arrange
        var payload = """
        {
            "schemaVersion": 1
        }
        """;
        
        // Act
        var found = TryFindCanvasElement(payload, "any_key", out var target, out _);
        
        // Assert
        Assert.False(found);
        Assert.Null(target);
    }
    
    [Fact]
    public void ShouldPreferIdOverKey()
    {
        // Arrange: 元素同时有 id 和 key 字段
        var payload = """
        {
            "schemaVersion": 1,
            "elements": [
                {
                    "id": "correct_id",
                    "key": "legacy_key",
                    "kind": "image",
                    "status": "running"
                }
            ]
        }
        """;
        
        // Act: 用 id 查找
        var foundById = TryFindCanvasElement(payload, "correct_id", out var targetById, out _);
        
        // Act: 用 key 查找（应该找不到，因为优先使用 id）
        var foundByKey = TryFindCanvasElement(payload, "legacy_key", out var targetByKey, out _);
        
        // Assert
        Assert.True(foundById);
        Assert.NotNull(targetById);
        
        // 由于逻辑优先使用 id，legacy_key 不会被匹配
        Assert.False(foundByKey);
    }
    
    [Fact]
    public void ShouldMatchExactKey()
    {
        // Arrange
        var payload = """
        {
            "schemaVersion": 1,
            "elements": [
                {
                    "id": "gen_123",
                    "kind": "image"
                },
                {
                    "id": "gen_1234",
                    "kind": "image"
                },
                {
                    "id": "gen_12345",
                    "kind": "image"
                }
            ]
        }
        """;
        
        // Act & Assert: 精确匹配
        var found = TryFindCanvasElement(payload, "gen_1234", out var target, out _);
        Assert.True(found);
        Assert.Equal("gen_1234", target!["id"]?.GetValue<string>());
        
        // 部分匹配应该失败
        var notFound = TryFindCanvasElement(payload, "gen_12", out _, out _);
        Assert.False(notFound);
    }
    
    [Fact]
    public void RoundtripScenario_UserGeneratesImage_ClosesPage_BackendBackfills_UserReopens()
    {
        // 场景：用户点击生成 -> 前端保存 running 占位 -> 用户关闭页面 -> 后端完成生成并回填 -> 用户重新打开看到图片
        
        // Step 1: 前端保存 running 占位（模拟 canvasToPersistedV1 的输出）
        var frontendSavedPayload = """
        {
            "schemaVersion": 1,
            "meta": { "skippedLocalOnlyImages": 0 },
            "elements": [
                {
                    "id": "gen_roundtrip_test",
                    "kind": "image",
                    "x": 100,
                    "y": 200,
                    "w": 1024,
                    "h": 1024,
                    "z": 0,
                    "name": "用户输入的提示词",
                    "status": "running"
                }
            ]
        }
        """;
        
        // Step 2: 验证后端能找到这个元素
        var found = TryFindCanvasElement(frontendSavedPayload, "gen_roundtrip_test", out var target, out _);
        Assert.True(found, "后端应该能通过 id 找到前端保存的 running 占位元素");
        Assert.Equal("running", target!["status"]?.GetValue<string>());
        
        // Step 3: 后端回填
        var backendPatchedPayload = PatchElement(
            frontendSavedPayload,
            "gen_roundtrip_test",
            assetId: "final-asset-id",
            url: "https://cdn.example.com/final-image.png",
            sha256: "finalsha256hash",
            prompt: "用户输入的提示词"
        );
        
        // Step 4: 验证回填结果
        var patchedRoot = JsonNode.Parse(backendPatchedPayload);
        var patchedElements = patchedRoot!["elements"] as JsonArray;
        Assert.NotNull(patchedElements);
        Assert.Single(patchedElements!);
        
        var patchedElement = patchedElements[0] as JsonObject;
        Assert.NotNull(patchedElement);
        Assert.Equal("gen_roundtrip_test", patchedElement!["id"]?.GetValue<string>());
        Assert.Equal("done", patchedElement["status"]?.GetValue<string>());
        Assert.Equal("https://cdn.example.com/final-image.png", patchedElement["src"]?.GetValue<string>());
        Assert.Equal("final-asset-id", patchedElement["assetId"]?.GetValue<string>());
        
        // 位置信息应保留
        Assert.Equal(100, patchedElement["x"]?.GetValue<int>());
        Assert.Equal(200, patchedElement["y"]?.GetValue<int>());
        Assert.Equal(1024, patchedElement["w"]?.GetValue<int>());
        Assert.Equal(1024, patchedElement["h"]?.GetValue<int>());
        
        // Step 5: 用户刷新页面，前端 persistedV1ToCanvas 应该能正确恢复
        // （这部分在前端测试中已覆盖，这里只验证后端输出的 JSON 格式正确）
        Assert.NotNull(patchedElement["assetId"]);
        Assert.NotNull(patchedElement["src"]);
        Assert.NotNull(patchedElement["sha256"]);
    }
}
