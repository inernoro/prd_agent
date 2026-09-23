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

        // 所有会阻止删除的检查已经完成。此后必须由服务端接管生命周期，不能让浏览器断线
        // 在多集合级联中途取消，留下“工作区仍可见但内容已删一半”的状态。
        var mutationToken = CancellationToken.None;

        var imageRunIds = imageRuns.Select(x => x.Id).ToArray();
        var submissions = await _db.Submissions
            .Find(x => x.WorkspaceId == workspaceId)
            .Project(x => x.Id)
            .ToListAsync(mutationToken);

        var assets = await _db.ImageAssets
            .Find(x => x.WorkspaceId == workspaceId)
            .ToListAsync(mutationToken);
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
            runArtifacts = (await _db.UploadArtifacts.Find(runArtifactFilter).ToListAsync(mutationToken)).ToArray();
            runItems = (await _db.ImageGenRunItems
                .Find(x => imageRunIds.Contains(x.RunId))
                .ToListAsync(mutationToken)).ToArray();
            foreach (var artifact in runArtifacts) AddCleanupSha(cleanupShas, artifact.Sha256);
            foreach (var item in runItems) AddCleanupSha(cleanupShas, item.DisplaySha256);
        }

        // 先解除全部数据库引用，再开始物理对象回收。这样回收失败最多留下孤儿对象，
        // 不会出现仍可见的数据库记录指向已删除对象。
        await _db.ImageMasterCanvases.DeleteManyAsync(x => x.WorkspaceId == workspaceId, mutationToken);
        await _db.ImageMasterMessages.DeleteManyAsync(x => x.WorkspaceId == workspaceId, mutationToken);
        await _db.ImageAssets.DeleteManyAsync(x => x.WorkspaceId == workspaceId, mutationToken);

        if (submissions.Count > 0)
        {
            await _db.SubmissionLikes.DeleteManyAsync(x => submissions.Contains(x.SubmissionId), mutationToken);
            await _db.Submissions.DeleteManyAsync(x => submissions.Contains(x.Id), mutationToken);
        }

        if (imageRunIds.Length > 0)
        {
            var runArtifactIds = runArtifacts.Select(x => x.Id).ToArray();
            if (runArtifactIds.Length > 0)
                await _db.UploadArtifacts.DeleteManyAsync(x => runArtifactIds.Contains(x.Id), mutationToken);
            await _db.ImageGenRunItems.DeleteManyAsync(x => imageRunIds.Contains(x.RunId), mutationToken);
            await _db.ImageGenRunEvents.DeleteManyAsync(x => imageRunIds.Contains(x.RunId), mutationToken);
            await _db.ImageGenRuns.DeleteManyAsync(x => imageRunIds.Contains(x.Id), mutationToken);
        }

        var recentOpenFilter = Builders<UserRecentOpen>.Filter.Eq(x => x.EntityId, workspaceId)
            & Builders<UserRecentOpen>.Filter.In(x => x.AgentKey, ["visual-agent", "literary-agent"]);
        await _db.UserRecentOpens.DeleteManyAsync(recentOpenFilter, mutationToken);
        await _db.ImageMasterWorkspaces.DeleteOneAsync(x => x.Id == workspaceId, mutationToken);

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

        var upperSha = sha.ToUpperInvariant();
        if (await _db.ReferenceImageConfigs.CountDocumentsAsync(
                item => item.ImageSha256 == sha || item.ImageSha256 == upperSha,
                cancellationToken: ct) > 0)
        {
            return false;
        }

        if (await _db.LiteraryAgentConfigs.CountDocumentsAsync(
                item => item.ReferenceImageSha256 == sha || item.ReferenceImageSha256 == upperSha,
                cancellationToken: ct) > 0)
        {
            return false;
        }

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
