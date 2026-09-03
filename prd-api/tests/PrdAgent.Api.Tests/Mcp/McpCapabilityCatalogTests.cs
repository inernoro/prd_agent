using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.RegularExpressions;
using PrdAgent.Api.Mcp;
using PrdAgent.Core.Security;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Mcp;

/// <summary>
/// 接入台能力目录的守卫。
///
/// 这里盯三件「删掉之后测试还全绿」的事（predicate-and-wiring-discipline 形状 2/3）：
///   1. 能力目录声明的 scope 与真实工具表对得上，不会出现「卡片上写着三个工具，实际一个都没接」
///   2. 授权判据只此一份：签发密钥要过用户权限交集，写 scope 蕴含读 scope
///   3. 工具名满足 MCP 名称正则且不重名
/// </summary>
public class McpCapabilityCatalogTests
{
    private static readonly Regex McpToolNameRegex = new(@"^[a-zA-Z0-9_-]{1,64}$");

    [Fact]
    public void EveryCapability_HasAtLeastOneTool_WiredToItsScope()
    {
        foreach (var cap in McpCapabilityCatalog.All)
        {
            var tools = McpCapabilityCatalog.ToolsOf(cap);
            tools.Count.ShouldBeGreaterThan(0,
                $"能力「{cap.Title}」在接入台上是一张卡，却没有任何工具挂在它的 scope 上 —— 用户勾了它，智能体那边什么都不会多出来");
        }
    }

    [Fact]
    public void EveryBuiltinTool_BelongsToADeclaredCapabilityOrLegacyScope()
    {
        // 历史 scope：不在能力卡上，但确实有工具/接口在用
        var legacy = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        foreach (var tool in McpBuiltinTools.All)
        {
            var known = McpCapabilityCatalog.AllScopes.Contains(tool.RequiredScope) || legacy.Contains(tool.RequiredScope);
            known.ShouldBeTrue($"工具 {tool.Name} 要求的 scope {tool.RequiredScope} 不属于任何能力卡，用户在接入向导里永远勾不到它");
        }
    }

    [Fact]
    public void ToolNames_AreUnique_AndMatchMcpNameRegex()
    {
        var names = McpBuiltinTools.All.Select(t => t.Name).ToList();
        names.Distinct(StringComparer.Ordinal).Count().ShouldBe(names.Count);
        foreach (var name in names)
            McpToolNameRegex.IsMatch(name).ShouldBeTrue($"工具名 {name} 不满足 MCP 名称正则");
    }

    [Fact]
    public void EveryCapabilityScope_MapsToARealAdminPermission()
    {
        // scope `a:b` 换算出来的权限位必须真实存在于权限目录里，
        // 否则签发时的交集校验会把所有人都挡在门外（或者更糟：谁都能拿到）
        var permissions = AdminPermissionCatalog.All.Select(p => p.Key).ToHashSet(StringComparer.OrdinalIgnoreCase);
        foreach (var scope in McpCapabilityCatalog.AllScopes)
        {
            var perm = McpCapabilityCatalog.ToPermission(scope);
            permissions.Contains(perm).ShouldBeTrue($"scope {scope} 对应的权限位 {perm} 在权限目录里不存在");
        }
    }

    // ── 授权判据 ──

    [Fact]
    public void PermissionsAllowScope_RejectsScopeTheUserDoesNotOwn()
    {
        var owned = new[] { "document-store.read" };
        McpCapabilityCatalog.PermissionsAllowScope(owned, McpCapabilityCatalog.ScopeVisualUse)
            .ShouldBeFalse("用户自己没有视觉创作权限，就不该能签出一把带 visual-agent:use 的密钥");
    }

    [Fact]
    public void PermissionsAllowScope_AcceptsExactPermission()
    {
        var owned = new[] { "visual-agent.use" };
        McpCapabilityCatalog.PermissionsAllowScope(owned, McpCapabilityCatalog.ScopeVisualUse).ShouldBeTrue();
    }

    [Fact]
    public void PermissionsAllowScope_WriteImpliesRead()
    {
        var owned = new[] { "web-pages.write" };
        McpCapabilityCatalog.PermissionsAllowScope(owned, McpCapabilityCatalog.ScopeWebPagesRead).ShouldBeTrue();
        McpCapabilityCatalog.PermissionsAllowScope(owned, McpCapabilityCatalog.ScopeWebPagesWrite).ShouldBeTrue();
    }

    [Fact]
    public void PermissionsAllowScope_ReadDoesNotImplyWrite()
    {
        var owned = new[] { "web-pages.read" };
        McpCapabilityCatalog.PermissionsAllowScope(owned, McpCapabilityCatalog.ScopeWebPagesWrite).ShouldBeFalse();
    }

    [Fact]
    public void ScopeSatisfies_WriteImpliesRead_ForEveryCapability_NotJustDocumentStore()
    {
        // 早先这个判据把 document-store 写死了一对，新增 web-pages 读写档时就会漏
        var owned = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { McpCapabilityCatalog.ScopeWebPagesWrite };
        McpCapabilityCatalog.ScopeSatisfies(owned, McpCapabilityCatalog.ScopeWebPagesRead).ShouldBeTrue();
        McpCapabilityCatalog.ScopeSatisfies(owned, McpCapabilityCatalog.ScopeDocStoreRead).ShouldBeFalse();
    }

    [Fact]
    public void RuntimeCheckedScopes_CoverTheNewlyAddedScopesOnly()
    {
        // 新 scope 从第一天就带运行时二次校验；老 scope 不纳入（存量密钥不能被静默打哑）
        McpCapabilityCatalog.RuntimeCheckedScopes.ShouldContain(McpCapabilityCatalog.ScopeVisualUse);
        McpCapabilityCatalog.RuntimeCheckedScopes.ShouldContain(McpCapabilityCatalog.ScopeLiteraryUse);
        McpCapabilityCatalog.RuntimeCheckedScopes.ShouldContain(McpCapabilityCatalog.ScopeWebPagesWrite);
        McpCapabilityCatalog.RuntimeCheckedScopes.ShouldNotContain(McpCapabilityCatalog.ScopeDocStoreWrite);
        McpCapabilityCatalog.RuntimeCheckedScopes.ShouldNotContain(McpCapabilityCatalog.ScopeMarketplaceRead);
    }

    // ── 工具接线：每块能力的工具都指向真实存在的开放接口路径前缀 ──

    [Fact]
    public void CapabilityTools_PointAtOpenApiPaths()
    {
        foreach (var tool in McpBuiltinTools.All)
        {
            tool.PathTemplate.StartsWith("/api/open/", StringComparison.Ordinal).ShouldBeTrue(
                $"工具 {tool.Name} 的回环路径 {tool.PathTemplate} 不在 /api/open/ 下 —— 那些业务路由认的是登录态 sub，密钥打过去必然 401");
        }
    }
}
