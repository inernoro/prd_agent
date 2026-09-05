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

    /// <summary>
    /// 「它此刻拿得到什么」这件事只许有一处判据。
    ///
    /// 自动档的钥匙库里存的是**空清单**：任何一处照着 `key.Scopes` 算，都会把它说成「零个能力」，
    /// 而它实际什么都调得动。这四处回答的是同一个问题，抄第二份的那一刻，就是下一次
    /// 「面板说已授权、智能体每个请求都被拒」的起点（判据分裂的老形状）。
    ///
    /// 这条守卫删掉不会红：四处各写各的照样编译、照样全绿。
    /// </summary>
    [Theory]
    [InlineData("src/PrdAgent.Api/Authentication/ApiKeyAuthenticationHandler.cs", "鉴权")]
    [InlineData("src/PrdAgent.Api/Controllers/Api/McpConsoleController.cs", "接入台面板与授权自检")]
    [InlineData("src/PrdAgent.Api/Controllers/Api/AgentApiKeysController.cs", "密钥管理页")]
    public void EveryConsumer_GoesThroughTheOneEffectiveScopePredicate(string relative, string who)
    {
        var source = ReadSource(relative);
        source.ShouldContain("EffectiveScopesFor",
            customMessage: $"{who}没走唯一那处推导（McpCapabilityCatalog.EffectiveScopesFor）—— "
                           + "自动档的钥匙存的是空清单，照着存的算等于零权限");
    }

    [Fact]
    public void WriteOnlyKey_IsNotReportedAsMissingTheReadHalf()
    {
        // 知识库与网页托管声明了 WriteImpliesRead：只存了 `:write` 的钥匙，闸门认它连读端点一起满足。
        // 「你还能给它什么」若拿集合直接 Contains 比对，会把这类钥匙报成「知识库还没开给它」，
        // 而同一行的能力标签正显示着知识库已授权 —— 一行之内自己跟自己打架。
        // 这条删掉不会红：两处各按各的口径判，照样编译、照样全绿。
        foreach (var cap in McpCapabilityCatalog.All.Where(c => c.WriteImpliesRead))
        {
            cap.WriteScope.ShouldNotBeNull(customMessage: $"{cap.Title} 声明了写蕴含读，却没有写 scope");
            cap.ReadScope.ShouldNotBeNull(customMessage: $"{cap.Title} 声明了写蕴含读，却没有读 scope");

            var writeOnly = new[] { cap.WriteScope! };
            McpCapabilityCatalog.ScopeSatisfies(writeOnly, cap.ReadScope!).ShouldBeTrue(
                customMessage: $"只持有 {cap.WriteScope} 的钥匙应当满足 {cap.ReadScope}，判据是 ScopeSatisfies");
        }
    }

    [Fact]
    public void MissingCapabilities_UsesScopeSatisfies_NotRawContains()
    {
        // 上一条钉的是判据本身成立；这一条钉的是「你还能给它什么」真的走了那个判据。
        var source = ReadSource("src/PrdAgent.Api/Controllers/Api/McpConsoleController.cs");
        // 定位失败要当场说出来。IndexOf 回 -1 时下面的 Substring 会抛一个跟本条判据毫无关系的
        // 越界异常，读的人只会以为测试自己坏了 —— 而真正发生的是「那个方法被改名/挪走了」。
        var begin = source.IndexOf("MissingCapabilitiesOf(AgentApiKey key", StringComparison.Ordinal);
        begin.ShouldBeGreaterThanOrEqualTo(0, customMessage: "找不到 MissingCapabilitiesOf —— 它被改名或挪走了？");
        var body = source.Substring(begin);
        var end = body.IndexOf("\n    }", StringComparison.Ordinal);
        end.ShouldBeGreaterThan(0, customMessage: "量不出 MissingCapabilitiesOf 的方法体范围");
        body = body.Substring(0, end);
        body.ShouldContain("ScopeSatisfies",
            customMessage: "「你还能给它什么」没走 ScopeSatisfies —— 只存 :write 的钥匙会被报成缺了读的那半");
        body.ShouldNotContain("held.Contains",
            customMessage: "拿集合直接比对会漏掉写蕴含读，这正是它上一版的毛病");
        // 只报「整块一点都没给」的能力。按 Any 判（缺任何一档就报整块）会让同一行自己说两种话：
        // 上半行标签写着网页托管已授权，下半行说它还没开给这台客户端。
        body.ShouldContain(".All(",
            customMessage: "没有「整块都没给才报」这一层，部分授权的能力会被报成整块未授权，与同一行的标签矛盾");
    }

    [Fact]
    public void Console_TellsUserWhatTheyCouldStillGrant()
    {
        // 手动档的语义是「用户知道、钥匙没权限」。不渲染这一项，前半句就没了。
        var source = ReadSource("src/PrdAgent.Api/Controllers/Api/McpConsoleController.cs");
        source.ShouldContain("MissingCapabilitiesOf",
            customMessage: "手动档缺少「你有、但没开给它」的告知 —— 用户该知道，钥匙不该自动拿到");
    }

    /// <summary>
    /// 用不了的钥匙不许报出任何 scope。
    ///
    /// 自动档不存清单、鉴权时现算，好处是不会有一份第二天就对不上的快照；代价是
    /// 「现算」这个动作本身不看这把钥匙还能不能用。于是一把已作废 / 已停用 / 过了宽限期的
    /// 钥匙，在密钥管理页会按主人**当前**权限画满授权芯片，而同一页的授权自检回 toolCount=0
    /// —— 同一个对象在两个视图里说两种话。
    ///
    /// 这条接线删掉不会红：去掉 IsUsableAt 那层判断，照样编译、照样全绿。
    /// </summary>
    [Fact]
    public void ToDto_ReportsNoScopes_ForUnusableKey()
    {
        // 展示面有两处投影（密钥管理页的 ToDto、接入台的 clients），两处都必须走
        // EffectiveScopesForKey —— 它比 EffectiveScopesFor 多一层「钥匙还能不能用」。
        // 这件事已经在这两处上各漏过一次：补了一处、漏了另一处，正是判据分裂的典型。
        // 锚点取方法体，不拿 IndexOf("scopes = ")：那个串在文件里有好几处，第一处远在
        // ToDto 之前，判据会去量一段无关代码，然后判红判绿全凭巧合。
        var keysSource = ReadSource("src/PrdAgent.Api/Controllers/Api/AgentApiKeysController.cs");
        var begin = keysSource.IndexOf("private static object ToDto(AgentApiKey k", StringComparison.Ordinal);
        begin.ShouldBeGreaterThan(-1, customMessage: "找不到 ToDto —— 签名改了？判据得跟着改");
        var body = keysSource.Substring(begin);
        var end = body.IndexOf("\n    }", StringComparison.Ordinal);
        end.ShouldBeGreaterThan(-1, customMessage: "找不到 ToDto 的方法结尾");
        body.Substring(0, end).ShouldContain("EffectiveScopesForKey",
            customMessage: "密钥管理页会给一把已作废/已停用的钥匙画满授权芯片");

        var consoleSource = ReadSource("src/PrdAgent.Api/Controllers/Api/McpConsoleController.cs");
        var clientsBegin = consoleSource.IndexOf("var clients = keys.Select", StringComparison.Ordinal);
        clientsBegin.ShouldBeGreaterThan(-1, customMessage: "找不到接入台的 clients 投影");
        var clientsBody = consoleSource.Substring(clientsBegin);
        var clientsEnd = clientsBody.IndexOf("\n        var ", StringComparison.Ordinal);
        var clientsSlice = clientsEnd > 0 ? clientsBody.Substring(0, clientsEnd) : clientsBody;
        clientsSlice.ShouldContain("EffectiveScopesForKey",
            customMessage: "接入台会在同一行上写着 isActive=false，旁边却列一串它根本调不动的能力");
    }

    /// <summary>
    /// 只说「切成手动」不给清单时，必须把它此刻拿得到的那些定下来，而不是清零。
    ///
    /// 自动档的 Scopes 本来就是空的。PATCH {"scopeMode":"manual"} 若照直写下去，
    /// 这把钥匙会在接口返回 200 的同时失去全部工具 —— 说成了、其实废了，
    /// 而调用方没有任何线索知道自己刚把钥匙作废了。
    ///
    /// 「按清单钉死」的语义是**冻结现状**，不是清空。
    /// 这条接线删掉不会红：少了这一段照样编译、照样全绿。
    /// </summary>
    [Fact]
    public void Update_SnapshotsEffectiveScopes_WhenSwitchingAutoKeyToManual()
    {
        var source = ReadSource("src/PrdAgent.Api/Controllers/Api/AgentApiKeysController.cs");
        var begin = source.IndexOf("explicitScopeMode == AgentApiKeyScopeMode.Auto", StringComparison.Ordinal);
        begin.ShouldBeGreaterThan(-1, customMessage: "找不到切档那一段");
        var slice = source.Substring(begin, Math.Min(1200, source.Length - begin));

        slice.ShouldContain("AgentApiKeyScopeMode.Manual",
            customMessage: "切成手动这条路径没有单独处理，自动档的空清单会被原样钉死");
        slice.ShouldContain("EffectiveScopesFor",
            customMessage: "切手动时没有把当前有效清单快照下来 —— 钥匙会静默失去全部工具");
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
        // 统一成 \n：下面按 "\n    }" 找方法结尾，CRLF 检出时会一个都找不到（然后静默量错范围）
        return File.ReadAllText(path).Replace("\r\n", "\n");
    }
}
