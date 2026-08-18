using Xunit;

namespace PrdAgent.Tests;

public sealed class AdminBootstrapWiringContractTests
{
    [Fact]
    public void FirstRunAndManualReset_ShouldUseTheSameFailClosedCredentialResolver()
    {
        var initializer = ReadRepoFile(
            "prd-api/src/PrdAgent.Infrastructure/Database/DatabaseInitializer.cs");
        var controller = ReadRepoFile(
            "prd-api/src/PrdAgent.Api/Controllers/Api/UsersController.cs");

        Assert.Contains("InitialAdminCredentials.Resolve(_configuration)", initializer);
        Assert.Contains("InitialAdminCredentials.Resolve(_cfg)", controller);
        Assert.DoesNotContain("HashPassword(\"admin\")", initializer);
        Assert.DoesNotContain("HashPassword(\"admin\")", controller);
        Assert.Contains("MAP_ALLOW_USER_REINITIALIZATION", controller);
        Assert.True(
            controller.IndexOf("MAP_ALLOW_USER_REINITIALIZATION", StringComparison.Ordinal)
            < controller.IndexOf("DeleteManyAsync", StringComparison.Ordinal));
        Assert.True(
            controller.IndexOf("InitialAdminCredentials.Resolve(_cfg)", StringComparison.Ordinal)
            < controller.IndexOf("DeleteManyAsync", StringComparison.Ordinal));
    }

    [Fact]
    public void DevelopmentCompose_ShouldForwardBothSupportedBootstrapCredentialPairs()
    {
        var compose = ReadRepoFile("docker-compose.dev.yml");

        Assert.Contains("MAP_INITIAL_ADMIN_USERNAME=${MAP_INITIAL_ADMIN_USERNAME:-}", compose);
        Assert.Contains("MAP_INITIAL_ADMIN_PASSWORD=${MAP_INITIAL_ADMIN_PASSWORD:-}", compose);
        Assert.Contains("ROOT_ACCESS_USERNAME=${ROOT_ACCESS_USERNAME:-}", compose);
        Assert.Contains("ROOT_ACCESS_PASSWORD=${ROOT_ACCESS_PASSWORD:-}", compose);
        Assert.DoesNotContain("MAP_INITIAL_ADMIN_PASSWORD=admin", compose, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("ROOT_ACCESS_PASSWORD=admin", compose, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void PublicLoginAndResetViews_ShouldNotAdvertiseAStaticCredential()
    {
        var login = ReadRepoFile("prd-admin/src/pages/LoginPage.tsx");
        var users = ReadRepoFile("prd-admin/src/pages/UsersPage.tsx");
        var services = ReadRepoFile("prd-admin/src/services/index.ts");

        Assert.DoesNotContain("admin / admin", login, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("admin/admin", users, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("handleInitializeUsers", users, StringComparison.Ordinal);
        Assert.DoesNotContain("initializeUsersReal", services, StringComparison.Ordinal);
        Assert.Contains("部署环境安全注入", login);
    }

    [Fact]
    public void InitialInviteCode_ShouldBeRandomAndNeverPrinted()
    {
        var initializer = ReadRepoFile(
            "prd-api/src/PrdAgent.Infrastructure/Database/DatabaseInitializer.cs");

        Assert.Contains("RandomNumberGenerator.GetBytes", initializer);
        Assert.DoesNotContain("PRD-INIT-2024", initializer);
        Assert.DoesNotContain("inviteCode.Code", initializer);
    }

    [Fact]
    public void SensitiveUserAdministration_ShouldPersistTheAuthenticatedActor()
    {
        var registry = ReadRepoFile(
            "prd-api/src/PrdAgent.Api/Filters/ActivityActionRegistry.cs");
        var filter = ReadRepoFile(
            "prd-api/src/PrdAgent.Api/Filters/ActivityLogActionFilter.cs");

        Assert.Contains("Users.UpdatePassword", registry);
        Assert.Contains("Users.InitializeUsers", registry);
        Assert.Contains("ActorId = actorId", filter);
        Assert.Contains("ActivityLogs.InsertOneAsync", filter);
    }

    private static string ReadRepoFile(string relativePath)
    {
        var current = new DirectoryInfo(AppContext.BaseDirectory);
        while (current is not null)
        {
            var candidate = Path.Combine(
                current.FullName,
                relativePath.Replace('/', Path.DirectorySeparatorChar));
            if (File.Exists(candidate)) return File.ReadAllText(candidate);
            current = current.Parent;
        }

        throw new FileNotFoundException($"找不到仓库文件：{relativePath}");
    }
}
