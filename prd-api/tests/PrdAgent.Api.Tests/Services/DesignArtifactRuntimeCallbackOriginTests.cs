using Microsoft.Extensions.Configuration;
using PrdAgent.Api.Services;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

/// <summary>
/// OpenDesign 的回调地址必须是 **API 自己的对外地址**：CDS 侧容器拿它回来取工作区输入、
/// 提交结果、走模型代理，落点是 DesignArtifactRuntimeController。
///
/// 此前解析列表里排着 `App:FrontendBaseUrl`，而那个键按定义指向 admin 那一端
/// （docker-compose.dev.yml 默认 http://localhost:5500，API 在 5000）。admin 与 API 分域时
/// 它是个合法值、又排在 CDS_PREVIEW_URL 前面，于是 OpenDesign 在真正执行之前就断掉
/// （Codex P2，2026-09-16；形状 1：判据比它该管的范围宽）。
/// </summary>
public sealed class DesignArtifactRuntimeCallbackOriginTests
{
    private const string AdminOrigin = "https://admin.example.com";
    private const string ApiOrigin = "https://api-preview.example.com";

    private static IConfiguration Config(params (string Key, string Value)[] pairs)
        => new ConfigurationBuilder()
            .AddInMemoryCollection(pairs.Select(p => new KeyValuePair<string, string?>(p.Key, p.Value)))
            .Build();

    [Fact]
    public void FrontendOriginAloneMustNotBecomeTheRuntimeCallbackBase()
    {
        var resolved = DesignArtifactWorkspaceBroker.ResolvePublicBaseUrl(
            Config(("App:FrontendBaseUrl", AdminOrigin)));

        // 解析不出来时调用方 PrepareAsync 会抛「远程设计入口尚未配置」——一条读得懂的失败，
        // 远好过把回调发到 admin 服务器然后在容器里以 404 收场（形状 10：降级不许静默）。
        resolved.ShouldBeNull(
            customMessage: "前端地址被当成了 API 回调基址；admin 与 API 分域部署时 OpenDesign 会在执行前断掉");
    }

    [Fact]
    public void FrontendOriginMustNotOutrankTheDeclaredApiOrigin()
    {
        var resolved = DesignArtifactWorkspaceBroker.ResolvePublicBaseUrl(
            Config(("App:FrontendBaseUrl", AdminOrigin), ("CDS_PREVIEW_URL", ApiOrigin)));

        resolved.ShouldBe(ApiOrigin);
    }

    [Theory]
    [InlineData("ServerUrl")]
    [InlineData("CDS_PREVIEW_URL")]
    [InlineData("PUBLIC_BASE_URL")]
    [InlineData("APP_PUBLIC_BASE_URL")]
    public void EachDeclaredApiOriginStillResolves(string key)
        => DesignArtifactWorkspaceBroker.ResolvePublicBaseUrl(Config((key, ApiOrigin + "/")))
            .ShouldBe(ApiOrigin);

    [Fact]
    public void TheExplicitRuntimeOverrideStillWinsOverEverythingElse()
    {
        var resolved = DesignArtifactWorkspaceBroker.ResolvePublicBaseUrl(
            Config(
                ("DesignArtifactRuntime:PublicBaseUrl", "https://runtime.example.com"),
                ("ServerUrl", ApiOrigin),
                ("CDS_PREVIEW_URL", ApiOrigin)));

        resolved.ShouldBe("https://runtime.example.com");
    }

    /// <summary>
    /// 防漂移：仓库里「API 声明的公网基址」只有 RequestOriginExtensions.DeclaredBaseUrlKeys
    /// 一份定义。本解析器抄一份过去就是等着两边各自漂移（形状 3），所以判据直接钉在
    /// 「它引用的是那份定义」而不是「它当前列了哪几个字符串」。
    /// </summary>
    [Fact]
    public void TheResolverMustReuseTheSingleDeclaredApiOriginDefinition()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory != null
               && !Directory.Exists(Path.Combine(directory.FullName, "prd-api", "src", "PrdAgent.Api")))
            directory = directory.Parent;
        directory.ShouldNotBeNull();
        var source = File.ReadAllText(Path.Combine(
            directory!.FullName, "prd-api", "src", "PrdAgent.Api",
            "Services", "DesignArtifactWorkspaceBroker.cs"));

        var start = source.IndexOf("internal static string? ResolvePublicBaseUrl", StringComparison.Ordinal);
        start.ShouldBeGreaterThan(0);
        var body = source.Substring(start, Math.Min(700, source.Length - start));

        body.ShouldContain(
            "RequestOriginExtensions.DeclaredBaseUrlKeys",
            customMessage: "回调基址解析必须复用那份唯一定义，不要在这里另抄一张键表");
        body.ShouldNotContain(
            "Frontend",
            customMessage: "回调基址解析里出现了前端相关的键——它解析的是 API 自己的对外地址");
    }
}
