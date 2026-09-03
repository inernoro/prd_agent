using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.RegularExpressions;
using PrdAgent.Api.Mcp;
using PrdAgent.Api.Services.Mcp;
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
    public void EveryDeclaredScope_HasAtLeastOneTool_NotJustEveryCapability()
    {
        // 上面那条只管到「能力」这一层，一块能力只要有**任意一个** scope 挂着工具就绿。
        // 于是「读档有工具、写档一个都没有」的卡片能一路过关：海鲜市场的写 scope 就是这么
        // 摆到向导里的 —— 上传技能包走 multipart、MCP 传不了二进制，那个勾选框勾了也多不出
        // 任何工具，卡片文案还写着「能把技能包发上去」。判据比它该管的范围窄（形状 1）。
        //
        // 注意：这条只管**能力卡上声明的 scope**。像 marketplace.skills:write 这种
        // 「REST 接口在用、但没有 MCP 工具」的 scope，正确做法是不摆进能力卡（签发白名单里另行保留），
        // 而不是为它编一个工具出来。
        foreach (var cap in McpCapabilityCatalog.All)
        {
            foreach (var scope in cap.AllScopes())
            {
                var tools = McpBuiltinTools.All
                    .Where(t => string.Equals(t.RequiredScope, scope, StringComparison.OrdinalIgnoreCase))
                    .ToList();
                tools.Count.ShouldBeGreaterThan(0,
                    $"能力「{cap.Title}」声明了 scope {scope}，却没有任何工具要求它 —— " +
                    "用户在向导里勾得到，勾完智能体那边一个工具都不多。要么补工具，要么把这一档从能力卡上摘掉");
            }
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
    public void 扣额度与出产物是两个判据_不许合成一个()
    {
        // 事故形状：map_market_fork_skill 用 WritesData=false 压掉了写入额度（POST 但语义是读），
        // 而产物识别当时读的是同一个值 —— 于是它返回的 zip 地址被从调用记录里抹掉，
        // 用户点不开自己刚取到的技能。两个判据必须各算各的。
        var fork = McpBuiltinTools.All.Single(t => t.Name == "map_market_fork_skill");

        McpUsageService.IsWriteTool(fork).ShouldBeFalse("取用技能不该占写入额度");
        McpUsageService.ProducesArtifacts(fork).ShouldBeTrue("取用技能确实把东西取到了用户名下，记录要给得出地址");
    }

    [Fact]
    public void 纯读工具既不扣额度也不出产物()
    {
        foreach (var t in McpBuiltinTools.All.Where(x =>
                     string.Equals(x.Method, "GET", StringComparison.OrdinalIgnoreCase)))
        {
            McpUsageService.IsWriteTool(t).ShouldBeFalse($"{t.Name} 是 GET，不该算写入");
            McpUsageService.ProducesArtifacts(t).ShouldBeFalse($"{t.Name} 是 GET，不该被记成这次做出了东西");
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
    public void EveryPermissionCheckedScope_MapsToARealAdminPermission()
    {
        // 拿去跟用户权限取交集的每个 scope，换算出来的权限位必须真实存在于权限目录里。
        // 不存在的话，这条校验会把所有人——包括 root——挡在门外：root 拿到的是「权限目录里的全部 key」，
        // 一个不在目录里的 key，root 也没有。
        var permissions = AdminPermissionCatalog.All.Select(p => p.Key).ToHashSet(StringComparer.OrdinalIgnoreCase);
        foreach (var scope in McpCapabilityCatalog.PermissionCheckedScopes)
        {
            var perm = McpCapabilityCatalog.ToPermission(scope);
            permissions.Contains(perm).ShouldBeTrue($"scope {scope} 对应的权限位 {perm} 在权限目录里不存在，拿它做交集校验等于谁都签不出来");
        }
    }

    [Fact]
    public void MarketplaceScopes_AreExcludedFromPermissionCheck_BecauseNoSuchPermissionExists()
    {
        // 海鲜市场开放接口的闸门是它自己的 [RequireScope]，从来不走后台权限位。
        // 这里把「为什么排除」钉成判据：哪天有人给市场加了权限位，这条会红，提醒把它纳入校验；
        // 反过来，谁把市场 scope 塞进校验集合，上一条会红。
        var permissions = AdminPermissionCatalog.All.Select(p => p.Key).ToHashSet(StringComparer.OrdinalIgnoreCase);
        foreach (var scope in new[] { McpCapabilityCatalog.ScopeMarketplaceRead, McpCapabilityCatalog.ScopeMarketplaceWrite })
        {
            McpCapabilityCatalog.PermissionCheckedScopes.ShouldNotContain(scope);
            permissions.Contains(McpCapabilityCatalog.ToPermission(scope))
                .ShouldBeFalse($"权限目录里出现了 {McpCapabilityCatalog.ToPermission(scope)}，那就该把 {scope} 纳入权限交集校验");
        }
    }

    [Fact]
    public void DocumentStoreScopes_签发要查权限_鉴权不查_才能既收住新签又不打死存量()
    {
        // 权限位是有的（document-store.read / .write），而 AdminPermissionMiddleware.HasScopeGrant
        // 认这两个 scope 等价于那两个权限位 —— 也就是说，谁能给自己签一把带 document-store:write
        // 的密钥，谁就凭空长出了文档空间写权限。所以**签发必须查**。
        McpCapabilityCatalog.IsIssuancePermissionChecked(McpCapabilityCatalog.ScopeDocStoreRead).ShouldBeTrue();
        McpCapabilityCatalog.IsIssuancePermissionChecked(McpCapabilityCatalog.ScopeDocStoreWrite).ShouldBeTrue();

        // 但鉴权不能查：这类密钥早就在跑，鉴权时开始查交集会让已经在用的接入当场调不动。
        // 两个集合分开，正是为了「收住从现在起新签的」而不动存量。
        McpCapabilityCatalog.PermissionCheckedScopes.ShouldNotContain(McpCapabilityCatalog.ScopeDocStoreRead);
        McpCapabilityCatalog.PermissionCheckedScopes.ShouldNotContain(McpCapabilityCatalog.ScopeDocStoreWrite);
    }

    [Fact]
    public void 每个签发要查的_scope_都对得上一个真实权限位()
    {
        // 与 EveryPermissionCheckedScope_MapsToARealAdminPermission 同理：换算不出真实权限位的 scope
        // 一旦进了签发校验，连 root 都签不出来。这条把新加的那半边也钉住。
        var permissions = AdminPermissionCatalog.All.Select(p => p.Key).ToHashSet(StringComparer.OrdinalIgnoreCase);
        foreach (var scope in McpCapabilityCatalog.IssuanceOnlyPermissionCheckedScopes)
        {
            var perm = McpCapabilityCatalog.ToPermission(scope);
            permissions.Contains(perm).ShouldBeTrue($"scope {scope} 对应的权限位 {perm} 在权限目录里不存在，拿它做签发校验等于谁都签不出来");
        }
    }

    [Fact]
    public void 市场_scope_两个口径都不查_因为它压根没有权限位()
    {
        // 它的闸门是 [RequireScope] 自己。纳进任一口径都会把所有人挡在门外。
        McpCapabilityCatalog.IsIssuancePermissionChecked(McpCapabilityCatalog.ScopeMarketplaceRead).ShouldBeFalse();
        McpCapabilityCatalog.IsIssuancePermissionChecked(McpCapabilityCatalog.ScopeMarketplaceWrite).ShouldBeFalse();
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
    public void ScopeSatisfies_WriteImpliesRead_OnlyWhereTheRealGateAlsoImplies()
    {
        // 判据要跟真实闸门一致，不能按 `:write` / `:read` 的字面规律一刀切：
        //   知识库 / 网页托管的读端点是 [RequireScope(read, write)]  → 写能读
        //   海鲜市场的读端点是 [RequireScope(read)] 精确匹配          → 写不能读（放行只会列出一批 403 的工具）
        var web = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { McpCapabilityCatalog.ScopeWebPagesWrite };
        McpCapabilityCatalog.ScopeSatisfies(web, McpCapabilityCatalog.ScopeWebPagesRead).ShouldBeTrue();
        McpCapabilityCatalog.ScopeSatisfies(web, McpCapabilityCatalog.ScopeDocStoreRead).ShouldBeFalse();

        var doc = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { McpCapabilityCatalog.ScopeDocStoreWrite };
        McpCapabilityCatalog.ScopeSatisfies(doc, McpCapabilityCatalog.ScopeDocStoreRead).ShouldBeTrue();

        var market = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { McpCapabilityCatalog.ScopeMarketplaceWrite };
        McpCapabilityCatalog.ScopeSatisfies(market, McpCapabilityCatalog.ScopeMarketplaceRead).ShouldBeFalse();
    }

    [Fact]
    public void CapabilitiesDeclaringWriteImpliesRead_HaveBothScopes()
    {
        // 声明了「写能读」却没有读 scope 的能力，这个标志就是死的 —— 说明声明写错了地方
        foreach (var cap in McpCapabilityCatalog.All.Where(c => c.WriteImpliesRead))
        {
            string.IsNullOrEmpty(cap.ReadScope).ShouldBeFalse($"能力「{cap.Title}」声明了写蕴含读，却没有只读 scope");
            string.IsNullOrEmpty(cap.WriteScope).ShouldBeFalse($"能力「{cap.Title}」声明了写蕴含读，却没有写 scope");
        }
    }

    [Fact]
    public void PermissionCheckedScopes_CoverTheNewlyAddedScopesOnly()
    {
        // 新 scope 从第一天就带校验（签发取交集 + 鉴权二次核对）；老 scope 不纳入
        McpCapabilityCatalog.PermissionCheckedScopes.ShouldContain(McpCapabilityCatalog.ScopeVisualUse);
        McpCapabilityCatalog.PermissionCheckedScopes.ShouldContain(McpCapabilityCatalog.ScopeLiteraryUse);
        McpCapabilityCatalog.PermissionCheckedScopes.ShouldContain(McpCapabilityCatalog.ScopeWebPagesRead);
        McpCapabilityCatalog.PermissionCheckedScopes.ShouldContain(McpCapabilityCatalog.ScopeWebPagesWrite);
        McpCapabilityCatalog.PermissionCheckedScopes.Count.ShouldBe(4);
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
