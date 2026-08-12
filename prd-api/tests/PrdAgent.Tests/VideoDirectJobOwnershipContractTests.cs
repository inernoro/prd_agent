using Xunit;

namespace PrdAgent.Tests;

public class VideoDirectJobOwnershipContractTests
{
    [Fact]
    public void DirectVideoStatusAndContent_MustRequirePersistedOwnerMatch()
    {
        var controller = File.ReadAllText(LocateRepoFile(
            "prd-api/src/PrdAgent.Api/Controllers/Api/VideoAgentController.cs"));
        var models = File.ReadAllText(LocateRepoFile(
            "prd-api/src/PrdAgent.Core/Models/VideoGenModels.cs"));
        var database = File.ReadAllText(LocateRepoFile(
            "prd-api/src/PrdAgent.Infrastructure/Database/MongoDbContext.cs"));
        var indexCatalog = File.ReadAllText(LocateRepoFile("scripts/mongodb-indexes.js"));
        var initializer = File.ReadAllText(LocateRepoFile(
            "prd-api/src/PrdAgent.Infrastructure/Database/DatabaseInitializer.cs"));

        Assert.Contains("class DirectVideoJobOwnership", models);
        Assert.Contains("ExpiresAt", models);
        Assert.Contains("RevokedAt", models);
        Assert.Contains("DirectVideoJobOwnerships", database);
        Assert.Contains("uniq_direct_video_job_app_job", database);
        Assert.Contains("Unique = true", database[database.IndexOf("uniq_direct_video_job_app_job", StringComparison.Ordinal)..]);
        Assert.Contains("CreateDirectVideoJobRecoveryToken(ownership)", controller);
        Assert.Contains("TryPersistDirectVideoJobOwnershipAsync(ownership)", controller);
        Assert.Contains("item.RevokedAt == null", controller);
        Assert.Contains("return ownershipRestored ? recovered : null", controller);
        Assert.Contains("dataProtectionProvider.CreateProtector", controller);
        Assert.Contains("[FromQuery] string? recoveryToken", controller);
        Assert.Contains("TryReadDirectVideoJobRecoveryToken", controller);
        Assert.Contains("item.JobId == jobId && item.OwnerAdminId == ownerAdminId && item.AppKey == AppKey", controller);
        Assert.Equal(2, controller.Split("var ownership = await FindOwnedDirectVideoJobAsync(jobId, recoveryToken);", StringSplitOptions.None).Length - 1);
        Assert.Equal(2, controller.Split("视频任务不存在或不可访问，请从本人的任务记录重新打开", StringSplitOptions.None).Length - 1);
        Assert.Contains("expectedModel: ownership.Model", controller);
        Assert.Contains("[HttpDelete(\"videogen-direct/{jobId}\")]", controller);
        Assert.Contains("[FromQuery] string? recoveryToken", controller);
        Assert.Contains("Set(item => item.RevokedAt, revokedAt)", controller);
        Assert.Contains("撤销墓碑保留到恢复凭证过期", controller);
        Assert.Contains("db.direct_video_job_ownerships.updateMany", indexCatalog);
        Assert.Contains("ttl_direct_video_job_expires_at", indexCatalog);
        Assert.DoesNotContain("EnsureDirectVideoJobOwnershipIndexesAsync", initializer);
    }

    private static string LocateRepoFile(string relativePath)
    {
        var current = new DirectoryInfo(AppContext.BaseDirectory);
        while (current != null)
        {
            var candidate = Path.Combine(current.FullName, relativePath.Replace('/', Path.DirectorySeparatorChar));
            if (File.Exists(candidate)) return candidate;
            current = current.Parent;
        }

        throw new FileNotFoundException($"找不到仓库文件：{relativePath}");
    }
}
