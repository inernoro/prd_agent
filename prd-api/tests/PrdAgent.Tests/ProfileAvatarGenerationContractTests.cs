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
