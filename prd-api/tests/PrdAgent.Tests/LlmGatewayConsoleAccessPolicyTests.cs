using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using Xunit;

namespace PrdAgent.Tests;

public sealed class LlmGatewayConsoleAccessPolicyTests
{
    [Fact]
    public void 有网关权限时即使业务角色不是Admin也能进入()
    {
        var user = ActiveHuman(UserRole.QA);

        var allowed = LlmGatewayConsoleAccessPolicy.CanEnter(
            user,
            new[] { AdminPermissionCatalog.LlmGatewayAccess });

        Assert.True(allowed);
    }

    [Fact]
    public void 业务Admin角色不能绕过独立权限()
    {
        var user = ActiveHuman(UserRole.ADMIN);

        Assert.False(LlmGatewayConsoleAccessPolicy.CanEnter(user, Array.Empty<string>()));
    }

    [Fact]
    public void 其他管理权限不等于模型网关权限()
    {
        var user = ActiveHuman(UserRole.QA);

        Assert.False(LlmGatewayConsoleAccessPolicy.CanEnter(
            user,
            new[] { AdminPermissionCatalog.AuthzManage, AdminPermissionCatalog.ModelsWrite }));
    }

    [Fact]
    public void 超级权限可以进入()
    {
        var user = ActiveHuman(UserRole.QA);

        Assert.True(LlmGatewayConsoleAccessPolicy.CanEnter(
            user,
            new[] { AdminPermissionCatalog.Super }));
    }

    [Fact]
    public void 内置管理员默认拥有模型网关权限()
    {
        var admin = Assert.Single(BuiltInSystemRoles.Definitions, role => role.Key == "admin");

        Assert.Contains(AdminPermissionCatalog.LlmGatewayAccess, admin.Permissions);
    }

    [Theory]
    [InlineData(UserStatus.Disabled, UserType.Human)]
    [InlineData(UserStatus.Active, UserType.Bot)]
    public void 禁用账号或机器人账号不能进入(UserStatus status, UserType userType)
    {
        var user = ActiveHuman(UserRole.ADMIN);
        user.Status = status;
        user.UserType = userType;

        Assert.False(LlmGatewayConsoleAccessPolicy.CanEnter(
            user,
            new[] { AdminPermissionCatalog.LlmGatewayAccess }));
    }

    private static User ActiveHuman(UserRole role) => new()
    {
        UserId = "test-user",
        Username = "test-user",
        DisplayName = "测试用户",
        Role = role,
        Status = UserStatus.Active,
        UserType = UserType.Human,
    };
}
