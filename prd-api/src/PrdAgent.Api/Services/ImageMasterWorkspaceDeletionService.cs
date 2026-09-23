using System.Text.RegularExpressions;
using Microsoft.Extensions.Logging;
using MongoDB.Bson;
using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Services;
using PrdAgent.Infrastructure.Services.AssetStorage;

namespace PrdAgent.Api.Services;

public sealed record ImageMasterWorkspaceDeletionResult(bool Deleted, bool HasActiveGeneration);

/// <summary>
/// ImageMaster 工作区删除的唯一实现。视觉创作与文学创作共享同一组集合，
/// 删除行为也必须共享同一套级联与物理对象引用检查，避免入口之间继续漂移。
/// </summary>
public sealed class ImageMasterWorkspaceDeletionService
{
    private readonly MongoDbContext _db;
    private readonly IAssetStorage _assetStorage;
    private readonly ILogger _logger;

    public ImageMasterWorkspaceDeletionService(
        MongoDbContext db,
        IAssetStorage assetStorage,
        ILogger logger)
    {
        _db = db;
        _assetStorage = assetStorage;
        _logger = logger;
    }

    public async Task<ImageMasterWorkspaceDeletionResult> DeleteAsync(
        string workspaceId,
        CancellationToken ct)
    {
        var imageRuns = await _db.ImageGenRuns
            .Find(x => x.WorkspaceId == workspaceId)
            .Project(x => new { x.Id, x.Status })
            .ToListAsync(ct);
        if (imageRuns.Any(x => x.Status is ImageGenRunStatus.Queued
                or ImageGenRunStatus.ScopedQueued
                or ImageGenRunStatus.Running))
        {
            return new ImageMasterWorkspaceDeletionResult(false, true);
        }

        var imageRunIds = imageRuns.Select(x => x.Id).ToArray();
        var submissions = await _db.Submissions
            .Find(x => x.WorkspaceId == workspaceId)
            .Project(x => x.Id)
            .ToListAsync(ct);

        var assets = await _db.ImageAssets
            .Find(x => x.WorkspaceId == workspaceId)
            .ToListAsync(ct);
        var cleanupShas = new HashSet<string>(StringComparer.Ordinal);
        foreach (var asset in assets)
        {
            AddCleanupSha(cleanupShas, asset.Sha256);
            AddCleanupSha(cleanupShas, asset.OriginalSha256);
            AddCleanupSha(cleanupShas, asset.DisplaySha256);
        }

        UploadArtifact[] runArtifacts = [];
        ImageGenRunItem[] runItems = [];
        if (imageRunIds.Length > 0)
        {
            var artifactFilters = imageRunIds
                .Select(runId => Builders<UploadArtifact>.Filter.Regex(
                    x => x.RequestId,
                    new BsonRegularExpression($"^{Regex.Escape(runId)}-\\d+-\\d+$")))
                .ToArray();
            var runArtifactFilter = Builders<UploadArtifact>.Filter.Or(artifactFilters);
            runArtifacts = (await _db.UploadArtifacts.Find(runArtifactFilter).ToListAsync(ct)).ToArray();
            runItems = (await _db.ImageGenRunItems
                .Find(x => imageRunIds.Contains(x.RunId))
                .ToListAsync(ct)).ToArray();
            foreach (var artifact in runArtifacts) AddCleanupSha(cleanupShas, artifact.Sha256);
            foreach (var item in runItems) AddCleanupSha(cleanupShas, item.DisplaySha256);
        }

        // 先解除全部数据库引用，再开始物理对象回收。这样回收失败最多留下孤儿对象，
        // 不会出现仍可见的数据库记录指向已删除对象。
        await _db.ImageMasterCanvases.DeleteManyAsync(x => x.WorkspaceId == workspaceId, ct);
        await _db.ImageMasterMessages.DeleteManyAsync(x => x.WorkspaceId == workspaceId, ct);
        await _db.ImageAssets.DeleteManyAsync(x => x.WorkspaceId == workspaceId, ct);

        if (submissions.Count > 0)
        {
            await _db.SubmissionLikes.DeleteManyAsync(x => submissions.Contains(x.SubmissionId), ct);
            await _db.Submissions.DeleteManyAsync(x => submissions.Contains(x.Id), ct);
        }

        if (imageRunIds.Length > 0)
        {
            var runArtifactIds = runArtifacts.Select(x => x.Id).ToArray();
            if (runArtifactIds.Length > 0)
                await _db.UploadArtifacts.DeleteManyAsync(x => runArtifactIds.Contains(x.Id), ct);
            await _db.ImageGenRunItems.DeleteManyAsync(x => imageRunIds.Contains(x.RunId), ct);
            await _db.ImageGenRunEvents.DeleteManyAsync(x => imageRunIds.Contains(x.RunId), ct);
            await _db.ImageGenRuns.DeleteManyAsync(x => imageRunIds.Contains(x.Id), ct);
        }

        var recentOpenFilter = Builders<UserRecentOpen>.Filter.Eq(x => x.EntityId, workspaceId)
            & Builders<UserRecentOpen>.Filter.In(x => x.AgentKey, ["visual-agent", "literary-agent"]);
        await _db.UserRecentOpens.DeleteManyAsync(recentOpenFilter, ct);
        await _db.ImageMasterWorkspaces.DeleteOneAsync(x => x.Id == workspaceId, ct);

        foreach (var sha in cleanupShas)
        {
            try
            {
                await TryDeleteUnreferencedGeneratedImageAsync(sha, CancellationToken.None);
            }
            catch (Exception ex)
            {
                _logger.LogWarning(
                    ex,
                    "ImageMaster workspace object cleanup failed: workspaceId={WorkspaceId} sha={Sha}",
                    workspaceId,
                    sha);
            }
        }

        return new ImageMasterWorkspaceDeletionResult(true, false);
    }

    public async Task<bool> TryDeleteUnreferencedGeneratedImageAsync(
        string? sha256,
        CancellationToken ct)
    {
        var sha = (sha256 ?? string.Empty).Trim().ToLowerInvariant();
        if (string.IsNullOrWhiteSpace(sha)) return false;

        await using var assetLease = await VideoAssetMutationLease.AcquireAsync(
            _db,
            $"generated-image:{sha}",
            ct);

        var imageAssetFilter = Builders<ImageAsset>.Filter.Or(
            Builders<ImageAsset>.Filter.Eq(item => item.Sha256, sha),
            Builders<ImageAsset>.Filter.Eq(item => item.OriginalSha256, sha),
            Builders<ImageAsset>.Filter.Eq(item => item.DisplaySha256, sha));
        if (await _db.ImageAssets.CountDocumentsAsync(imageAssetFilter, cancellationToken: ct) > 0)
            return false;

        if (await _db.UploadArtifacts.CountDocumentsAsync(
                item => item.Sha256 == sha,
                cancellationToken: ct) > 0)
        {
            return false;
        }

        if (await _db.ImageGenRunItems.CountDocumentsAsync(
                item => item.DisplaySha256 == sha,
                cancellationToken: ct) > 0)
        {
            return false;
        }

        var runFilter = Builders<ImageGenRun>.Filter.Or(
            Builders<ImageGenRun>.Filter.Eq(item => item.InitImageAssetSha256, sha),
            Builders<ImageGenRun>.Filter.Eq("ImageRefs.AssetSha256", sha));
        if (await _db.ImageGenRuns.CountDocumentsAsync(runFilter, cancellationToken: ct) > 0)
            return false;

        await _assetStorage.DeleteByShaAsync(
            sha,
            ct,
            domain: AppDomainPaths.DomainVisualAgent,
            type: AppDomainPaths.TypeImg);
        return true;
    }

    private static void AddCleanupSha(ISet<string> target, string? value)
    {
        var normalized = (value ?? string.Empty).Trim().ToLowerInvariant();
        if (!string.IsNullOrWhiteSpace(normalized)) target.Add(normalized);
    }
}
