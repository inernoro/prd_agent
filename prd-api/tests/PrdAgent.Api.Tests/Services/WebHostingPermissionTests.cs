using System.Collections.Generic;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

/// <summary>
/// 网页托管 owner/editor/viewer 角色策略的纯单测（无 DB，CI 全跑）。
/// 「能看到哪些站点」的隔离铁律在 DB 层（HostedSiteService.OwnerOrMemberFilter）由 CDS 集成测试守；
/// 本文件锁的是「在可见站点上能做什么」的角色矩阵 + 角色解析/继承/取最宽松，确保门控不被悄悄改松。
/// </summary>
public class WebHostingPermissionTests
{
    // ── 角色继承解析 ──

    [Theory]
    [InlineData(null, TeamRole.Admin, WebHostingRoles.Owner)]   // 管理员无显式角色 → owner
    [InlineData(null, TeamRole.Member, WebHostingRoles.Editor)] // 成员无显式角色 → editor（保住决策10「可编辑」）
    [InlineData("", TeamRole.Member, WebHostingRoles.Editor)]   // 空串视同未设
    [InlineData("bogus", TeamRole.Admin, WebHostingRoles.Owner)] // 非法值回退继承
    [InlineData(WebHostingRoles.Viewer, TeamRole.Admin, WebHostingRoles.Viewer)] // 显式 viewer 覆盖 admin 继承
    [InlineData(WebHostingRoles.Editor, TeamRole.Member, WebHostingRoles.Editor)]
    [InlineData(WebHostingRoles.Owner, TeamRole.Member, WebHostingRoles.Owner)]  // 显式 owner 可高于团队角色
    public void Resolve_AppliesOverrideThenInheritance(string? explicitRole, string teamRole, string expected)
    {
        Assert.Equal(expected, WebHostingRoles.Resolve(explicitRole, teamRole));
    }

    // ── 跨团队取最宽松 ──

    [Theory]
    [InlineData(WebHostingRoles.Viewer, WebHostingRoles.Editor, WebHostingRoles.Editor)]
    [InlineData(WebHostingRoles.Editor, WebHostingRoles.Owner, WebHostingRoles.Owner)]
    [InlineData(WebHostingRoles.Viewer, null, WebHostingRoles.Viewer)]
    [InlineData(null, null, null)]
    public void Max_PicksMostPermissive(string? a, string? b, string? expected)
    {
        Assert.Equal(expected, WebHostingPermission.Max(a, b));
        Assert.Equal(expected, WebHostingPermission.Max(b, a)); // 对称
    }

    // ── 站点角色解析（隔离铁律的纯计算核心）──

    [Fact]
    public void ResolveSiteRole_SiteCreator_AlwaysOwner()
    {
        var role = WebHostingPermission.ResolveSiteRole(
            isSiteOwner: true, sharedTeamIds: null, myTeamRoles: new Dictionary<string, string>());
        Assert.Equal(WebHostingRoles.Owner, role);
    }

    [Fact]
    public void ResolveSiteRole_NotOwner_NoSharedTeams_IsNull()
    {
        var role = WebHostingPermission.ResolveSiteRole(
            isSiteOwner: false, sharedTeamIds: null, myTeamRoles: new Dictionary<string, string> { ["t1"] = WebHostingRoles.Owner });
        Assert.Null(role);
    }

    [Fact]
    public void ResolveSiteRole_SharedToTeamIAmNotIn_IsNull()
    {
        // 站点共享给 t9，但我只在 t1 → 无交集 → 不可访问。这是防窜数据铁律的纯计算证明。
        var role = WebHostingPermission.ResolveSiteRole(
            isSiteOwner: false, sharedTeamIds: new[] { "t9" },
            myTeamRoles: new Dictionary<string, string> { ["t1"] = WebHostingRoles.Editor });
        Assert.Null(role);
    }

    [Fact]
    public void ResolveSiteRole_MultipleSharedTeams_TakesMostPermissive()
    {
        var role = WebHostingPermission.ResolveSiteRole(
            isSiteOwner: false, sharedTeamIds: new[] { "t1", "t2", "t3" },
            myTeamRoles: new Dictionary<string, string>
            {
                ["t1"] = WebHostingRoles.Viewer,
                ["t2"] = WebHostingRoles.Owner,  // 最宽松
                // t3 我不在
            });
        Assert.Equal(WebHostingRoles.Owner, role);
    }

    // ── 能力矩阵 ──

    [Theory]
    // viewer：只读
    [InlineData(WebHostingRoles.Viewer, WebHostingAction.Read, true)]
    [InlineData(WebHostingRoles.Viewer, WebHostingAction.Edit, false)]
    [InlineData(WebHostingRoles.Viewer, WebHostingAction.CreateShare, false)]
    [InlineData(WebHostingRoles.Viewer, WebHostingAction.Delete, false)]
    [InlineData(WebHostingRoles.Viewer, WebHostingAction.ManageRoles, false)]
    // editor：读 + 编辑 + 建分享；不能删别人、不能管角色
    [InlineData(WebHostingRoles.Editor, WebHostingAction.Read, true)]
    [InlineData(WebHostingRoles.Editor, WebHostingAction.Edit, true)]
    [InlineData(WebHostingRoles.Editor, WebHostingAction.CreateShare, true)]
    [InlineData(WebHostingRoles.Editor, WebHostingAction.Delete, false)]
    [InlineData(WebHostingRoles.Editor, WebHostingAction.ManageRoles, false)]
    // owner：全开
    [InlineData(WebHostingRoles.Owner, WebHostingAction.Read, true)]
    [InlineData(WebHostingRoles.Owner, WebHostingAction.Edit, true)]
    [InlineData(WebHostingRoles.Owner, WebHostingAction.CreateShare, true)]
    [InlineData(WebHostingRoles.Owner, WebHostingAction.Delete, true)]
    [InlineData(WebHostingRoles.Owner, WebHostingAction.ManageRoles, true)]
    public void Can_NonOwnerActor_FollowsRoleMatrix(string role, WebHostingAction action, bool expected)
    {
        Assert.Equal(expected, WebHostingPermission.Can(role, action, isSiteOwner: false));
    }

    [Theory]
    [InlineData(WebHostingAction.Read)]
    [InlineData(WebHostingAction.Edit)]
    [InlineData(WebHostingAction.CreateShare)]
    [InlineData(WebHostingAction.Delete)]
    [InlineData(WebHostingAction.ManageRoles)]
    public void Can_SiteCreator_AllActionsAllowed_EvenWithNullRole(WebHostingAction action)
    {
        // 站点创建者短路：哪怕角色解析为 null（不在任何团队），对自己的站点也完全可控
        Assert.True(WebHostingPermission.Can(null, action, isSiteOwner: true));
    }

    [Theory]
    [InlineData(WebHostingAction.Read)]
    [InlineData(WebHostingAction.Edit)]
    [InlineData(WebHostingAction.Delete)]
    [InlineData(WebHostingAction.CreateShare)]
    [InlineData(WebHostingAction.ManageRoles)]
    public void Can_NullRole_NonOwner_DeniesEverything(WebHostingAction action)
    {
        // 非成员（role 解析为 null）一律拒绝——读也不行（读由上层 OwnerOrMemberFilter 决定可见集）
        Assert.False(WebHostingPermission.Can(null, action, isSiteOwner: false));
    }
}
