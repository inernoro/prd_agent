using System.Text.Json;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.LlmGateway;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

/// <summary>
/// 图片引用日志 & 消息服务器权威持久化 — 测试
///
/// 验证场景：
/// 1. LlmImageReference 模型正确性
/// 2. GatewayRequestContext.ImageReferences 传递
/// 3. LlmLogStart.ImageReferences 传递
/// 4. LlmRequestLog.ImageReferences 存储
/// 5. GEN_DONE / GEN_ERROR 消息格式正确性
/// 6. SaveWorkspaceMessage 内容截断
/// </summary>
public class ImageRefAndMessagePersistenceTests
{
    #region LlmImageReference 模型测试

    [Fact]
    public void LlmImageReference_ShouldHaveAllProperties()
    {
        var imgRef = new LlmImageReference
        {
            Sha256 = "abc123def456",
            CosUrl = "https://cos.example.com/images/abc123.png",
            Label = "参考图",
            MimeType = "image/png",
            SizeBytes = 102400
        };

        Assert.Equal("abc123def456", imgRef.Sha256);
        Assert.Equal("https://cos.example.com/images/abc123.png", imgRef.CosUrl);
        Assert.Equal("参考图", imgRef.Label);
        Assert.Equal("image/png", imgRef.MimeType);
        Assert.Equal(102400, imgRef.SizeBytes);
    }

    [Fact]
    public void LlmImageReference_ShouldAllowNullProperties()
    {
        var imgRef = new LlmImageReference();

        Assert.Null(imgRef.Sha256);
        Assert.Null(imgRef.CosUrl);
        Assert.Null(imgRef.Label);
        Assert.Null(imgRef.MimeType);
        Assert.Null(imgRef.SizeBytes);
    }

    [Fact]
    public void LlmImageReference_ShouldSerializeToJson()
    {
        var imgRef = new LlmImageReference
        {
            Sha256 = "abc123",
            CosUrl = "https://cos.example.com/img.png",
            Label = "蒙版",
            MimeType = "image/jpeg"
        };

        var json = JsonSerializer.Serialize(imgRef, new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase });

        Assert.Contains("\"sha256\":\"abc123\"", json);
        Assert.Contains("\"cosUrl\":\"https://cos.example.com/img.png\"", json);
        Assert.Contains("\"label\":\"蒙版\"", json);
        Assert.Contains("\"mimeType\":\"image/jpeg\"", json);
    }

    [Fact]
    public void LlmImageReference_ShouldDeserializeFromJson()
    {
        var json = """{"sha256":"def789","cosUrl":"https://cdn.example.com/pic.png","label":"原图","mimeType":"image/png","sizeBytes":51200}""";

        var imgRef = JsonSerializer.Deserialize<LlmImageReference>(json, new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase });

        Assert.NotNull(imgRef);
        Assert.Equal("def789", imgRef!.Sha256);
        Assert.Equal("https://cdn.example.com/pic.png", imgRef.CosUrl);
        Assert.Equal("原图", imgRef.Label);
        Assert.Equal("image/png", imgRef.MimeType);
        Assert.Equal(51200, imgRef.SizeBytes);
    }

    #endregion

    #region LlmRequestLog.ImageReferences 测试

    [Fact]
    public void LlmRequestLog_ShouldStoreImageReferences()
    {
        var log = new LlmRequestLog
        {
            Id = "log-001",
            RequestId = "req-001",
            Provider = "OpenAI",
            Model = "dall-e-3",
            ImageReferences = new List<LlmImageReference>
            {
                new() { Sha256 = "sha1", CosUrl = "https://cos.example.com/1.png", Label = "参考图", MimeType = "image/png" },
                new() { Sha256 = "sha2", CosUrl = "https://cos.example.com/2.png", Label = "蒙版", MimeType = "image/png" }
            }
        };

        Assert.NotNull(log.ImageReferences);
        Assert.Equal(2, log.ImageReferences!.Count);
        Assert.Equal("sha1", log.ImageReferences[0].Sha256);
        Assert.Equal("sha2", log.ImageReferences[1].Sha256);
    }

    [Fact]
    public void LlmRequestLog_ImageReferences_ShouldDefaultToNull()
    {
        var log = new LlmRequestLog();
        Assert.Null(log.ImageReferences);
    }

    [Fact]
    public void LlmRequestLog_ImageReferences_ShouldSerializeRoundTrip()
    {
        var original = new LlmRequestLog
        {
            Id = "log-rt",
            RequestId = "req-rt",
            Provider = "test",
            Model = "test-model",
            ImageReferences = new List<LlmImageReference>
            {
                new() { Sha256 = "abc", CosUrl = "https://example.com/abc.png", Label = "风格图" }
            }
        };

        var opts = new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };
        var json = JsonSerializer.Serialize(original, opts);
        var deserialized = JsonSerializer.Deserialize<LlmRequestLog>(json, opts);

        Assert.NotNull(deserialized?.ImageReferences);
        Assert.Single(deserialized!.ImageReferences!);
        Assert.Equal("abc", deserialized.ImageReferences![0].Sha256);
        Assert.Equal("https://example.com/abc.png", deserialized.ImageReferences[0].CosUrl);
        Assert.Equal("风格图", deserialized.ImageReferences[0].Label);
    }

    #endregion

    #region GatewayRequestContext.ImageReferences 传递测试

    [Fact]
    public void GatewayRequestContext_ShouldAcceptImageReferences()
    {
        var refs = new List<LlmImageReference>
        {
            new() { Sha256 = "sha-ctx-1", CosUrl = "https://cos.example.com/ctx1.png", Label = "参考图1" },
            new() { Sha256 = "sha-ctx-2", CosUrl = "https://cos.example.com/ctx2.png", Label = "参考图2" }
        };

        var ctx = new GatewayRequestContext
        {
            RequestId = "req-ctx",
            UserId = "user-1",
            ImageReferences = refs
        };

        Assert.NotNull(ctx.ImageReferences);
        Assert.Equal(2, ctx.ImageReferences!.Count);
        Assert.Equal("sha-ctx-1", ctx.ImageReferences[0].Sha256);
        Assert.Equal("sha-ctx-2", ctx.ImageReferences[1].Sha256);
    }

    [Fact]
    public void GatewayRequestContext_ImageReferences_ShouldDefaultToNull()
    {
        var ctx = new GatewayRequestContext { RequestId = "req-empty" };
        Assert.Null(ctx.ImageReferences);
    }

    [Fact]
    public void GatewayRequest_ShouldPassContextWithImageReferences()
    {
        var request = new GatewayRequest
        {
            AppCallerCode = "visual-agent.image.vision::generation",
            ModelType = "generation",
            Context = new GatewayRequestContext
            {
                ImageReferences = new List<LlmImageReference>
                {
                    new() { Sha256 = "sha-gw", CosUrl = "https://cos.example.com/gw.png" }
                }
            }
        };

        Assert.NotNull(request.Context?.ImageReferences);
        Assert.Single(request.Context!.ImageReferences!);
        Assert.Equal("sha-gw", request.Context.ImageReferences![0].Sha256);
    }

    #endregion

    #region LlmLogStart.ImageReferences 传递测试

    [Fact]
    public void LlmLogStart_ShouldAcceptImageReferences()
    {
        var refs = new List<LlmImageReference>
        {
            new() { Sha256 = "sha-log", CosUrl = "https://cos.example.com/log.png", Label = "参考图", MimeType = "image/png", SizeBytes = 1024 }
        };

        var logStart = new LlmLogStart(
            RequestId: "req-log",
            Provider: "OpenAI",
            Model: "dall-e-3",
            ApiBase: "https://api.openai.com",
            Path: "/v1/images/generations",
            HttpMethod: "POST",
            RequestHeadersRedacted: null,
            RequestBodyRedacted: "{}",
            RequestBodyHash: null,
            QuestionText: null,
            SystemPromptChars: null,
            SystemPromptHash: null,
            SystemPromptText: null,
            MessageCount: null,
            GroupId: null,
            SessionId: null,
            UserId: "admin-1",
            ViewRole: "ADMIN",
            DocumentChars: null,
            DocumentHash: null,
            UserPromptChars: null,
            StartedAt: DateTime.UtcNow,
            RequestType: "imageGen",
            ImageReferences: refs
        );

        Assert.NotNull(logStart.ImageReferences);
        Assert.Single(logStart.ImageReferences!);
        Assert.Equal("sha-log", logStart.ImageReferences![0].Sha256);
        Assert.Equal("https://cos.example.com/log.png", logStart.ImageReferences[0].CosUrl);
    }

    [Fact]
    public void LlmLogStart_ImageReferences_ShouldDefaultToNull()
    {
        var logStart = new LlmLogStart(
            RequestId: "req-null",
            Provider: "test",
            Model: "test",
            ApiBase: null,
            Path: null,
            HttpMethod: null,
            RequestHeadersRedacted: null,
            RequestBodyRedacted: "{}",
            RequestBodyHash: null,
            QuestionText: null,
            SystemPromptChars: null,
            SystemPromptHash: null,
            SystemPromptText: null,
            MessageCount: null,
            GroupId: null,
            SessionId: null,
            UserId: null,
            ViewRole: null,
            DocumentChars: null,
            DocumentHash: null,
            UserPromptChars: null,
            StartedAt: DateTime.UtcNow
        );

        Assert.Null(logStart.ImageReferences);
    }

    #endregion

    #region GEN_DONE / GEN_ERROR 消息格式测试

    private static readonly JsonSerializerOptions CamelCaseJsonOptions = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

    [Fact]
    public void GenDoneMessage_ShouldContainAllRequiredFields()
    {
        var payload = new
        {
            src = "https://cos.example.com/result.png",
            refSrc = "https://cos.example.com/ref.png",
            prompt = "画一只猫",
            runId = "run-123",
            modelPool = "dall-e-pool",
            genType = "img2img",
            imageRefShas = new List<string?> { "sha-ref1" }
        };

        var content = $"[GEN_DONE]{JsonSerializer.Serialize(payload, CamelCaseJsonOptions)}";

        Assert.StartsWith("[GEN_DONE]", content);
        Assert.Contains("\"src\":", content);
        Assert.Contains("\"refSrc\":", content);
        Assert.Contains("\"prompt\":", content);
        Assert.Contains("\"runId\":", content);
        Assert.Contains("\"modelPool\":", content);
        Assert.Contains("\"genType\":\"img2img\"", content);
        Assert.Contains("\"imageRefShas\":", content);
    }

    [Fact]
    public void GenErrorMessage_ShouldContainAllRequiredFields()
    {
        var payload = new
        {
            msg = "生图失败：超时",
            refSrc = "https://cos.example.com/ref.png",
            prompt = "画一只狗",
            runId = "run-456",
            modelPool = "flux-pool",
            genType = "text2img",
            imageRefShas = (List<string?>?)null
        };

        var content = $"[GEN_ERROR]{JsonSerializer.Serialize(payload, CamelCaseJsonOptions)}";

        Assert.StartsWith("[GEN_ERROR]", content);
        Assert.Contains("\"msg\":", content);
        Assert.Contains("\"refSrc\":", content);
        Assert.Contains("\"prompt\":", content);
        Assert.Contains("\"runId\":", content);
        Assert.Contains("\"genType\":\"text2img\"", content);
    }

    [Theory]
    [InlineData(0, "text2img")]   // 无参考图 → text2img
    [InlineData(1, "img2img")]    // 单图 → img2img
    [InlineData(2, "vision")]     // 多图 → vision
    [InlineData(3, "vision")]     // 3张图 → vision
    public void GenType_ShouldMatchImageRefCount(int imageRefCount, string expectedGenType)
    {
        // 模拟 Worker 中的 genType 计算逻辑
        var genType = imageRefCount > 1 ? "vision" : (imageRefCount == 1 ? "img2img" : "text2img");
        Assert.Equal(expectedGenType, genType);
    }

    [Fact]
    public void GenDoneMessage_ShouldParseCorrectly()
    {
        var json = """{"src":"https://cdn.com/img.png","refSrc":"https://cdn.com/ref.png","prompt":"test","runId":"run-1","modelPool":"pool","genType":"vision","imageRefShas":["sha1","sha2"]}""";
        var content = $"[GEN_DONE]{json}";

        // 模拟前端解析逻辑
        Assert.True(content.StartsWith("[GEN_DONE]"));
        var jsonPart = content["[GEN_DONE]".Length..];

        var parsed = JsonSerializer.Deserialize<JsonElement>(jsonPart);
        Assert.Equal("https://cdn.com/img.png", parsed.GetProperty("src").GetString());
        Assert.Equal("https://cdn.com/ref.png", parsed.GetProperty("refSrc").GetString());
        Assert.Equal("test", parsed.GetProperty("prompt").GetString());
        Assert.Equal("run-1", parsed.GetProperty("runId").GetString());
        Assert.Equal("pool", parsed.GetProperty("modelPool").GetString());
        Assert.Equal("vision", parsed.GetProperty("genType").GetString());
        Assert.Equal(2, parsed.GetProperty("imageRefShas").GetArrayLength());
    }

    [Fact]
    public void GenErrorMessage_ShouldParseCorrectly()
    {
        var json = """{"msg":"超时","refSrc":"https://cdn.com/ref.png","prompt":"test","runId":"run-2","modelPool":"pool","genType":"img2img","imageRefShas":["sha1"]}""";
        var content = $"[GEN_ERROR]{json}";

        Assert.True(content.StartsWith("[GEN_ERROR]"));
        var jsonPart = content["[GEN_ERROR]".Length..];

        var parsed = JsonSerializer.Deserialize<JsonElement>(jsonPart);
        Assert.Equal("超时", parsed.GetProperty("msg").GetString());
        Assert.Equal("img2img", parsed.GetProperty("genType").GetString());
    }

    #endregion

    #region GenDone refSrc 来源测试

    [Fact]
    public void GenDone_RefSrc_ShouldBeFirstImageRefCosUrl()
    {
        // 模拟 Worker 中 doneRefSrc 的计算逻辑
        var loadedImageRefs = new List<FakeImageRefData>
        {
            new() { CosUrl = "https://cos.example.com/ref1.png", Sha256 = "sha1" },
            new() { CosUrl = "https://cos.example.com/ref2.png", Sha256 = "sha2" }
        };

        var doneRefSrc = loadedImageRefs.FirstOrDefault()?.CosUrl;

        Assert.Equal("https://cos.example.com/ref1.png", doneRefSrc);
    }

    [Fact]
    public void GenDone_RefSrc_ShouldBeNullWhenNoImageRefs()
    {
        var loadedImageRefs = new List<FakeImageRefData>();

        var doneRefSrc = loadedImageRefs.FirstOrDefault()?.CosUrl;

        Assert.Null(doneRefSrc);
    }

    [Fact]
    public void GenDone_ImageRefShas_ShouldFilterEmptyShas()
    {
        var loadedImageRefs = new List<FakeImageRefData>
        {
            new() { Sha256 = "sha1", CosUrl = "url1" },
            new() { Sha256 = null, CosUrl = "url2" },
            new() { Sha256 = "", CosUrl = "url3" },
            new() { Sha256 = "sha4", CosUrl = "url4" }
        };

        // 模拟 Worker 中 doneImageRefShas 的计算逻辑
        var doneImageRefShas = loadedImageRefs.Count > 0
            ? loadedImageRefs.Select(r => r.Sha256).Where(s => !string.IsNullOrEmpty(s)).ToList()
            : null;

        Assert.NotNull(doneImageRefShas);
        Assert.Equal(2, doneImageRefShas!.Count);
        Assert.Contains("sha1", doneImageRefShas);
        Assert.Contains("sha4", doneImageRefShas);
    }

    #endregion

    #region 消息内容截断测试

    [Fact]
    public void MessageContent_ShouldTruncateAt64KB()
    {
        // 模拟 SaveWorkspaceMessageAsync 中的截断逻辑
        var longContent = new string('A', 100_000); // 100KB
        var maxLen = 64 * 1024;

        var stored = longContent.Length > maxLen ? longContent[..maxLen] : longContent;

        Assert.Equal(maxLen, stored.Length);
    }

    [Fact]
    public void MessageContent_ShouldNotTruncateShortContent()
    {
        var shortContent = "画一只猫";
        var maxLen = 64 * 1024;

        var stored = shortContent.Length > maxLen ? shortContent[..maxLen] : shortContent;

        Assert.Equal("画一只猫", stored);
    }

    [Fact]
    public void UserMessageContent_ShouldFallbackToPrompt()
    {
        // 模拟 Controller 中的 fallback 逻辑
        string? userMessageContent = null;
        var prompt = "画一只可爱的猫咪";

        var content = !string.IsNullOrWhiteSpace(userMessageContent)
            ? userMessageContent!.Trim()
            : prompt;

        Assert.Equal("画一只可爱的猫咪", content);
    }

    [Fact]
    public void UserMessageContent_ShouldPreferExplicitContent()
    {
        // 模拟 Controller 中的 fallback 逻辑
        string? userMessageContent = "[局部重绘]@img1 画一只可爱的猫咪";
        var prompt = "画一只可爱的猫咪";

        var content = !string.IsNullOrWhiteSpace(userMessageContent)
            ? userMessageContent!.Trim()
            : prompt;

        Assert.Equal("[局部重绘]@img1 画一只可爱的猫咪", content);
    }

    #endregion

    #region ImageReferences 从 ImageRefData 转换测试

    [Fact]
    public void ImageReferences_ShouldBuildFromImageRefData()
    {
        // 模拟 OpenAIImageClient 中构建 ImageReferences 的逻辑
        var imageRefs = new List<FakeImageRefData>
        {
            new() { Sha256 = "sha1", CosUrl = "https://cos.example.com/1.png", Label = "参考图", MimeType = "image/png" },
            new() { Sha256 = "sha2", CosUrl = "https://cos.example.com/2.png", Label = "蒙版", MimeType = "image/jpeg" }
        };

        var llmImageRefs = imageRefs.Select(r => new LlmImageReference
        {
            Sha256 = r.Sha256,
            CosUrl = r.CosUrl,
            Label = r.Label,
            MimeType = r.MimeType
        }).ToList();

        Assert.Equal(2, llmImageRefs.Count);
        Assert.Equal("sha1", llmImageRefs[0].Sha256);
        Assert.Equal("https://cos.example.com/1.png", llmImageRefs[0].CosUrl);
        Assert.Equal("参考图", llmImageRefs[0].Label);
        Assert.Equal("image/png", llmImageRefs[0].MimeType);
        Assert.Equal("sha2", llmImageRefs[1].Sha256);
        Assert.Equal("https://cos.example.com/2.png", llmImageRefs[1].CosUrl);
    }

    [Fact]
    public void ImageReferences_EmptyList_ShouldResultInEmptyList()
    {
        var imageRefs = new List<FakeImageRefData>();

        var llmImageRefs = imageRefs.Select(r => new LlmImageReference
        {
            Sha256 = r.Sha256,
            CosUrl = r.CosUrl
        }).ToList();

        Assert.Empty(llmImageRefs);
    }

    #endregion

    #region 端到端数据流验证

    [Fact]
    public void EndToEnd_ImageReferences_ShouldFlowFromContextToLog()
    {
        // 1. 构建图片引用（模拟 OpenAIImageClient）
        var imageRefs = new List<LlmImageReference>
        {
            new() { Sha256 = "e2e-sha1", CosUrl = "https://cos.example.com/e2e1.png", Label = "参考图1", MimeType = "image/png" },
            new() { Sha256 = "e2e-sha2", CosUrl = "https://cos.example.com/e2e2.png", Label = "参考图2", MimeType = "image/jpeg" }
        };

        // 2. 放入 GatewayRequestContext
        var ctx = new GatewayRequestContext
        {
            RequestId = "e2e-req",
            UserId = "e2e-user",
            ImageReferences = imageRefs
        };

        // 3. 传递给 GatewayRequest
        var request = new GatewayRequest
        {
            AppCallerCode = "visual-agent.image.vision::generation",
            ModelType = "generation",
            Context = ctx
        };

        // 4. 构建 LlmLogStart（模拟 LlmGateway.WriteStartLogAsync）
        var logStart = new LlmLogStart(
            RequestId: request.Context!.RequestId!,
            Provider: "OpenAI",
            Model: "dall-e-3",
            ApiBase: "https://api.openai.com",
            Path: "/v1/images/generations",
            HttpMethod: "POST",
            RequestHeadersRedacted: null,
            RequestBodyRedacted: "{}",
            RequestBodyHash: null,
            QuestionText: null,
            SystemPromptChars: null,
            SystemPromptHash: null,
            SystemPromptText: null,
            MessageCount: null,
            GroupId: null,
            SessionId: null,
            UserId: request.Context.UserId,
            ViewRole: "ADMIN",
            DocumentChars: null,
            DocumentHash: null,
            UserPromptChars: null,
            StartedAt: DateTime.UtcNow,
            RequestType: "imageGen",
            RequestPurpose: request.AppCallerCode,
            ImageReferences: request.Context.ImageReferences
        );

        // 5. 构建 LlmRequestLog（模拟 LlmRequestLogWriter.StartAsync）
        var log = new LlmRequestLog
        {
            Id = Guid.NewGuid().ToString(),
            RequestId = logStart.RequestId,
            Provider = logStart.Provider,
            Model = logStart.Model,
            UserId = logStart.UserId,
            RequestType = logStart.RequestType,
            RequestPurpose = logStart.RequestPurpose,
            ImageReferences = logStart.ImageReferences
        };

        // 6. 验证完整传递链
        Assert.NotNull(log.ImageReferences);
        Assert.Equal(2, log.ImageReferences!.Count);
        Assert.Equal("e2e-sha1", log.ImageReferences[0].Sha256);
        Assert.Equal("https://cos.example.com/e2e1.png", log.ImageReferences[0].CosUrl);
        Assert.Equal("参考图1", log.ImageReferences[0].Label);
        Assert.Equal("e2e-sha2", log.ImageReferences[1].Sha256);
        Assert.Equal("https://cos.example.com/e2e2.png", log.ImageReferences[1].CosUrl);
        Assert.Equal("参考图2", log.ImageReferences[1].Label);
    }

    [Fact]
    public void EndToEnd_NullImageReferences_ShouldPassThrough()
    {
        var ctx = new GatewayRequestContext
        {
            RequestId = "e2e-null",
            ImageReferences = null
        };

        var logStart = new LlmLogStart(
            RequestId: "e2e-null",
            Provider: "test",
            Model: "test",
            ApiBase: null,
            Path: null,
            HttpMethod: null,
            RequestHeadersRedacted: null,
            RequestBodyRedacted: "{}",
            RequestBodyHash: null,
            QuestionText: null,
            SystemPromptChars: null,
            SystemPromptHash: null,
            SystemPromptText: null,
            MessageCount: null,
            GroupId: null,
            SessionId: null,
            UserId: null,
            ViewRole: null,
            DocumentChars: null,
            DocumentHash: null,
            UserPromptChars: null,
            StartedAt: DateTime.UtcNow,
            ImageReferences: ctx.ImageReferences
        );

        var log = new LlmRequestLog
        {
            ImageReferences = logStart.ImageReferences
        };

        Assert.Null(log.ImageReferences);
    }

    #endregion

    #region ImageMasterMessage 模型测试

    [Fact]
    public void ImageMasterMessage_ShouldSetCorrectRoles()
    {
        // User 消息（Controller 保存）
        var userMsg = new ImageMasterMessage
        {
            Id = Guid.NewGuid().ToString("N"),
            WorkspaceId = "ws-1",
            OwnerUserId = "admin-1",
            Role = "User",
            Content = "画一只猫",
            CreatedAt = DateTime.UtcNow
        };
        Assert.Equal("User", userMsg.Role);

        // Assistant 消息（Worker 保存）
        var assistantMsg = new ImageMasterMessage
        {
            Id = Guid.NewGuid().ToString("N"),
            WorkspaceId = "ws-1",
            OwnerUserId = "admin-1",
            Role = "Assistant",
            Content = "[GEN_DONE]{...}",
            CreatedAt = DateTime.UtcNow
        };
        Assert.Equal("Assistant", assistantMsg.Role);
    }

    [Fact]
    public void ImageMasterMessage_Id_ShouldBeFormatN()
    {
        var id = Guid.NewGuid().ToString("N");

        // Format "N" should produce 32 hex chars without hyphens
        Assert.Equal(32, id.Length);
        Assert.DoesNotContain("-", id);
    }

    #endregion

    #region LlmLogImage 模型测试

    [Fact]
    public void LlmLogImage_ShouldHaveAllProperties()
    {
        var img = new LlmLogImage
        {
            Url = "https://cos.example.com/display.png",
            OriginalUrl = "https://cos.example.com/original.png",
            Label = "生成结果",
            Sha256 = "abc123"
        };

        Assert.Equal("https://cos.example.com/display.png", img.Url);
        Assert.Equal("https://cos.example.com/original.png", img.OriginalUrl);
        Assert.Equal("生成结果", img.Label);
        Assert.Equal("abc123", img.Sha256);
    }

    [Fact]
    public void LlmLogImage_ShouldDefaultUrlToEmpty()
    {
        var img = new LlmLogImage();

        Assert.Equal(string.Empty, img.Url);
        Assert.Null(img.OriginalUrl);
        Assert.Null(img.Label);
        Assert.Null(img.Sha256);
    }

    [Fact]
    public void LlmLogImage_ShouldSerializeRoundTrip()
    {
        var original = new LlmLogImage
        {
            Url = "https://cos.example.com/img.png",
            OriginalUrl = "https://cos.example.com/orig.png",
            Label = "参考图",
            Sha256 = "deadbeef"
        };

        var opts = new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };
        var json = JsonSerializer.Serialize(original, opts);
        var deserialized = JsonSerializer.Deserialize<LlmLogImage>(json, opts);

        Assert.NotNull(deserialized);
        Assert.Equal("https://cos.example.com/img.png", deserialized!.Url);
        Assert.Equal("https://cos.example.com/orig.png", deserialized.OriginalUrl);
        Assert.Equal("参考图", deserialized.Label);
        Assert.Equal("deadbeef", deserialized.Sha256);
    }

    #endregion

    #region LlmRequestLog.InputImages / OutputImages 测试

    [Fact]
    public void LlmRequestLog_InputOutputImages_ShouldDefaultToNull()
    {
        var log = new LlmRequestLog();

        Assert.Null(log.InputImages);
        Assert.Null(log.OutputImages);
    }

    [Fact]
    public void LlmRequestLog_ShouldStoreInputImages()
    {
        var log = new LlmRequestLog
        {
            Id = "log-input",
            RequestId = "run-001-0-0",
            Provider = "OpenAI",
            Model = "dall-e-3",
            InputImages = new List<LlmLogImage>
            {
                new() { Url = "https://cos.example.com/ref1.png", Label = "参考图", Sha256 = "sha-ref1" },
                new() { Url = "https://cos.example.com/ref2.png", Label = "蒙版", Sha256 = "sha-ref2" }
            }
        };

        Assert.NotNull(log.InputImages);
        Assert.Equal(2, log.InputImages!.Count);
        Assert.Equal("https://cos.example.com/ref1.png", log.InputImages[0].Url);
        Assert.Equal("参考图", log.InputImages[0].Label);
        Assert.Equal("https://cos.example.com/ref2.png", log.InputImages[1].Url);
    }

    [Fact]
    public void LlmRequestLog_ShouldStoreOutputImages()
    {
        var log = new LlmRequestLog
        {
            Id = "log-output",
            RequestId = "run-002-0-0",
            Provider = "OpenAI",
            Model = "dall-e-3",
            OutputImages = new List<LlmLogImage>
            {
                new() { Url = "https://cos.example.com/gen-wm.png", OriginalUrl = "https://cos.example.com/gen-orig.png", Label = "生成结果", Sha256 = "sha-gen" }
            }
        };

        Assert.NotNull(log.OutputImages);
        Assert.Single(log.OutputImages!);
        Assert.Equal("https://cos.example.com/gen-wm.png", log.OutputImages[0].Url);
        Assert.Equal("https://cos.example.com/gen-orig.png", log.OutputImages[0].OriginalUrl);
    }

    [Fact]
    public void LlmRequestLog_InputOutputImages_ShouldSerializeRoundTrip()
    {
        var original = new LlmRequestLog
        {
            Id = "log-rt2",
            RequestId = "run-rt-0-0",
            Provider = "test",
            Model = "test-model",
            InputImages = new List<LlmLogImage>
            {
                new() { Url = "https://cos.example.com/in.png", Label = "风格参考", Sha256 = "sha-in" }
            },
            OutputImages = new List<LlmLogImage>
            {
                new() { Url = "https://cos.example.com/out-wm.png", OriginalUrl = "https://cos.example.com/out.png", Label = "生成结果", Sha256 = "sha-out" }
            }
        };

        var opts = new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };
        var json = JsonSerializer.Serialize(original, opts);
        var deserialized = JsonSerializer.Deserialize<LlmRequestLog>(json, opts);

        Assert.NotNull(deserialized?.InputImages);
        Assert.Single(deserialized!.InputImages!);
        Assert.Equal("https://cos.example.com/in.png", deserialized.InputImages![0].Url);
        Assert.Equal("风格参考", deserialized.InputImages[0].Label);

        Assert.NotNull(deserialized.OutputImages);
        Assert.Single(deserialized.OutputImages!);
        Assert.Equal("https://cos.example.com/out-wm.png", deserialized.OutputImages![0].Url);
        Assert.Equal("https://cos.example.com/out.png", deserialized.OutputImages[0].OriginalUrl);
    }

    #endregion

    #region PatchLogImages 映射逻辑测试

    [Fact]
    public void PatchLogImages_InputMapping_ShouldPreferRunImageRefUrl()
    {
        // 模拟 PatchLogImagesAsync：run.ImageRefs.Url 优先于 loadedImageRefs.CosUrl
        var runImageRefs = new List<FakeImageRefInput>
        {
            new() { RefId = 1, Url = "https://cos.example.com/frontend-uploaded.png", AssetSha256 = "sha-frontend", Label = "参考图" }
        };
        var loadedImageRefs = new List<FakeImageRefData>
        {
            new() { RefId = 1, CosUrl = "https://cos.example.com/loaded-fallback.png", Sha256 = "sha-loaded" }
        };

        var inputs = new List<LlmLogImage>();
        foreach (var r in runImageRefs)
        {
            var cosUrl = !string.IsNullOrWhiteSpace(r.Url) ? r.Url
                : loadedImageRefs.FirstOrDefault(lr => lr.RefId == r.RefId)?.CosUrl;
            if (string.IsNullOrWhiteSpace(cosUrl)) continue;
            inputs.Add(new LlmLogImage
            {
                Url = cosUrl!,
                Label = r.Label,
                Sha256 = !string.IsNullOrWhiteSpace(r.AssetSha256) ? r.AssetSha256
                    : loadedImageRefs.FirstOrDefault(lr => lr.RefId == r.RefId)?.Sha256
            });
        }

        Assert.Single(inputs);
        Assert.Equal("https://cos.example.com/frontend-uploaded.png", inputs[0].Url);
        Assert.Equal("sha-frontend", inputs[0].Sha256);
        Assert.Equal("参考图", inputs[0].Label);
    }

    [Fact]
    public void PatchLogImages_InputMapping_ShouldFallbackToLoadedCosUrl()
    {
        // 当 run.ImageRefs.Url 为空时，回退到 loadedImageRefs.CosUrl
        var runImageRefs = new List<FakeImageRefInput>
        {
            new() { RefId = 1, Url = null, AssetSha256 = null, Label = "手绘草图" }
        };
        var loadedImageRefs = new List<FakeImageRefData>
        {
            new() { RefId = 1, CosUrl = "https://cos.example.com/loaded.png", Sha256 = "sha-loaded" }
        };

        var inputs = new List<LlmLogImage>();
        foreach (var r in runImageRefs)
        {
            var cosUrl = !string.IsNullOrWhiteSpace(r.Url) ? r.Url
                : loadedImageRefs.FirstOrDefault(lr => lr.RefId == r.RefId)?.CosUrl;
            if (string.IsNullOrWhiteSpace(cosUrl)) continue;
            inputs.Add(new LlmLogImage
            {
                Url = cosUrl!,
                Label = r.Label,
                Sha256 = !string.IsNullOrWhiteSpace(r.AssetSha256) ? r.AssetSha256
                    : loadedImageRefs.FirstOrDefault(lr => lr.RefId == r.RefId)?.Sha256
            });
        }

        Assert.Single(inputs);
        Assert.Equal("https://cos.example.com/loaded.png", inputs[0].Url);
        Assert.Equal("sha-loaded", inputs[0].Sha256);
        Assert.Equal("手绘草图", inputs[0].Label);
    }

    [Fact]
    public void PatchLogImages_InputMapping_ShouldSkipWhenNoCosUrl()
    {
        // 当 run.ImageRefs.Url 和 loadedImageRefs.CosUrl 都为空时跳过
        var runImageRefs = new List<FakeImageRefInput>
        {
            new() { RefId = 1, Url = null, AssetSha256 = null, Label = "无URL参考图" }
        };
        var loadedImageRefs = new List<FakeImageRefData>
        {
            new() { RefId = 2, CosUrl = "https://cos.example.com/different-ref.png", Sha256 = "sha-other" }
        };

        var inputs = new List<LlmLogImage>();
        foreach (var r in runImageRefs)
        {
            var cosUrl = !string.IsNullOrWhiteSpace(r.Url) ? r.Url
                : loadedImageRefs.FirstOrDefault(lr => lr.RefId == r.RefId)?.CosUrl;
            if (string.IsNullOrWhiteSpace(cosUrl)) continue;
            inputs.Add(new LlmLogImage { Url = cosUrl!, Label = r.Label });
        }

        Assert.Empty(inputs);
    }

    [Fact]
    public void PatchLogImages_InputMapping_MultipleRefs()
    {
        // 多图参考：vision 模式
        var runImageRefs = new List<FakeImageRefInput>
        {
            new() { RefId = 1, Url = "https://cos.example.com/ref1.png", AssetSha256 = "sha1", Label = "风格参考" },
            new() { RefId = 2, Url = "https://cos.example.com/ref2.png", AssetSha256 = "sha2", Label = "构图参考" },
            new() { RefId = 3, Url = null, AssetSha256 = null, Label = "蒙版" }
        };
        var loadedImageRefs = new List<FakeImageRefData>
        {
            new() { RefId = 1, CosUrl = "url1", Sha256 = "s1" },
            new() { RefId = 2, CosUrl = "url2", Sha256 = "s2" },
            new() { RefId = 3, CosUrl = "https://cos.example.com/mask.png", Sha256 = "sha3" }
        };

        var inputs = new List<LlmLogImage>();
        foreach (var r in runImageRefs)
        {
            var cosUrl = !string.IsNullOrWhiteSpace(r.Url) ? r.Url
                : loadedImageRefs.FirstOrDefault(lr => lr.RefId == r.RefId)?.CosUrl;
            if (string.IsNullOrWhiteSpace(cosUrl)) continue;
            inputs.Add(new LlmLogImage
            {
                Url = cosUrl!,
                Label = r.Label,
                Sha256 = !string.IsNullOrWhiteSpace(r.AssetSha256) ? r.AssetSha256
                    : loadedImageRefs.FirstOrDefault(lr => lr.RefId == r.RefId)?.Sha256
            });
        }

        Assert.Equal(3, inputs.Count);
        Assert.Equal("https://cos.example.com/ref1.png", inputs[0].Url);
        Assert.Equal("sha1", inputs[0].Sha256);
        Assert.Equal("https://cos.example.com/ref2.png", inputs[1].Url);
        Assert.Equal("sha2", inputs[1].Sha256);
        Assert.Equal("https://cos.example.com/mask.png", inputs[2].Url);
        Assert.Equal("sha3", inputs[2].Sha256); // fallback to loaded sha
    }

    [Fact]
    public void PatchLogImages_OutputMapping_ShouldMapImageGenImages()
    {
        // 模拟 PatchLogImagesAsync 中 output 映射
        var outputImages = new List<FakeImageGenImage>
        {
            new() { Url = "https://cos.example.com/gen-wm.png", OriginalUrl = "https://cos.example.com/gen-orig.png", OriginalSha256 = "sha-orig" }
        };

        var outputs = new List<LlmLogImage>();
        foreach (var img in outputImages)
        {
            if (string.IsNullOrWhiteSpace(img.Url)) continue;
            outputs.Add(new LlmLogImage
            {
                Url = img.Url!,
                OriginalUrl = img.OriginalUrl,
                Label = "生成结果",
                Sha256 = img.OriginalSha256
            });
        }

        Assert.Single(outputs);
        Assert.Equal("https://cos.example.com/gen-wm.png", outputs[0].Url);
        Assert.Equal("https://cos.example.com/gen-orig.png", outputs[0].OriginalUrl);
        Assert.Equal("生成结果", outputs[0].Label);
        Assert.Equal("sha-orig", outputs[0].Sha256);
    }

    [Fact]
    public void PatchLogImages_OutputMapping_ShouldSkipEmptyUrl()
    {
        var outputImages = new List<FakeImageGenImage>
        {
            new() { Url = null, OriginalUrl = null, OriginalSha256 = null },
            new() { Url = "", OriginalUrl = null, OriginalSha256 = null }
        };

        var outputs = new List<LlmLogImage>();
        foreach (var img in outputImages)
        {
            if (string.IsNullOrWhiteSpace(img.Url)) continue;
            outputs.Add(new LlmLogImage { Url = img.Url!, Label = "生成结果" });
        }

        Assert.Empty(outputs);
    }

    [Fact]
    public void PatchLogImages_NoInputsNoOutputs_ShouldSkipUpdate()
    {
        // 模拟：run 无 ImageRefs 且 outputImages 为 null → 不更新
        var inputs = new List<LlmLogImage>();
        var outputs = new List<LlmLogImage>();

        var shouldUpdate = inputs.Count > 0 || outputs.Count > 0;

        Assert.False(shouldUpdate);
    }

    [Fact]
    public void PatchLogImages_LogRequestId_ShouldFollowPattern()
    {
        // logRequestId = "{run.Id}-{curItemIndex}-{imageIndex}"
        var runId = "abc123def456";
        var curItemIndex = 2;
        var imageIndex = 1;

        var logRequestId = $"{runId}-{curItemIndex}-{imageIndex}";

        Assert.Equal("abc123def456-2-1", logRequestId);
    }

    [Fact]
    public void PatchLogImages_FailurePath_ShouldStillRecordInputImages()
    {
        // 失败时 outputImages 为 null，但 inputImages 仍应记录
        var runImageRefs = new List<FakeImageRefInput>
        {
            new() { RefId = 1, Url = "https://cos.example.com/ref.png", AssetSha256 = "sha-ref", Label = "参考图" }
        };

        var inputs = new List<LlmLogImage>();
        foreach (var r in runImageRefs)
        {
            if (!string.IsNullOrWhiteSpace(r.Url))
                inputs.Add(new LlmLogImage { Url = r.Url!, Label = r.Label, Sha256 = r.AssetSha256 });
        }

        // outputImages is null on failure
        List<FakeImageGenImage>? outputImages = null;
        var outputs = new List<LlmLogImage>();
        if (outputImages is { Count: > 0 })
        {
            foreach (var img in outputImages)
            {
                if (!string.IsNullOrWhiteSpace(img.Url))
                    outputs.Add(new LlmLogImage { Url = img.Url!, Label = "生成结果" });
            }
        }

        Assert.Single(inputs);
        Assert.Empty(outputs);

        // Should still trigger update (inputs.Count > 0)
        var shouldUpdate = inputs.Count > 0 || outputs.Count > 0;
        Assert.True(shouldUpdate);
    }

    #endregion

    #region Helper Types

    /// <summary>
    /// 模拟 ImageRefData（避免引用 MultiImage 命名空间的复杂依赖）
    /// </summary>
    private class FakeImageRefData
    {
        public int RefId { get; init; }
        public string? Sha256 { get; init; }
        public string? CosUrl { get; init; }
        public string? Label { get; init; }
        public string? MimeType { get; init; }
    }

    /// <summary>
    /// 模拟 ImageRefInput（前端传入的图片引用）
    /// </summary>
    private class FakeImageRefInput
    {
        public int RefId { get; init; }
        public string? Url { get; init; }
        public string? AssetSha256 { get; init; }
        public string? Label { get; init; }
    }

    /// <summary>
    /// 模拟 ImageGenImage（生图结果）
    /// </summary>
    private class FakeImageGenImage
    {
        public string? Url { get; init; }
        public string? OriginalUrl { get; init; }
        public string? OriginalSha256 { get; init; }
    }

    #endregion
}
