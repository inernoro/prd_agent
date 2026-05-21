using System.Text;
using System.Text.Json.Nodes;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.LlmGateway;
using PrdAgent.Infrastructure.LlmGateway.ImageGen;

namespace PrdAgent.Api.Services.MarkingLineAgent;

/// <summary>
/// 赋码产线：先由聊天模型整理英文生图提示词，再经 ImageGenGateway 输出 PNG（url 或 b64）。
/// </summary>
public sealed class MarkingLineDiagramImageService
{
    private const string ChatAppCaller = AppCallerRegistry.MarkingLineAgent.Diagram.Stream;
    private const string ImageAppCaller = AppCallerRegistry.MarkingLineAgent.Diagram.Image;

    private readonly ILlmGateway _gateway;
    private readonly IImageGenGateway _imageGenGateway;
    private readonly ILLMRequestContextAccessor _llmRequestContext;
    private readonly ILogger<MarkingLineDiagramImageService> _logger;

    public MarkingLineDiagramImageService(
        ILlmGateway gateway,
        IImageGenGateway imageGenGateway,
        ILLMRequestContextAccessor llmRequestContext,
        ILogger<MarkingLineDiagramImageService> logger)
    {
        _gateway = gateway;
        _imageGenGateway = imageGenGateway;
        _llmRequestContext = llmRequestContext;
        _logger = logger;
    }

    /// <summary>
    /// 生成产线示意图位图（通常为 PNG）。失败时 <see cref="MarkingLineDiagramImageResult.Success"/> 为 false。
    /// </summary>
    public async Task<MarkingLineDiagramImageResult> TryGenerateAsync(
        string userId,
        string userBrief,
        string responseFormat,
        CancellationToken ct)
    {
        var trimmed = (userBrief ?? string.Empty).Trim();
        if (string.IsNullOrEmpty(trimmed))
            return MarkingLineDiagramImageResult.Fail(ErrorCodes.CONTENT_EMPTY, "请填写产线或工位描述");

        var fmt = string.Equals(responseFormat, "b64_json", StringComparison.OrdinalIgnoreCase) ? "b64_json" : "url";

        string imagePrompt;
        string? promptModel = null;
        string? promptPlatform = null;

        using (var _ = _llmRequestContext.BeginScope(new LlmRequestContext(
                   RequestId: Guid.NewGuid().ToString("N"),
                   GroupId: null,
                   SessionId: null,
                   UserId: userId,
                   ViewRole: null,
                   DocumentChars: null,
                   DocumentHash: null,
                   SystemPromptRedacted: null,
                   RequestType: "chat",
                   AppCallerCode: ChatAppCaller,
                   ModelResolutionType: null)))
        {
            var promptBody = new JsonObject
            {
                ["messages"] = new JsonArray
                {
                    new JsonObject { ["role"] = "system", ["content"] = BuildPromptComposerSystem() },
                    new JsonObject { ["role"] = "user", ["content"] = "现场与设备信息（可含中文）：\n" + trimmed },
                },
                ["temperature"] = 0.25,
                ["max_tokens"] = 900,
            };

            var chatResp = await _gateway.SendAsync(new GatewayRequest
            {
                AppCallerCode = ChatAppCaller,
                ModelType = ModelTypes.Chat,
                Stream = false,
                RequestBody = promptBody,
            }, ct).ConfigureAwait(false);

            if (!chatResp.Success || string.IsNullOrWhiteSpace(chatResp.Content))
            {
                _logger.LogWarning("MarkingLine image: prompt chat failed: {Err}", chatResp.ErrorMessage);
                imagePrompt = BuildFallbackImagePrompt(trimmed);
            }
            else
            {
                imagePrompt = SanitizeImagePrompt(chatResp.Content);
                promptModel = chatResp.Resolution?.ActualModel;
                promptPlatform = chatResp.Resolution?.ActualPlatformName ?? chatResp.Resolution?.ActualPlatformId;
            }
        }

        using (var _ = _llmRequestContext.BeginScope(new LlmRequestContext(
                   RequestId: Guid.NewGuid().ToString("N"),
                   GroupId: null,
                   SessionId: null,
                   UserId: userId,
                   ViewRole: null,
                   DocumentChars: null,
                   DocumentHash: null,
                   SystemPromptRedacted: null,
                   RequestType: "generation",
                   AppCallerCode: ImageAppCaller,
                   ModelResolutionType: null)))
        {
            var gen = await _imageGenGateway.GenerateImageAsync(
                ImageAppCaller,
                expectedModel: null,
                new ImageGenPayload
                {
                    Prompt = imagePrompt,
                    N = 1,
                    // 与周报海报等场景对齐：1024 方图兼容性最好；非 DALL-E 池常不支持 1792x1024
                    Size = "1024x1024",
                    ResponseFormat = fmt,
                },
                ct).ConfigureAwait(false);

            if (!gen.Success || gen.Images.Count == 0)
            {
                _logger.LogWarning(
                    "MarkingLine diagram image gen failed: {Code} {Message}",
                    gen.ErrorCode ?? "(null)",
                    gen.ErrorMessage ?? "(null)");
                return MarkingLineDiagramImageResult.Fail(
                    gen.ErrorCode ?? "IMAGE_GEN_FAILED",
                    gen.ErrorMessage ?? "图片生成失败");
            }

            var first = gen.Images[0];
            return new MarkingLineDiagramImageResult
            {
                Success = true,
                ImageUrl = first.Url,
                ImageBase64 = first.Base64,
                MimeType = first.MimeType ?? "image/png",
                ImagePromptUsed = imagePrompt,
                RevisedPrompt = first.RevisedPrompt,
                PromptComposerModel = promptModel,
                PromptComposerPlatform = promptPlatform,
            };
        }
    }

    private static string BuildPromptComposerSystem()
    {
        var sb = new StringBuilder();
        sb.AppendLine("You write ONE English paragraph (max ~600 words) for a text-to-image model.");
        sb.AppendLine("Subject: industrial bottling/packaging line training diagram, clean white background, left-to-right flow.");
        sb.AppendLine("Style: flat technical illustration, subtle isometric conveyor bands in light grey, white machine housings, ");
        sb.AppendLine("pale yellow for workshop or reject zones, small camera icons, red text arrows for direction labels (as readable words in the image), ");
        sb.AppendLine("no photorealistic people faces, no brand logos, no watermark, no emoji.");
        sb.AppendLine("Incorporate all concrete details from the user message (stations, camera counts, incline, palletizer).");
        sb.AppendLine("Output ONLY the paragraph, no markdown fences, no title.");
        return sb.ToString();
    }

    private static string BuildFallbackImagePrompt(string brief)
    {
        return "Clean white background industrial training diagram, left to right packaging line, flat technical illustration, " +
               "grey conveyor, white machines, small camera icons, Chinese labels as readable text in the image, " +
               "no logos, no emoji. Scene: " + brief;
    }

    private static string SanitizeImagePrompt(string raw)
    {
        var t = raw.Trim();
        if (t.StartsWith("```", StringComparison.Ordinal))
        {
            var i = t.IndexOf('\n');
            if (i > 0) t = t[(i + 1)..].Trim();
            if (t.EndsWith("```", StringComparison.Ordinal)) t = t[..^3].Trim();
        }

        t = t.Replace("\r\n", " ", StringComparison.Ordinal).Replace('\n', ' ');
        while (t.Contains("  ", StringComparison.Ordinal)) t = t.Replace("  ", " ", StringComparison.Ordinal);
        if (t.Length > 2800) t = t[..2800];
        return t;
    }
}

public sealed class MarkingLineDiagramImageResult
{
    public bool Success { get; init; }
    public string? ErrorCode { get; init; }
    public string? ErrorMessage { get; init; }
    public string? ImageUrl { get; init; }
    public string? ImageBase64 { get; init; }
    public string? MimeType { get; init; }
    public string? ImagePromptUsed { get; init; }
    public string? RevisedPrompt { get; init; }
    public string? PromptComposerModel { get; init; }
    public string? PromptComposerPlatform { get; init; }

    public static MarkingLineDiagramImageResult Fail(string code, string message)
        => new() { Success = false, ErrorCode = code, ErrorMessage = message };
}
