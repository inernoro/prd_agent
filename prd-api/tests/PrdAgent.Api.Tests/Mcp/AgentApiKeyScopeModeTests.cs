using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using PrdAgent.Api.Mcp;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Mcp;

/// <summary>
/// 「能力范围跟着主人走」这一档的守卫。
///
/// 自动档的清单**不存库**，每次鉴权现算。这带来两件删掉之后测试仍然全绿的事：
///   1. 枚举值一旦挪动，存量密钥（库里没有这个字段，反序列化落到默认值）会被当成自动档 ——
///      每一把已经发出去的钥匙当场长出主人的全部能力。
///   2. 现算的那个函数必须真的取交集。少了交集，自动档等于「平台开放什么就给什么」，
///      主人自己都没有的权限被凭空签出来。
///
/// 断言的是行为，不是某段实现的字面存在。
/// </summary>
public class AgentApiKeyScopeModeTests
{
    [Fact]
    public void Manual_MustBeTheZeroValue()
    {
        // 存量密钥的文档里根本没有 ScopeMode 这个字段，反序列化会落到枚举的 0 值。
        // Auto 若是 0，所有已经发出去的密钥（含只用于海鲜市场上传的那些）会在下一次鉴权时
        // 静默拿到主人的全部能力 —— 一次改枚举顺序就是一次全量越权。
        ((int)AgentApiKeyScopeMode.Manual).ShouldBe(0);
        new AgentApiKey().ScopeMode.ShouldBe(AgentApiKeyScopeMode.Manual);
    }

    [Fact]
    public void AutoScopes_AreBoundedByOwnerPermissions()
    {
        var nothing = McpCapabilityCatalog.AutoScopesFor(Array.Empty<string>());

        // 一个权限位都没有的人：受权限位把关的 scope 一个都不该出现
        foreach (var scope in nothing)
            McpCapabilityCatalog.IsIssuancePermissionChecked(scope).ShouldBeFalse(
                customMessage: $"`{scope}` 受权限位把关，却出现在「零权限用户」的自动档里 —— 自动档没取交集");
    }

    [Fact]
    public void AutoScopes_GrowWithOwnerPermissions()
    {
        var nothing = McpCapabilityCatalog.AutoScopesFor(Array.Empty<string>());

        // 拿到全部权限位的人：自动档必须覆盖能力目录里全部 scope，
        // 否则「默认把你有的能力都给它」这句话是假的。
        var all = AllIssuancePermissions();
        var everything = McpCapabilityCatalog.AutoScopesFor(all);

        everything.Count.ShouldBeGreaterThan(nothing.Count,
            customMessage: "多了权限位，自动档却没多出任何能力 —— 现算那一步没有真的看权限");
        foreach (var scope in McpCapabilityCatalog.All.SelectMany(c => c.AllScopes()))
            everything.ShouldContain(scope,
                customMessage: $"能力目录里的 `{scope}` 没进全权限用户的自动档");
    }

    [Fact]
    public void AutoScopes_NeverIncludeScopesOutsideTheCapabilityCatalog()
    {
        // 自动档只覆盖接入台的能力目录。海鲜市场上传（multipart，MCP 传不了）、
        // 缺陷修复、OpenAI 兼容网关这些 scope 有各自的签发路径，不该被「默认全给」顺手带出去。
        var catalog = McpCapabilityCatalog.All.SelectMany(c => c.AllScopes())
            .ToHashSet(StringComparer.OrdinalIgnoreCase);
        foreach (var scope in McpCapabilityCatalog.AutoScopesFor(AllIssuancePermissions()))
            catalog.ShouldContain(scope,
                customMessage: $"`{scope}` 不在能力目录里，却被自动档签了出来");
    }

    [Fact]
    public void AuthHandler_DerivesScopes_ByMode_NotByStoredList()
    {
        // 自动档的钥匙库里存的是空清单。鉴权若照着 key.Scopes 算，它一个工具也调不动 ——
        // 而面板会显示「已授权」，因为面板走的是现算那一路。两处口径分裂正是这块地方栽过的形状。
        var source = ReadSource("src/PrdAgent.Api/Authentication/ApiKeyAuthenticationHandler.cs");
        source.ShouldContain("AgentApiKeyScopeMode.Auto",
            customMessage: "鉴权处理器没有区分自动档：自动档的钥匙存的是空清单，照它算等于零权限");
        source.ShouldContain("McpCapabilityCatalog.AutoScopesFor",
            customMessage: "鉴权没走现算那一处 —— 自动档的清单必须与面板同源，不能各算各的");
    }

    [Fact]
    public void Console_ShowsEffectiveScopes_NotStoredList()
    {
        // 面板照着 key.Scopes 展示的话，一把自动档的钥匙会显示成「零个能力」，
        // 而它实际什么都调得动 —— 用户看到的和智能体拿到的是两回事。
        var source = ReadSource("src/PrdAgent.Api/Controllers/Api/McpConsoleController.cs");
        source.ShouldContain("EffectiveScopesOf",
            customMessage: "接入台面板没有走「此刻实际拿得到什么」那一处推导");
        source.ShouldContain("MissingCapabilitiesOf",
            customMessage: "手动档缺少「你有、但没开给它」的告知 —— 用户该知道，钥匙不该自动拿到");
    }

    /// <summary>
    /// 「什么都有」的那个人的权限位。必须带上 access ——
    /// 它是所有功能权限的前置闸（PermissionsAllowScope 里没有 access 一律不算数）。
    /// </summary>
    private static IReadOnlyList<string> AllIssuancePermissions() =>
        McpCapabilityCatalog.All
            .SelectMany(c => c.AllScopes())
            .Where(McpCapabilityCatalog.IsIssuancePermissionChecked)
            .Select(McpCapabilityCatalog.ToPermission)
            .Append(AdminPermissionCatalog.Access)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToList();

    /// <summary>从测试程序集往上找到 prd-api 根，读源码做接线断言（这几条接线删掉不会红）。</summary>
    private static string ReadSource(string relative)
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir != null && !File.Exists(Path.Combine(dir.FullName, "PrdAgent.sln")))
            dir = dir.Parent;
        dir.ShouldNotBeNull(customMessage: "没找到 PrdAgent.sln，测试定位不到源码");
        var path = Path.Combine(dir!.FullName, relative);
        File.Exists(path).ShouldBeTrue(customMessage: $"源码不存在：{path}");
        return File.ReadAllText(path);
    }
}
