using System.Text.Json;
using Microsoft.Extensions.Logging;
using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Infrastructure.Services;

/// <summary>
/// Workspace 深拷贝服务：将 Workspace 及其关联数据（Assets、Canvas、Messages）
/// 整体复制给目标用户。COS 文件共享引用，不复制物理文件。
/// </summary>
public class WorkspaceCloneService
{
    private readonly MongoDbContext _db;
    private readonly ILogger<WorkspaceCloneService> _logger;

    public WorkspaceCloneService(MongoDbContext db, ILogger<WorkspaceCloneService> logger)
    {
        _db = db;
        _logger = logger;
    }

    public record CloneResult(string NewWorkspaceId, int AssetCount, int MessageCount);

    /// <summary>
    /// 深拷贝一个 Workspace 及其所有关联数据给目标用户。
    /// </summary>
    public async Task<CloneResult> CloneAsync(string sourceWorkspaceId, string newOwnerId, CancellationToken ct)
    {
        // 1. 读源 Workspace
        var source = await _db.ImageMasterWorkspaces
            .Find(w => w.Id == sourceWorkspaceId)
            .FirstOrDefaultAsync(ct);

        if (source == null)
            throw new InvalidOperationException($"Source workspace not found: {sourceWorkspaceId}");

        var newWsId = Guid.NewGuid().ToString("N");
        var newSessionId = Guid.NewGuid().ToString("N");
        var now = DateTime.UtcNow;

        // 2. 复制 Assets，建立 ID 映射
        var assetIdMap = new Dictionary<string, string>();
        var assets = await _db.ImageAssets
            .Find(a => a.WorkspaceId == sourceWorkspaceId)
            .ToListAsync(ct);

        var newAssets = new List<ImageAsset>();
        foreach (var asset in assets)
        {
            var newAssetId = Guid.NewGuid().ToString("N");
            assetIdMap[asset.Id] = newAssetId;

            newAssets.Add(new ImageAsset
            {
                Id = newAssetId,
                OwnerUserId = newOwnerId,
                WorkspaceId = newWsId,
                Sha256 = asset.Sha256,
                Mime = asset.Mime,
                Width = asset.Width,
                Height = asset.Height,
                SizeBytes = asset.SizeBytes,
                Url = asset.Url,               // 共享 COS URL
                Prompt = asset.Prompt,
                ArticleInsertionIndex = asset.ArticleInsertionIndex,
                OriginalMarkerText = asset.OriginalMarkerText,
                OriginalUrl = asset.OriginalUrl,
                OriginalSha256 = asset.OriginalSha256,
                Description = asset.Description,
                DescriptionExtractedAt = asset.DescriptionExtractedAt,
                DescriptionModelId = asset.DescriptionModelId,
                CreatedAt = now,
            });
        }

        // 3. 复制 Canvas（修复 PayloadJson 中的 AssetId 引用）
        var canvas = await _db.ImageMasterCanvases
            .Find(c => c.WorkspaceId == sourceWorkspaceId)
            .FirstOrDefaultAsync(ct);

        ImageMasterCanvas? newCanvas = null;
        if (canvas != null)
        {
            var patchedPayload = ReplaceAssetIds(canvas.PayloadJson, assetIdMap);
            newCanvas = new ImageMasterCanvas
            {
                Id = Guid.NewGuid().ToString("N"),
                OwnerUserId = newOwnerId,
                SessionId = newSessionId,
                WorkspaceId = newWsId,
                SchemaVersion = canvas.SchemaVersion,
                PayloadJson = patchedPayload,
                CreatedAt = now,
                UpdatedAt = now,
            };
        }

        // 4. 复制 Messages
        var messages = await _db.ImageMasterMessages
            .Find(m => m.WorkspaceId == sourceWorkspaceId)
            .ToListAsync(ct);

        var newMessages = messages.Select(m => new ImageMasterMessage
        {
            Id = Guid.NewGuid().ToString("N"),
            SessionId = newSessionId,
            WorkspaceId = newWsId,
            OwnerUserId = newOwnerId,
            Role = m.Role,
            Content = m.Content,
            CreatedAt = m.CreatedAt, // 保留原始时间以维持聊天顺序
        }).ToList();

        // 5. 构建新 Workspace
        var newWs = new ImageMasterWorkspace
        {
            Id = newWsId,
            OwnerUserId = newOwnerId,
            Title = $"{source.Title} (来自分享)",
            MemberUserIds = new List<string>(),
            ScenarioType = source.ScenarioType,
            SelectedPromptId = null, // 提示词 ID 属于发送方，不继承
            ArticleContent = source.ArticleContent,
            ArticleContentWithMarkers = source.ArticleContentWithMarkers,
            FolderName = source.FolderName,
            StylePrompt = source.StylePrompt,
            CreatedAt = now,
            UpdatedAt = now,
        };

        // 映射封面引用
        if (source.CoverAssetId != null && assetIdMap.TryGetValue(source.CoverAssetId, out var mappedCover))
            newWs.CoverAssetId = mappedCover;

        if (source.CoverAssetIds?.Count > 0)
            newWs.CoverAssetIds = source.CoverAssetIds
                .Select(id => assetIdMap.GetValueOrDefault(id, id))
                .ToList();

        // 映射 ArticleWorkflow 中的 AssetId 引用
        if (source.ArticleWorkflow != null)
        {
            newWs.ArticleWorkflow = CloneArticleWorkflow(source.ArticleWorkflow, assetIdMap);
        }

        // 6. 批量写入
        await _db.ImageMasterWorkspaces.InsertOneAsync(newWs, cancellationToken: ct);

        if (newAssets.Count > 0)
            await _db.ImageAssets.InsertManyAsync(newAssets, cancellationToken: ct);

        if (newCanvas != null)
            await _db.ImageMasterCanvases.InsertOneAsync(newCanvas, cancellationToken: ct);

        if (newMessages.Count > 0)
            await _db.ImageMasterMessages.InsertManyAsync(newMessages, cancellationToken: ct);

        _logger.LogInformation(
            "Cloned workspace {SourceId} -> {NewId} for user {UserId}: {AssetCount} assets, {MsgCount} messages",
            sourceWorkspaceId, newWsId, newOwnerId, newAssets.Count, newMessages.Count);

        return new CloneResult(newWsId, newAssets.Count, newMessages.Count);
    }

    /// <summary>
    /// 替换 PayloadJson 中的旧 AssetId → 新 AssetId。
    /// 使用字符串替换方式，因为 PayloadJson 结构由前端控制，不做强类型解析。
    /// </summary>
    private static string ReplaceAssetIds(string payloadJson, Dictionary<string, string> assetIdMap)
    {
        if (string.IsNullOrEmpty(payloadJson) || assetIdMap.Count == 0)
            return payloadJson;

        var result = payloadJson;
        foreach (var (oldId, newId) in assetIdMap)
        {
            result = result.Replace(oldId, newId);
        }
        return result;
    }

    /// <summary>
    /// 深拷贝 ArticleIllustrationWorkflow，映射其中的 AssetId 引用
    /// </summary>
    private static ArticleIllustrationWorkflow CloneArticleWorkflow(
        ArticleIllustrationWorkflow source,
        Dictionary<string, string> assetIdMap)
    {
        var clone = new ArticleIllustrationWorkflow
        {
            Version = source.Version,
            Phase = source.Phase,
            ExpectedImageCount = source.ExpectedImageCount,
            DoneImageCount = source.DoneImageCount,
            UpdatedAt = DateTime.UtcNow,
        };

        // 映射 AssetIdByMarkerIndex
        foreach (var (key, assetId) in source.AssetIdByMarkerIndex)
        {
            clone.AssetIdByMarkerIndex[key] = assetIdMap.GetValueOrDefault(assetId, assetId);
        }

        // 映射 Markers 中的 AssetId
        clone.Markers = source.Markers.Select(m => new ArticleIllustrationMarker
        {
            Index = m.Index,
            Text = m.Text,
            DraftText = m.DraftText,
            Status = m.Status,
            RunId = null, // Run 不迁移，清空
            AssetId = m.AssetId != null ? assetIdMap.GetValueOrDefault(m.AssetId, m.AssetId) : null,
            Url = m.Url, // COS URL 共享
            PlanItem = m.PlanItem,
            ErrorMessage = null,
            UpdatedAt = m.UpdatedAt,
        }).ToList();

        return clone;
    }
}
