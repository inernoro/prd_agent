using Microsoft.Extensions.Configuration;
using PrdAgent.Infrastructure.Deployment;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

/// <summary>
/// 守卫「公网入口只能来自平台下发」的读取逻辑（见 PlatformEntrypoints）。
///
/// 2026-07-29 事故：MAP 前端自己按 hostname 拼 `<预览 slug>-llmgw-web.miduo.org`，
/// 分支名长时（现场 57 + 10 = 67 > 63）CDS 根本没发布这条路由，前端却照拼，
/// 用户看到的错误却是「登录凭据未通过安全校验」。修复方向是取消推算权：
/// 表里有就用，表里没有就说没有，任何情况下都不猜。
/// 生成侧 SSOT 见 cds/src/services/preview-entrypoints.ts。
/// </summary>
public class PlatformEntrypointsTests
{
    private static IConfiguration Build(Dictionary<string, string?> values)
        => new ConfigurationBuilder().AddInMemoryCollection(values).Build();

    [Fact]
    public void PrefersPlatformDeclaredConsoleUrlOverSubdomainGuessing()
    {
        // 改名后表里是 llmgw + llmgw-web（同一控制台的规范名与兼容别名）；
        // 改名前的存量项目表里**同样**是这两个 key，但那是「后端 API + 控制台」。
        // key 集合一模一样、语义相反，所以只能由平台明说是哪一个（Codex P2）。
        var config = Build(new()
        {
            ["CDS_SERVICE_URLS"] = """{"llmgw":"https://demo-llmgw.miduo.org","llmgw-web":"https://demo-llmgw-web.miduo.org"}""",
            ["CDS_CONSOLE_URL"] = "https://demo-llmgw-web.miduo.org",
        });
        PlatformEntrypoints.ResolveGatewayConsoleBaseUrl(config)
            .ShouldBe("https://demo-llmgw-web.miduo.org/");
    }

    [Fact]
    public void FallsBackToSubdomainOrderWhenPlatformDidNotDeclareConsole()
    {
        // 老平台没下发 CDS_CONSOLE_URL 时才退回按名字猜；这条路径无法区分两种布局，
        // 是已知边界，CDS 升级后自愈。断言它至少与改名后的布局一致（规范名优先）。
        var config = Build(new()
        {
            ["CDS_SERVICE_URLS"] = """{"llmgw":"https://demo-llmgw.miduo.org","llmgw-web":"https://demo-llmgw-web.miduo.org"}""",
        });
        PlatformEntrypoints.ResolveGatewayConsoleBaseUrl(config)
            .ShouldBe("https://demo-llmgw.miduo.org/");
    }

    [Fact]
    public void ConsoleUrlAloneCountsAsAnInjectedTable()
    {
        // 「平台下发了表」的判定必须认这个 key —— 否则只下发控制台入口时会被当成
        // 「老平台没下发表」，提示语走错分支（形状 1：判据太窄）。
        var config = Build(new() { ["CDS_CONSOLE_URL"] = "https://demo-llmgw.miduo.org/" });
        PlatformEntrypoints.HasEntrypointTable(config).ShouldBeTrue();
    }

    [Fact]
    public void ResolvesGatewayConsoleFromInjectedTable()
    {
        var config = Build(new()
        {
            ["CDS_SERVICE_URLS"] = """{"llmgw-web":"https://demo-claude-prd-agent-llmgw-web.miduo.org"}""",
        });
        PlatformEntrypoints.ResolveGatewayConsoleBaseUrl(config)
            .ShouldBe("https://demo-claude-prd-agent-llmgw-web.miduo.org/");
    }

    [Fact]
    public void KeepsSingleTrailingSlash()
    {
        var config = Build(new() { ["CDS_SERVICE_URLS"] = """{"llmgw-web":"https://gw.example.org/"}""" });
        PlatformEntrypoints.ResolveGatewayConsoleBaseUrl(config).ShouldBe("https://gw.example.org/");
    }

    [Fact]
    public void MissingEntryIsNullNotGuessed()
    {
        // 超长命名子域时 CDS 跳过不发布，表里就没有这一项。这里必须返回 null，
        // 让调用方如实报「未发布」，绝不能退化成猜一个地址。
        var config = Build(new() { ["CDS_SERVICE_URLS"] = """{"llmgw-serve":"https://x-llmgw-serve.miduo.org"}""" });
        PlatformEntrypoints.ResolveGatewayConsoleBaseUrl(config).ShouldBeNull();
    }

    [Theory]
    [InlineData("not json")]
    [InlineData("[]")]
    [InlineData("""{"llmgw-web":123}""")]
    [InlineData("""{"llmgw-web":""}""")]
    public void MalformedTableDegradesToUnknown(string raw)
    {
        var config = Build(new() { ["CDS_SERVICE_URLS"] = raw });
        PlatformEntrypoints.ResolveGatewayConsoleBaseUrl(config).ShouldBeNull();
    }

    [Fact]
    public void NoTableAtAll_IsDistinguishableFromEmptyEntry()
    {
        // 关键区分：「表里没这一项」= 确实没发布；「压根没有表」= 旧版 CDS，未知。
        // 两者都取不到 URL，但给用户的解释完全不同，不能混为一谈。
        PlatformEntrypoints.HasEntrypointTable(Build(new())).ShouldBeFalse();
        PlatformEntrypoints.HasEntrypointTable(Build(new() { ["CDS_PREVIEW_URL"] = "https://x.miduo.org" })).ShouldBeTrue();
        PlatformEntrypoints.HasEntrypointTable(Build(new() { ["CDS_SERVICE_URLS"] = "{}" })).ShouldBeTrue();
    }
}
