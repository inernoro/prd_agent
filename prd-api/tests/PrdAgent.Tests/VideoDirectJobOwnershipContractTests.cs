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

        Assert.Contains("class DirectVideoJobOwnership", models);
        Assert.Contains("DirectVideoJobOwnerships", database);
        Assert.Contains("uniq_direct_video_job_app_job", database);
        Assert.Contains("Unique = true", database[database.IndexOf("uniq_direct_video_job_app_job", StringComparison.Ordinal)..]);
        Assert.Contains("CreateDirectVideoJobRecoveryToken(ownership)", controller);
        Assert.Contains("TryPersistDirectVideoJobOwnershipAsync(ownership)", controller);
        Assert.Contains("new ReplaceOptions { IsUpsert = true }", controller);
        Assert.Contains("dataProtectionProvider.CreateProtector", controller);
        Assert.Contains("[FromQuery] string? recoveryToken", controller);
        Assert.Contains("TryReadDirectVideoJobRecoveryToken", controller);
        Assert.Contains("item.JobId == jobId && item.OwnerAdminId == ownerAdminId && item.AppKey == AppKey", controller);
        Assert.Equal(2, controller.Split("var ownership = await FindOwnedDirectVideoJobAsync(jobId, recoveryToken);", StringSplitOptions.None).Length - 1);
        Assert.Equal(2, controller.Split("视频任务不存在或不可访问，请从本人的任务记录重新打开", StringSplitOptions.None).Length - 1);
        Assert.Contains("expectedModel: ownership.Model", controller);
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
