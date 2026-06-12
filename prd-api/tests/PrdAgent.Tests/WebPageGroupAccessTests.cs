using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using Xunit;

namespace PrdAgent.Tests;

/// <summary>
/// 网页托管分组级权限纯策略测试（CI 可运行，纯函数无需 Mongo）。
///
/// 解析铁律锚点（见 WebPageGroupAccess）：
/// 1. inherit 分组完全跟随空间角色（存量数据零行为变化）
/// 2. restricted 分组：空间 owner 恒 owner；其余按规则命中取最宽松；无命中 = null（不可见）
/// 3. 规则可升格：空间 viewer 可被授予分组 editor
/// 4. 站点多团队共享时，分组只裁剪其所属团队那一路，其他团队角色不受影响
/// </summary>
public class WebPageGroupAccessTests
{
    private static WebPageGroup Inherit() => new() { Id = "g1", TeamId = "team-a" };

    private static WebPageGroup Restricted(params WebPageGroupAccessRule[] rules) => new()
    {
        Id = "g1",
        TeamId = "team-a",
        Visibility = WebPageGroupVisibility.Restricted,
        AccessRules = rules.ToList(),
    };

    private static WebPageGroupAccessRule UserRule(string userId, string role) =>
        new() { SubjectType = WebPageGroupSubjectType.User, SubjectId = userId, Role = role };

    private static WebPageGroupAccessRule LabelRule(string label, string role) =>
        new() { SubjectType = WebPageGroupSubjectType.Label, SubjectId = label, Role = role };

    // ── 铁律 1：inherit 跟随空间 ──

    [Theory]
    [InlineData(WebHostingRoles.Owner)]
    [InlineData(WebHostingRoles.Editor)]
    [InlineData(WebHostingRoles.Viewer)]
    public void InheritGroup_FollowsSpaceRole(string spaceRole)
    {
        Assert.Equal(spaceRole, WebPageGroupAccess.ResolveGroupRole(spaceRole, Inherit(), "u1", null));
    }

    [Fact]
    public void NonMember_AlwaysNull_EvenWithMatchingRule()
    {
        var group = Restricted(UserRule("u1", WebHostingRoles.Editor));
        Assert.Null(WebPageGroupAccess.ResolveGroupRole(null, group, "u1", null));
    }

    // ── 铁律 2：restricted 按规则命中 ──

    [Fact]
    public void RestrictedGroup_SpaceOwner_AlwaysOwner()
    {
        var group = Restricted(); // 零规则
        Assert.Equal(WebHostingRoles.Owner,
            WebPageGroupAccess.ResolveGroupRole(WebHostingRoles.Owner, group, "u1", null));
    }

    [Fact]
    public void RestrictedGroup_UnmatchedMember_Invisible()
    {
        var group = Restricted(UserRule("someone-else", WebHostingRoles.Editor));
        Assert.Null(WebPageGroupAccess.ResolveGroupRole(WebHostingRoles.Editor, group, "u1", new[] { "前端组" }));
    }

    [Fact]
    public void RestrictedGroup_UserRule_Matches()
    {
        var group = Restricted(UserRule("u1", WebHostingRoles.Viewer));
        Assert.Equal(WebHostingRoles.Viewer,
            WebPageGroupAccess.ResolveGroupRole(WebHostingRoles.Editor, group, "u1", null));
    }

    [Fact]
    public void RestrictedGroup_LabelRule_MatchesByMyLabels()
    {
        var group = Restricted(LabelRule("测试组", WebHostingRoles.Editor));
        Assert.Equal(WebHostingRoles.Editor,
            WebPageGroupAccess.ResolveGroupRole(WebHostingRoles.Viewer, group, "u1", new[] { "测试组", "前端组" }));
    }

    [Fact]
    public void RestrictedGroup_MultipleHits_TakesMostPermissive()
    {
        var group = Restricted(
            LabelRule("测试组", WebHostingRoles.Viewer),
            UserRule("u1", WebHostingRoles.Editor));
        Assert.Equal(WebHostingRoles.Editor,
            WebPageGroupAccess.ResolveGroupRole(WebHostingRoles.Viewer, group, "u1", new[] { "测试组" }));
    }

    [Fact]
    public void RestrictedGroup_DirtyRoleValue_FallsBackToViewer()
    {
        // 脏数据：规则里塞了 owner / 非法值，分组级最高只发 editor，其余按 viewer 兜底
        var group = Restricted(UserRule("u1", "owner"));
        Assert.Equal(WebHostingRoles.Viewer,
            WebPageGroupAccess.ResolveGroupRole(WebHostingRoles.Editor, group, "u1", null));
    }

    // ── 铁律 3：规则可升格 ──

    [Fact]
    public void RestrictedGroup_SpaceViewer_CanBeUpgradedToGroupEditor()
    {
        var group = Restricted(UserRule("u1", WebHostingRoles.Editor));
        Assert.Equal(WebHostingRoles.Editor,
            WebPageGroupAccess.ResolveGroupRole(WebHostingRoles.Viewer, group, "u1", null));
    }

    // ── 铁律 4：站点级合成（多团队共享） ──

    [Fact]
    public void SiteOwner_AlwaysOwner_EvenInInvisibleRestrictedGroup()
    {
        var group = Restricted(); // 零授权
        var role = WebPageGroupAccess.ResolveSiteRoleWithGroup(
            isSiteOwner: true, new[] { "team-a" },
            new Dictionary<string, string>(), group, "u1", null);
        Assert.Equal(WebHostingRoles.Owner, role);
    }

    [Fact]
    public void SiteInRestrictedGroup_UnauthorizedMember_LosesAccess()
    {
        var group = Restricted(UserRule("someone-else", WebHostingRoles.Editor));
        var role = WebPageGroupAccess.ResolveSiteRoleWithGroup(
            isSiteOwner: false, new[] { "team-a" },
            new Dictionary<string, string> { ["team-a"] = WebHostingRoles.Editor },
            group, "u1", null);
        Assert.Null(role);
    }

    [Fact]
    public void SiteInRestrictedGroup_OtherTeamRole_Unaffected()
    {
        // 站点同时共享给 team-a（受限分组无授权）和 team-b（我是 editor）：
        // A 团队的内部分组不应剥夺 B 团队给我的成员资格
        var group = Restricted();
        var role = WebPageGroupAccess.ResolveSiteRoleWithGroup(
            isSiteOwner: false, new[] { "team-a", "team-b" },
            new Dictionary<string, string>
            {
                ["team-a"] = WebHostingRoles.Editor,
                ["team-b"] = WebHostingRoles.Editor,
            },
            group, "u1", null);
        Assert.Equal(WebHostingRoles.Editor, role);
    }

    [Fact]
    public void SiteInInheritGroup_BehavesAsWithoutGroup()
    {
        var role = WebPageGroupAccess.ResolveSiteRoleWithGroup(
            isSiteOwner: false, new[] { "team-a" },
            new Dictionary<string, string> { ["team-a"] = WebHostingRoles.Viewer },
            Inherit(), "u1", null);
        Assert.Equal(WebHostingRoles.Viewer, role);
    }

    [Fact]
    public void SiteInRestrictedGroup_GroupEditorGrant_UpgradesSpaceViewer()
    {
        var group = Restricted(LabelRule("运营组", WebHostingRoles.Editor));
        var role = WebPageGroupAccess.ResolveSiteRoleWithGroup(
            isSiteOwner: false, new[] { "team-a" },
            new Dictionary<string, string> { ["team-a"] = WebHostingRoles.Viewer },
            group, "u1", new[] { "运营组" });
        Assert.Equal(WebHostingRoles.Editor, role);
    }
}
