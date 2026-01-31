using System.Text;
using Microsoft.Extensions.Logging;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Infrastructure.Services.VisualAgent;

/// <summary>
/// 图片引用（用于多图组合）
/// </summary>
public class ImageReference
{
    /// <summary>引用索引（对应指令中的 [IMAGE_N]）</summary>
    public int Index { get; set; }

    /// <summary>图片资产 ID</summary>
    public string AssetId { get; set; } = string.Empty;

    /// <summary>显示名称（可选，用于日志/调试）</summary>
    public string? Name { get; set; }
}

/// <summary>
/// 多图组合意图解析结果
/// </summary>
public class ComposeIntentResult
{
    /// <summary>生成的英文 Prompt</summary>
    public string GeneratedPrompt { get; set; } = string.Empty;

    /// <summary>使用的模型标识</summary>
    public string? ModelId { get; set; }

    /// <summary>图片描述列表（用于调试）</summary>
    public List<ImageDescriptionInfo> ImageDescriptions { get; set; } = new();
}

/// <summary>
/// 图片描述信息
/// </summary>
public class ImageDescriptionInfo
{
    public int Index { get; set; }
    public string AssetId { get; set; } = string.Empty;
    public string? Description { get; set; }
    public bool HasDescription { get; set; }
}

/// <summary>
/// 多图组合服务接口
/// </summary>
public interface IMultiImageComposeService
{
    /// <summary>
    /// 解析多图组合请求，返回生成的英文 Prompt
    /// </summary>
    /// <param name="userInstruction">用户指令（如 "把 [IMAGE_1] 放进 [IMAGE_2] 里"）</param>
    /// <param name="images">图片引用列表</param>
    /// <param name="userId">用户 ID</param>
    /// <param name="ct">取消令牌</param>
    /// <returns>组合意图解析结果</returns>
    Task<ComposeIntentResult> ParseComposeIntentAsync(
        string userInstruction,
        List<ImageReference> images,
        string userId,
        CancellationToken ct = default);
}

/// <summary>
/// 多图组合服务实现
/// </summary>
public class MultiImageComposeService : IMultiImageComposeService
{
    private readonly MongoDbContext _db;
    private readonly ISmartModelScheduler _modelScheduler;
    private readonly ILLMRequestContextAccessor _llmRequestContext;
    private readonly IImageDescriptionService _imageDescriptionService;
    private readonly ILogger<MultiImageComposeService> _logger;

    private const string SystemPrompt =
        "# Role\n" +
        "你是 AI 绘画指令编译器，具备视觉理解能力。\n\n" +
        "# Input\n" +
        "你将收到：\n" +
        "1. 一组图片，标记为 [Image 1], [Image 2], ... 按顺序排列\n" +
        "2. 用户的组合指令，会引用这些图片\n\n" +
        "# Task\n" +
        "1. 仔细观察每张图片的内容（主体、颜色、风格、场景）\n" +
        "2. 语义解析：分析用户指令的逻辑关系（谁是主体、谁是背景、是否风格迁移）\n" +
        "   - 不管语序如何（「把A放进B」或「B里面有A」），都要正确理解\n" +
        "3. 生成一段详细的英文 Prompt，描述融合后的最终画面\n" +
        "   - 必须包含所有被引用图片的关键视觉元素\n" +
        "   - 添加合理的细节使画面和谐（光影、构图、氛围）\n" +
        "   - 150-300 词\n\n" +
        "# Output\n" +
        "只输出英文 Prompt，不要任何解释。";

    public MultiImageComposeService(
        MongoDbContext db,
        ISmartModelScheduler modelScheduler,
        ILLMRequestContextAccessor llmRequestContext,
        IImageDescriptionService imageDescriptionService,
        ILogger<MultiImageComposeService> logger)
    {
        _db = db;
        _modelScheduler = modelScheduler;
        _llmRequestContext = llmRequestContext;
        _imageDescriptionService = imageDescriptionService;
        _logger = logger;
    }

    /// <inheritdoc />
    public async Task<ComposeIntentResult> ParseComposeIntentAsync(
        string userInstruction,
        List<ImageReference> images,
        string userId,
        CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(userInstruction))
        {
            throw new ArgumentException("User instruction cannot be empty", nameof(userInstruction));
        }

        if (images == null || images.Count == 0)
        {
            throw new ArgumentException("At least one image reference is required", nameof(images));
        }

        // 1. 批量查询图片资产及其描述
        var assetIds = images.Select(x => x.AssetId).ToList();
        var assets = await _db.ImageAssets
            .Find(x => assetIds.Contains(x.Id))
            .ToListAsync(ct);

        var assetMap = assets.ToDictionary(x => x.Id);

        // 2. 构建图片附件列表和描述信息
        var descriptionInfos = new List<ImageDescriptionInfo>();
        var attachments = new List<LLMAttachment>();

        foreach (var imgRef in images.OrderBy(x => x.Index))
        {
            var info = new ImageDescriptionInfo
            {
                Index = imgRef.Index,
                AssetId = imgRef.AssetId
            };

            if (assetMap.TryGetValue(imgRef.AssetId, out var asset))
            {
                // 使用已有描述（如果有）
                info.Description = asset.Description;
                info.HasDescription = !string.IsNullOrWhiteSpace(asset.Description);

                // 构建图片附件 - 使用 URL 发送给 VLM
                if (!string.IsNullOrWhiteSpace(asset.Url))
                {
                    attachments.Add(new LLMAttachment
                    {
                        Type = "image",
                        Url = asset.Url
                    });
                    _logger.LogDebug("Added image attachment for index {Index}: {Url}", imgRef.Index, asset.Url);
                }
                else
                {
                    _logger.LogWarning("Asset {AssetId} has no URL, skipping", imgRef.AssetId);
                }
            }
            else
            {
                _logger.LogWarning("Asset not found: {AssetId}", imgRef.AssetId);
                info.HasDescription = false;
            }

            descriptionInfos.Add(info);
        }

        // 如果没有任何图片附件，抛出异常
        if (attachments.Count == 0)
        {
            throw new InvalidOperationException("No valid image assets found for compose operation");
        }

        // 3. 构建用户消息（只包含指令，图片通过附件发送）
        var userContent = $"图片已按顺序附上（[Image 1], [Image 2], ...）。\n\n用户指令：{userInstruction}";

        // 4. 调用 VLM
        var appCallerCode = AppCallerRegistry.VisualAgent.Compose.Intent;
        var scheduledResult = await _modelScheduler.GetClientWithGroupInfoAsync(appCallerCode, "vision", ct);

        using var _ = _llmRequestContext.BeginScope(new LlmRequestContext(
            RequestId: Guid.NewGuid().ToString("N"),
            GroupId: null,
            SessionId: null,
            UserId: userId,
            ViewRole: "USER",
            DocumentChars: null,
            DocumentHash: null,
            SystemPromptRedacted: "[MULTI_IMAGE_COMPOSE]",
            RequestType: "vision",
            RequestPurpose: appCallerCode,
            ModelResolutionType: scheduledResult.ResolutionType,
            ModelGroupId: scheduledResult.ModelGroupId,
            ModelGroupName: scheduledResult.ModelGroupName));

        var client = scheduledResult.Client;

        var msg = new LLMMessage
        {
            Role = "user",
            Content = userContent,
            Attachments = attachments
        };

        _logger.LogInformation(
            "Sending compose request with {ImageCount} images to VLM",
            attachments.Count);

        var generatedPrompt = await CollectToTextAsync(client, SystemPrompt, new List<LLMMessage> { msg }, ct);
        generatedPrompt = NormalizePrompt(generatedPrompt);

        _logger.LogInformation(
            "Generated compose prompt for user {UserId}: {PromptLength} chars, {ImageCount} images",
            userId, generatedPrompt.Length, images.Count);

        return new ComposeIntentResult
        {
            GeneratedPrompt = generatedPrompt,
            ModelId = scheduledResult.ModelGroupName,
            ImageDescriptions = descriptionInfos
        };
    }

    private static async Task<string> CollectToTextAsync(
        ILLMClient client,
        string systemPrompt,
        List<LLMMessage> messages,
        CancellationToken ct)
    {
        var sb = new StringBuilder(capacity: 2048);
        await foreach (var chunk in client.StreamGenerateAsync(systemPrompt, messages, ct).WithCancellation(ct))
        {
            if (chunk.Type == "delta" && !string.IsNullOrEmpty(chunk.Content))
            {
                sb.Append(chunk.Content);
            }
            else if (chunk.Type == "error")
            {
                throw new InvalidOperationException(chunk.ErrorMessage ?? "LLM_ERROR");
            }
        }
        return sb.ToString();
    }

    private static string NormalizePrompt(string raw)
    {
        var s = (raw ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(s)) return string.Empty;

        // 移除可能的代码块标记
        if (s.StartsWith("```"))
        {
            var firstNewline = s.IndexOf('\n');
            if (firstNewline > 0)
            {
                s = s[(firstNewline + 1)..];
            }
        }
        if (s.EndsWith("```"))
        {
            s = s[..^3];
        }

        // 移除多余换行
        s = System.Text.RegularExpressions.Regex.Replace(s, @"\n{3,}", "\n\n");

        return s.Trim();
    }
}
