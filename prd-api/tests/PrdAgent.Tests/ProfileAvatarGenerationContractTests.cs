using Xunit;
using PrdAgent.Infrastructure.Services.AssetStorage;

namespace PrdAgent.Tests;

public class ProfileAvatarGenerationContractTests
{
    [Fact]
    public void ProfileAvatarGeneration_MustUseBackgroundRunAndServerOwnedSource()
    {
        var source = File.ReadAllText(LocateRepoFile(
            "prd-api/src/PrdAgent.Api/Controllers/Api/ProfileController.cs"));

        Assert.Contains("[HttpPost(\"avatar/generation-runs\")]", source);
        Assert.Contains("Status = ImageGenRunStatus.Cancelled", source);
        Assert.Contains("Builders<ImageGenRun>.Update.Set(x => x.Status, ImageGenRunStatus.ScopedQueued)", source);
        Assert.Contains("AppCallerCode = AppCallerRegistry.VisualAgent.Image.Img2Img", source);
        Assert.Contains("InitImageAssetSha256 = sourceSha256", source);
        Assert.Contains("$\"generated-image:{sourceSha256}\"", source);
        Assert.Contains("ErrorCodes.AVATAR_PROMPT_TOO_LONG", source);
        Assert.Contains("InsertOneAsync(run, cancellationToken: CancellationToken.None)", source);
        Assert.True(
            source.IndexOf("InsertOneAsync(run", StringComparison.Ordinal)
            < source.IndexOf("_assetStorage.SaveAsync", StringComparison.Ordinal));
        Assert.Contains("QueueRunCleanup(run.Id, currentUserId)", source);
        Assert.DoesNotContain("RequestAborted", source);
    }

    [Fact]
    public void ProfileAvatarGeneration_MustEnforceVisualCreationPermissionOnServer()
    {
        var source = File.ReadAllText(LocateRepoFile(
            "prd-api/src/PrdAgent.Api/Controllers/Api/ProfileController.cs"));

        Assert.Contains("HasPermission(AdminPermissionCatalog.VisualAgentUse)", source);
        Assert.Contains("StatusCodes.Status403Forbidden", source);
        Assert.Contains("ErrorCodes.PERMISSION_DENIED", source);
        Assert.Contains("请联系管理员开通后重试", source);
    }

    [Fact]
    public void ProfileAvatarGeneration_MustReuseRunForScopedIdempotencyKey()
    {
        var source = File.ReadAllText(LocateRepoFile(
            "prd-api/src/PrdAgent.Api/Controllers/Api/ProfileController.cs"));

        Assert.Contains("Request.Headers[\"Idempotency-Key\"]", source);
        Assert.Contains("DeploymentScope.ScopeIdempotencyKey($\"{ProfileAvatarRunAppKey}::", source);
        Assert.Contains("x.IdempotencyKey == idempotencyKey", source);
        Assert.Contains("IdempotencyKey = string.IsNullOrWhiteSpace(idempotencyKey) ? null : idempotencyKey", source);
        Assert.Contains("BuildAvatarGenerationRunId(currentUserId, idempotencyKey)", source);
        Assert.Contains("ServerErrorCategory.DuplicateKey", source);
        Assert.Contains("BuildAvatarGenerationAccepted(existingRun)", source);
        Assert.Contains("RecoverProvisionalAvatarRunAsync(existingRun, currentUserId)", source);
        Assert.Contains("TryReadByShaAsync(", source);
        Assert.Contains("DeleteOneAsync(", source);
        Assert.Contains("return new { runId = run.Id, status, stage };", source);

        var databaseSource = File.ReadAllText(LocateRepoFile(
            "prd-api/src/PrdAgent.Infrastructure/Database/MongoDbContext.cs"));
        var indexStart = databaseSource.IndexOf("uniq_image_gen_runs_owner_idem", StringComparison.Ordinal);
        Assert.True(indexStart >= 0);
        var indexDefinition = databaseSource[indexStart..Math.Min(databaseSource.Length, indexStart + 500)];
        Assert.Contains("Unique = true", indexDefinition);

        var catalogSource = File.ReadAllText(LocateRepoFile("scripts/mongodb-indexes.js"));
        var catalogIndexStart = catalogSource.IndexOf(
            "ensureTightenedUniqueIndex(\"image_gen_runs\"",
            StringComparison.Ordinal);
        Assert.True(catalogIndexStart >= 0);
        var catalogIndexDefinition = catalogSource[
            catalogIndexStart..Math.Min(catalogSource.Length, catalogIndexStart + 600)];
        Assert.Contains("uniq_image_gen_runs_owner_idem", catalogIndexDefinition);
        Assert.DoesNotContain("[],\n  true", catalogIndexDefinition);
        Assert.Contains("prepareUnique: true", catalogSource);
        Assert.Contains("replaceLegacyUniqueIndex(collectionName, collection, existing, keys, options)", catalogSource);
    }

    [Fact]
    public void GoogleAvatarGeneration_MustPersistTraceableOutputArtifact()
    {
        var source = File.ReadAllText(LocateRepoFile(
            "prd-api/src/PrdAgent.Infrastructure/LLM/OpenAIImageClient.cs"));

        var googleBranchStart = source.IndexOf("var isGoogleResponse", StringComparison.Ordinal);
        var standardBranchStart = source.IndexOf("var images = new List<ImageGenImage>();", googleBranchStart, StringComparison.Ordinal);
        Assert.True(googleBranchStart >= 0 && standardBranchStart > googleBranchStart);
        var googleBranch = source[googleBranchStart..standardBranchStart];
        Assert.Contains("SaveGeneratedOutputAsync(", googleBranch);
        Assert.Contains("UploadArtifacts.InsertOneAsync(new UploadArtifact", source);
        Assert.Contains("RequestId = requestId", source);
        Assert.Contains("CreatedByAdminId = createdByAdminId", source);
        Assert.Contains("Kind = \"output_image\"", source);
    }

    [Fact]
    public void ProfileAvatarGeneration_MustNotExposeWorkerDiagnosticToUser()
    {
        var source = File.ReadAllText(LocateRepoFile(
            "prd-api/src/PrdAgent.Api/Controllers/Api/ProfileController.cs"));

        Assert.Contains("BuildAvatarGenerationFailure(run.Status, itemErrorCode)", source);
        Assert.Contains("_db.ImageGenRunItems", source);
        Assert.Contains("itemErrorCode = failedItem?.ErrorCode", source);
        Assert.Contains("\"IMAGE_GEN_REQUEST_REJECTED\" or \"CONTENT_REJECTED\"", source);
        Assert.Contains("\"LLM_QUOTA_EXCEEDED\" or \"QUOTA_EXCEEDED\"", source);
        Assert.Contains("头像生成暂时未完成，请稍后重试", source);
        Assert.DoesNotContain("item.ErrorMessage", source);
    }

    [Fact]
    public void ProfileAvatarGeneration_MustStreamSanitizedStatusWithPollingFallback()
    {
        var controller = File.ReadAllText(LocateRepoFile(
            "prd-api/src/PrdAgent.Api/Controllers/Api/ProfileController.cs"));
        var frontend = File.ReadAllText(LocateRepoFile(
            "prd-admin/src/services/real/profile.ts"));
        var worker = File.ReadAllText(LocateRepoFile(
            "prd-api/src/PrdAgent.Api/Services/ImageGenRunWorker.cs"));

        Assert.Contains("avatar/generation-runs/{runId}/stream", controller);
        Assert.Contains("RunKinds.ImageGen", controller);
        Assert.Contains("BuildAvatarGenerationStatusAsync", controller);
        Assert.Contains("event: status", controller);
        Assert.Contains("connectSse", frontend);
        Assert.Contains("avatarGenerationRunStream", frontend);
        Assert.Contains("SSE 被代理或旧版本服务阻断时才降级轮询", frontend);
        Assert.DoesNotContain("AVATAR_GENERATION_POLL_INTERVAL_MS = 800", frontend);
        Assert.Contains("ClaimRetiredAvatarRunAsync", worker);
        Assert.Contains("ImageGenRunStatus.Running", worker);
        Assert.Contains("Builders<ImageGenRun>.Filter.Eq(x => x.Status, ImageGenRunStatus.ScopedQueued)", worker);
        Assert.DoesNotContain("Builders<ImageGenRun>.Filter.Lte(x => x.StartedAt", worker);
        Assert.Contains("没有可续期租约就不能证明原 Worker 已停止", worker);
        Assert.Contains("DeploymentScope.CurrentDurable", worker);
        Assert.Contains("ProfileAvatarGenerationCleanupService.AppKey", worker);
        Assert.Contains("catch (ObjectDisposedException)", controller);
    }

    [Fact]
    public void ProfileAvatarPersistence_MustChangePublicObjectKeyWhenContentChanges()
    {
        var source = File.ReadAllText(LocateRepoFile(
            "prd-api/src/PrdAgent.Api/Controllers/Api/ProfileController.cs"));
        var cleanup = File.ReadAllText(LocateRepoFile(
            "prd-api/src/PrdAgent.Api/Services/ProfileAvatarGenerationCleanupService.cs"));

        Assert.Contains("BuildVersionedAvatarFileName(currentUserId, ext, bytes)", source);
        Assert.Contains("BuildVersionedAvatarFileName(currentUserId, ext, found.Value.bytes)", source);
        Assert.Contains("SHA256.HashData(bytes)", source);
        Assert.Contains("FindOneAndUpdateAsync", source);
        Assert.Contains("DeleteSupersededAvatarAsync", source);
        Assert.Contains("TrackAndTryDeleteSupersededAvatarAsync", source);
        Assert.Contains("TrackPendingAvatarObjectAsync", source);
        Assert.Contains("CancelPendingAvatarObjectCleanupAsync", source);
        Assert.Contains("ProfileAvatarObjectCleanupTasks.ReplaceOneAsync", cleanup);
        Assert.Contains("DeleteByKeyAsync", cleanup);
        Assert.DoesNotContain("$\"{usernameLower}.{ext}\"", source);
    }

    [Fact]
    public void ProfileAvatarGeneration_MustCleanAppliedAndExpiredArtifactsSafely()
    {
        var controller = File.ReadAllText(LocateRepoFile(
            "prd-api/src/PrdAgent.Api/Controllers/Api/ProfileController.cs"));
        var cleanup = File.ReadAllText(LocateRepoFile(
            "prd-api/src/PrdAgent.Api/Services/ProfileAvatarGenerationCleanupService.cs"));
        var adminUsers = File.ReadAllText(LocateRepoFile(
            "prd-api/src/PrdAgent.Api/Controllers/Api/UsersController.cs"));
        var program = File.ReadAllText(LocateRepoFile(
            "prd-api/src/PrdAgent.Api/Program.cs"));

        Assert.Contains("TryGetAvatarGenerationRunId(artifact.RequestId)", controller);
        Assert.Contains("_avatarGenerationCleanup.QueueRunCleanup", controller);
        Assert.Contains("Channel.CreateBounded", cleanup);
        Assert.Contains("while (_cleanupQueue.Reader.TryRead", cleanup);
        Assert.Contains("DefaultRetention = TimeSpan.FromHours(24)", cleanup);
        Assert.Contains("await CleanupExpiredAsync(now, stoppingToken)", cleanup);
        Assert.Contains("await CleanupPendingAvatarObjectsAsync(now, stoppingToken)", cleanup);
        Assert.Contains("ProfileAvatarObjectCleanupTasks.ReplaceOneAsync", cleanup);
        Assert.Contains("TrackPendingAvatarObjectAsync", cleanup);
        Assert.Contains("PersistAvatarObjectCleanupIntentAsync", cleanup);
        Assert.Contains("FindOneAndUpdateAsync", cleanup);
        Assert.Contains("NextAttemptAt", cleanup);
        Assert.Contains("await _assetStorage.DeleteByKeyAsync(task.ObjectKey, ct)", cleanup);
        Assert.Contains("currentAvatarFileName", cleanup);
        Assert.Contains("BuildUserMutationLeaseKey(task.UserId)", cleanup);
        Assert.Equal(
            3,
            controller.Split(
                "ProfileAvatarObjectCleanupPolicy.BuildUserMutationLeaseKey(currentUserId)",
                StringSplitOptions.None).Length - 1);
        Assert.True(
            adminUsers.Split(
                "ProfileAvatarObjectCleanupPolicy.BuildUserMutationLeaseKey",
                StringSplitOptions.None).Length - 1 >= 2);
        Assert.True(
            adminUsers.Split(
                "TrackAndTryDeleteSupersededAvatarAsync",
                StringSplitOptions.None).Length - 1 >= 2);
        var adminAvatarUpdate = adminUsers[
            adminUsers.IndexOf("UpdateUserAvatar", StringComparison.Ordinal)..
            adminUsers.IndexOf("UploadUserAvatar", StringComparison.Ordinal)];
        Assert.Contains("await _assetStorage.ExistsAsync(objectKey, ct)", adminAvatarUpdate);
        Assert.Contains("原头像未变更", adminAvatarUpdate);
        Assert.True(
            adminAvatarUpdate.IndexOf("await _assetStorage.ExistsAsync(objectKey, ct)", StringComparison.Ordinal)
            < adminAvatarUpdate.IndexOf("FindOneAndUpdateAsync", StringComparison.Ordinal));
        Assert.Contains("ReturnDocument = ReturnDocument.Before", adminUsers);
        Assert.True(
            cleanup.IndexOf("BuildUserMutationLeaseKey(task.UserId)", StringComparison.Ordinal)
            < cleanup.IndexOf("var currentAvatarFileName", StringComparison.Ordinal));
        Assert.Contains("while (!ct.IsCancellationRequested)", cleanup);
        Assert.Contains("Builders<ImageGenRun>.Filter.Nin(x => x.Id, failedRunIds)", cleanup);
        Assert.Contains("failedRunIds.Add(candidate.Id)", cleanup);
        Assert.Contains("if (candidates.Count == 0) break", cleanup);
        Assert.Contains("otherArtifactRefs == 0 && imageAssetRefs == 0 && otherRunRefs == 0", cleanup);
        Assert.Contains("ImageRefs.AssetSha256", cleanup);
        Assert.Contains("ImageGenRunItems.DeleteManyAsync", cleanup);
        Assert.Contains("ImageGenRunEvents.DeleteManyAsync", cleanup);
        Assert.Contains("ImageGenRuns.DeleteOneAsync", cleanup);
        Assert.Contains("AddHostedService(sp => sp.GetRequiredService<PrdAgent.Api.Services.ProfileAvatarGenerationCleanupService>())", program);
    }

    [Fact]
    public void ProfileAvatarFilenameUpdate_MustValidateOwnedObjectBeforeDatabaseMutation()
    {
        var source = File.ReadAllText(LocateRepoFile(
            "prd-api/src/PrdAgent.Api/Controllers/Api/ProfileController.cs"));
        var endpointStart = source.IndexOf("public async Task<IActionResult> UpdateMyAvatar", StringComparison.Ordinal);
        var endpointEnd = source.IndexOf("[HttpPatch(\"public-page\")]", endpointStart, StringComparison.Ordinal);
        Assert.True(endpointStart >= 0 && endpointEnd > endpointStart);
        var endpoint = source[endpointStart..endpointEnd];

        Assert.Contains("ProfileAvatarObjectCleanupPolicy.BuildOwnerPrefix(currentUserId)", endpoint);
        Assert.Contains("ProfileAvatarObjectCleanupPolicy.BuildUserMutationLeaseKey(currentUserId)", endpoint);
        Assert.Contains("await _assetStorage.ExistsAsync(objectKey, ct)", endpoint);
        Assert.True(
            endpoint.IndexOf("BuildUserMutationLeaseKey", StringComparison.Ordinal)
            < endpoint.IndexOf("ExistsAsync", StringComparison.Ordinal));
        Assert.True(
            endpoint.IndexOf("ExistsAsync", StringComparison.Ordinal)
            < endpoint.IndexOf("ReplaceAvatarFileNameAsync", StringComparison.Ordinal));
        Assert.Contains("DeleteSupersededAvatarAsync", endpoint);
        Assert.Contains("previousUser.AvatarFileName", endpoint);
        Assert.Contains("头像文件不存在，请重新上传或生成后再试", endpoint);
    }

    [Theory]
    [InlineData("icon/backups/head/u-0123456789ab-0123456789abcdef01234567.png", true)]
    [InlineData("data/icon/backups/head/u-0123456789ab-0123456789abcdef01234567.webp", true)]
    [InlineData("icon/backups/head/u-0123456789ab-0123456789abcdef01234567.exe", false)]
    [InlineData("icon/backups/head/legacy-avatar.png", false)]
    [InlineData("icon/backups/head/", false)]
    [InlineData("icon/backups/head/u-0123456789ab-0123456789abcdef01234567.png/extra", false)]
    public void AvatarDeletePolicy_MustOnlyAllowExactVersionedObject(string key, bool expected)
    {
        var prefix = key.StartsWith("data/", StringComparison.Ordinal) ? "data" : null;
        Assert.Equal(expected, AssetStorageDeletePolicy.IsVersionedUserAvatarKey(key, prefix));
    }

    private static string LocateRepoFile(string relativePath)
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir != null)
        {
            var candidate = Path.Combine(dir.FullName, relativePath);
            if (File.Exists(candidate)) return candidate;
            dir = dir.Parent;
        }

        throw new FileNotFoundException($"Cannot locate repository file: {relativePath}");
    }
}
