using System.Reflection;
using System.Text.Json;
using PrdAgent.Api.Authentication;
using PrdAgent.Api.Controllers.Api;
using PrdAgent.Core.Security;
using Xunit;

namespace PrdAgent.Api.Tests.Authentication;

/// <summary>
/// 稳定冒烟巡检身份权限契约。
/// 2026-09-14 巡检：自动开号只给了 Agent 体验者角色，录音 / 文件 / 短视频 / 会话权限四个模块
/// 三十余项在业务动作之前就被权限中间件挡成「无权限」。这组测试让那次事故在单测层可复现：
/// 旧角色确实缺项、策略确实覆盖矩阵触达的每个控制器、e2e 夹具与后端策略一字不差。
/// </summary>
public sealed class StableSmokeIdentityPolicyTests
{
    /// <summary>矩阵触达的管理控制器，以及矩阵是否会对它做写操作。</summary>
    public static IEnumerable<object[]> MatrixControllers => new[]
    {
        new object[] { typeof(DocumentStoreController), true },
        new object[] { typeof(ShortVideoMaterialController), true },
        new object[] { typeof(UsersController), true },
        new object[] { typeof(AuthOpsController), true },
        new object[] { typeof(UserAuthzController), true },
        new object[] { typeof(AuthzController), false },
        new object[] { typeof(ImageGenController), true },
        new object[] { typeof(ImageMasterController), true },
        new object[] { typeof(UploadArtifactsController), false },
        new object[] { typeof(VisualModelPolicyController), false },
        new object[] { typeof(WebPagesController), true },
        new object[] { typeof(TranscriptAgentController), false },
        new object[] { typeof(VideoAgentController), true },
        new object[] { typeof(LiteraryAgentWorkspaceController), true },
    };

    [Fact]
    public void RequiredPermissions_ShouldAllExistInCatalog()
    {
        var catalog = AdminPermissionCatalog.All.Select(item => item.Key).ToHashSet(StringComparer.Ordinal);
        var unknown = StableSmokeIdentityPolicy.RequiredPermissions.Where(item => !catalog.Contains(item)).ToList();

        Assert.True(unknown.Count == 0, $"策略里出现了权限目录不认识的权限点：{string.Join(",", unknown)}");
        Assert.Equal(
            StableSmokeIdentityPolicy.RequiredPermissions.Count,
            StableSmokeIdentityPolicy.RequiredPermissions.Distinct(StringComparer.Ordinal).Count());
    }

    [Theory]
    [MemberData(nameof(MatrixControllers))]
    public void RequiredPermissions_ShouldCoverEveryControllerTheMatrixTouches(Type controller, bool matrixWrites)
    {
        var attribute = controller.GetCustomAttribute<AdminControllerAttribute>();
        Assert.NotNull(attribute);

        var required = StableSmokeIdentityPolicy.RequiredPermissions.ToHashSet(StringComparer.Ordinal);
        Assert.True(
            required.Contains(attribute!.ReadPermission),
            $"{controller.Name} 的读权限 {attribute.ReadPermission} 不在稳定冒烟身份策略里，巡检读路径会被挡成「无权限」");
        if (matrixWrites)
        {
            var write = attribute.WritePermission ?? attribute.ReadPermission;
            Assert.True(
                required.Contains(write),
                $"{controller.Name} 的写权限 {write} 不在稳定冒烟身份策略里，巡检写路径会被挡成「无权限」");
        }
    }

    [Fact]
    public void LegacyProvisionedRole_AloneCannotRunTheMatrix()
    {
        // 这就是 2026-09-14 那一轮的外因：自动开号只给 Agent 体验者角色。
        var legacy = BuiltInSystemRoles.Definitions
            .Single(role => role.Key == StableSmokeIdentityPolicy.ProvisionedSystemRoleKey)
            .Permissions;

        var missing = StableSmokeIdentityPolicy.MissingPermissions(legacy);

        Assert.Contains(AdminPermissionCatalog.DocumentStoreWrite, missing);
        Assert.Contains(AdminPermissionCatalog.UsersWrite, missing);
        Assert.Contains(AdminPermissionCatalog.AuthzManage, missing);
    }

    [Fact]
    public void MissingPermissions_ShouldBeEmptyOnceRequiredSetIsGranted()
    {
        var legacy = BuiltInSystemRoles.Definitions
            .Single(role => role.Key == StableSmokeIdentityPolicy.ProvisionedSystemRoleKey)
            .Permissions;
        var granted = legacy.Concat(StableSmokeIdentityPolicy.RequiredPermissions);

        Assert.Empty(StableSmokeIdentityPolicy.MissingPermissions(granted));
        Assert.Empty(StableSmokeIdentityPolicy.MissingPermissions(new[] { AdminPermissionCatalog.Super }));
        Assert.Equal(
            StableSmokeIdentityPolicy.RequiredPermissions,
            StableSmokeIdentityPolicy.MissingPermissions(Array.Empty<string>()));
    }

    [Fact]
    public void KeyOptions_ShouldManagePermissionsByDefault()
    {
        // 代码默认开启：CDS 平台的 compose 配置快照不会随仓库自动同步（REG-llmgw-auth-001），
        // 若默认关闭，验证环境在快照更新前会静默失去补权能力。生产安全由 compose 显式传 false 保证（见下一条）。
        Assert.True(new StableSmokePublicKeyOptions().ManagePermissions);
    }

    [Theory]
    [InlineData("docker-compose.yml", "StableSmokeAuthentication__Keys__0__ManagePermissions=${STABLE_SMOKE_MANAGE_PERMISSIONS:-false}")]
    [InlineData("docker-compose.dev.yml", "StableSmokeAuthentication__Keys__0__ManagePermissions=${STABLE_SMOKE_MANAGE_PERMISSIONS:-false}")]
    [InlineData("cds-compose.yml", "StableSmokeAuthentication__Keys__0__ManagePermissions: \"true\"")]
    public void Deployments_ShouldWireManagePermissionsExplicitly(string composeFile, string expectedLine)
    {
        // 部署文件必须显式接上这个开关：正式与本地默认 false，CDS 验证环境 true。
        // 少了这一行，文档里写的「正式环境可关闭」就是一句空话（Codex review 2026-09-15 P1）。
        var compose = File.ReadAllText(LocateRepositoryFile(composeFile));
        Assert.Contains(expectedLine, compose);
    }

    [Fact]
    public void E2eFixture_ShouldMirrorBackendPolicy()
    {
        var fixturePath = LocateRepositoryFile(Path.Combine("e2e", "fixtures", "stable-smoke-required-permissions.json"));
        using var document = JsonDocument.Parse(File.ReadAllText(fixturePath));
        var fixture = document.RootElement.GetProperty("requiredPermissions")
            .EnumerateArray()
            .Select(item => item.GetString() ?? string.Empty)
            .ToList();

        Assert.Equal(StableSmokeIdentityPolicy.RequiredPermissions, fixture);
    }

    private static string LocateRepositoryFile(string relativePath)
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory is not null)
        {
            var candidate = Path.Combine(directory.FullName, relativePath);
            if (File.Exists(candidate)) return candidate;
            directory = directory.Parent;
        }
        throw new FileNotFoundException($"从 {AppContext.BaseDirectory} 向上找不到 {relativePath}，跨语言契约无法核对");
    }
}
