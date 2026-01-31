using System.Text;
using Microsoft.Extensions.Logging;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.LlmGateway;
using PrdAgent.Infrastructure.Services.AssetStorage;

namespace PrdAgent.Infrastructure.Services.VisualAgent;

/// <summary>
/// 图片描述提取服务接口
/// </summary>
public interface IImageDescriptionService
{
    /// <summary>
    /// 异步提取图片描述（Fire-and-forget，不阻塞调用方）
    /// </summary>
    /// <param name="assetId">图片资产 ID</param>
    /// <param name="ct">取消令牌</param>
    Task ExtractDescriptionAsync(string assetId, CancellationToken ct = default);

    /// <summary>
    /// 同步提取图片描述（等待结果返回）
    /// </summary>
    /// <param name="assetId">图片资产 ID</param>
    /// <param name="ct">取消令牌</param>
    /// <returns>提取的描述文本</returns>
    Task<string?> ExtractDescriptionSyncAsync(string assetId, CancellationToken ct = default);
}

/// <summary>
/// 图片描述提取服务实现
/// </summary>
public class ImageDescriptionService : IImageDescriptionService
{
    private readonly MongoDbContext _db;
    private readonly ILlmGateway _gateway;
    private readonly ILLMRequestContextAccessor _llmRequestContext;
    private readonly IAssetStorage _assetStorage;
    private readonly ILogger<ImageDescriptionService> _logger;

    private const string VlmSystemPrompt =
        "你是图片描述专家。请用简洁的中文描述这张图片的核心内容。\n" +
        "要求：\n" +
        "- 描述主体对象（是什么、颜色、姿态、特征）\n" +
        "- 描述环境/背景（场景、光线、氛围）\n" +
        "- 80-150字，不超过200字\n" +
        "- 不要以「这张图片」开头，直接描述";

    private const int MaxDescriptionLength = 500;

    public ImageDescriptionService(
        MongoDbContext db,
        ILlmGateway gateway,
        ILLMRequestContextAccessor llmRequestContext,
        IAssetStorage assetStorage,
        ILogger<ImageDescriptionService> logger)
    {
        _db = db;
        _gateway = gateway;
        _llmRequestContext = llmRequestContext;
        _assetStorage = assetStorage;
        _logger = logger;
    }

    /// <inheritdoc />
    public async Task ExtractDescriptionAsync(string assetId, CancellationToken ct = default)
    {
        // Fire-and-forget: 不抛出异常，仅记录日志
        try
        {
            await ExtractDescriptionInternalAsync(assetId, ct);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Failed to extract description for asset {AssetId}", assetId);
        }
    }

    /// <inheritdoc />
    public async Task<string?> ExtractDescriptionSyncAsync(string assetId, CancellationToken ct = default)
    {
        return await ExtractDescriptionInternalAsync(assetId, ct);
    }

    private async Task<string?> ExtractDescriptionInternalAsync(string assetId, CancellationToken ct)
    {
        // 1. 查询资产
        var asset = await _db.ImageAssets
            .Find(x => x.Id == assetId)
            .FirstOrDefaultAsync(ct);

        if (asset == null)
        {
            _logger.LogWarning("Asset not found: {AssetId}", assetId);
            return null;
        }

        // 2. 读取图片内容
        var sha256 = asset.OriginalSha256 ?? asset.Sha256;
        var imageData = await _assetStorage.TryReadByShaAsync(
            sha256, ct,
            domain: AppDomainPaths.DomainVisualAgent,
            type: AppDomainPaths.TypeImg);

        if (imageData == null)
        {
            _logger.LogWarning("Image file not found for asset {AssetId}, sha256={Sha256}", assetId, sha256);
            return null;
        }

        var (bytes, mime) = imageData.Value;
        var base64 = Convert.ToBase64String(bytes);

        // 3. 调用 VLM 提取描述
        var appCallerCode = AppCallerRegistry.VisualAgent.Image.Describe;
        var llmClient = _gateway.CreateClient(appCallerCode, "vision");

        using var _ = _llmRequestContext.BeginScope(new LlmRequestContext(
            RequestId: Guid.NewGuid().ToString("N"),
            GroupId: null,
            SessionId: null,
            UserId: asset.OwnerUserId,
            ViewRole: "USER",
            DocumentChars: null,
            DocumentHash: null,
            SystemPromptRedacted: "[IMAGE_DESCRIBE]",
            RequestType: "vision",
            RequestPurpose: appCallerCode));

        var msg = new LLMMessage
        {
            Role = "user",
            Content = "请描述这张图片的内容。",
            Attachments = new List<LLMAttachment>
            {
                new()
                {
                    Type = "image",
                    MimeType = mime,
                    Base64Data = base64
                }
            }
        };

        var raw = await CollectToTextAsync(llmClient, VlmSystemPrompt, new List<LLMMessage> { msg }, ct);
        var description = NormalizeDescription(raw);

        if (string.IsNullOrWhiteSpace(description))
        {
            _logger.LogWarning("VLM returned empty description for asset {AssetId}", assetId);
            return null;
        }

        // 4. 更新数据库（modelId 由 Gateway 内部处理，这里仅记录 appCallerCode）
        var modelId = appCallerCode;
        await _db.ImageAssets.UpdateOneAsync(
            x => x.Id == assetId,
            Builders<ImageAsset>.Update
                .Set(x => x.Description, description)
                .Set(x => x.DescriptionExtractedAt, DateTime.UtcNow)
                .Set(x => x.DescriptionModelId, modelId),
            cancellationToken: ct);

        _logger.LogInformation("Extracted description for asset {AssetId}: {DescriptionLength} chars", assetId, description.Length);

        return description;
    }

    private static async Task<string> CollectToTextAsync(
        ILLMClient client,
        string systemPrompt,
        List<LLMMessage> messages,
        CancellationToken ct)
    {
        var sb = new StringBuilder(capacity: 1024);
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

    private static string NormalizeDescription(string raw)
    {
        var s = (raw ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(s)) return string.Empty;

        // 移除多余换行
        s = System.Text.RegularExpressions.Regex.Replace(s, @"\n{3,}", "\n\n");

        // 截断到最大长度
        if (s.Length > MaxDescriptionLength)
        {
            s = s[..MaxDescriptionLength].Trim();
        }

        return s;
    }
}
