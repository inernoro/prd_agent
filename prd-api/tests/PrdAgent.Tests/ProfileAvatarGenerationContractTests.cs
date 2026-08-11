using Xunit;

namespace PrdAgent.Tests;

public class ProfileAvatarGenerationContractTests
{
    [Fact]
    public void ProfileAvatarGeneration_MustUseBackgroundRunAndServerOwnedSource()
    {
        var source = File.ReadAllText(LocateRepoFile(
            "prd-api/src/PrdAgent.Api/Controllers/Api/ProfileController.cs"));

        Assert.Contains("[HttpPost(\"avatar/generation-runs\")]", source);
        Assert.Contains("Status = ImageGenRunStatus.ScopedQueued", source);
        Assert.Contains("AppCallerCode = AppCallerRegistry.VisualAgent.Image.Img2Img", source);
        Assert.Contains("InitImageAssetSha256 = sourceAsset.Sha256", source);
        Assert.Contains("InsertOneAsync(run, cancellationToken: CancellationToken.None)", source);
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
        Assert.Contains("ServerErrorCategory.DuplicateKey", source);
        Assert.Contains("BuildAvatarGenerationAccepted(existingRun)", source);
        Assert.Contains("return new { runId = run.Id, status, stage };", source);
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
        Assert.Contains("UploadArtifacts.InsertOneAsync(new UploadArtifact", googleBranch);
        Assert.Contains("RequestId = requestId", googleBranch);
        Assert.Contains("CreatedByAdminId = createdByAdminId", googleBranch);
        Assert.Contains("Kind = \"output_image\"", googleBranch);
    }

    [Fact]
    public void ProfileAvatarGeneration_MustNotExposeWorkerDiagnosticToUser()
    {
        var source = File.ReadAllText(LocateRepoFile(
            "prd-api/src/PrdAgent.Api/Controllers/Api/ProfileController.cs"));

        Assert.Contains("BuildAvatarGenerationFailure(run.Status)", source);
        Assert.Contains("头像生成暂时未完成，请稍后重试", source);
        Assert.DoesNotContain("item.ErrorMessage", source);
    }

    [Fact]
    public void ProfileAvatarPersistence_MustChangePublicObjectKeyWhenContentChanges()
    {
        var source = File.ReadAllText(LocateRepoFile(
            "prd-api/src/PrdAgent.Api/Controllers/Api/ProfileController.cs"));

        Assert.Contains("BuildVersionedAvatarFileName(currentUserId, ext, bytes)", source);
        Assert.Contains("BuildVersionedAvatarFileName(currentUserId, ext, found.Value.bytes)", source);
        Assert.Contains("SHA256.HashData(bytes)", source);
        Assert.DoesNotContain("$\"{usernameLower}.{ext}\"", source);
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
