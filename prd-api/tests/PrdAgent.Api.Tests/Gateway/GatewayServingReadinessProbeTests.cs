using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.LlmGateway;
using PrdAgent.LlmGatewayHost;
using Xunit;
using PrdAgent.Core.LlmGateway;

namespace PrdAgent.Api.Tests.Gateway;

public sealed class GatewayServingReadinessProbeTests
{
    [Fact]
    public void GatewayRuntimeSettings_CopyOnlyFieldsConsumedByServing()
    {
        var source = new AppSettings
        {
            EnablePromptCache = false,
            RequestBodyMaxChars = 123,
            AnswerMaxChars = 456,
            ErrorMaxChars = 789,
            MiduoSsoAppSecret = "must-not-copy",
            ConsoleSsoClientSecret = "must-not-copy-either",
            PasswordLoginDisabled = true,
        };

        var copied = GatewayAppSettingsService.CopyGatewayFields(source);

        Assert.False(copied.EnablePromptCache);
        Assert.Equal(123, copied.RequestBodyMaxChars);
        Assert.Equal(456, copied.AnswerMaxChars);
        Assert.Equal(789, copied.ErrorMaxChars);
        Assert.Null(copied.MiduoSsoAppSecret);
        Assert.Null(copied.ConsoleSsoClientSecret);
        Assert.Null(copied.PasswordLoginDisabled);
    }

    /// <summary>
    /// 就绪判据里不许再有模型池那条路。
    ///
    /// 这个文件原来有五条用例，逐条测「绑了一个健康的池算不算可路由」。它们在 2026-09-15
    /// 删掉解析器的池分支之后就变成了**给一条死路作保**：运行时的 ResolveCoreAsync 里
    /// 已经没有任何池分支，而探针照着这几条断言继续把「只绑了池」的调用方判成可路由。
    /// 一个这样的调用方，它的每一次不点名请求都回 MODEL_NOT_FOUND，而 readyz 是绿的。
    ///
    /// 所以这里换成反向守卫：判据里再出现池，这条就红。
    /// </summary>
    [Fact]
    public void 就绪判据里不再有模型池那条路()
    {
        var probe = ReadRepoFile("llmgw/serving/GatewayServingReadinessProbe.cs");

        foreach (var retired in new[]
                 {
                     "IsCallerRoutable",
                     "IsPoolRoutableForRequestType",
                     "HasEnabledBackend",
                     "llmgw_model_pools",
                     "ModelGroup",
                 })
        {
            Assert.DoesNotContain(retired, probe);
        }

        // 运行时那一侧也确认没有池分支——守卫的前提是「那条路真的没了」，
        // 前提自己要能被查，不能靠记忆。
        var resolver = ReadRepoFile("prd-api/src/PrdAgent.Infrastructure/LlmGateway/ModelResolver.cs");
        Assert.DoesNotContain("TryFallbackToGatewayDefaultPools", resolver);
        Assert.DoesNotContain("ResolvePinnedGatewayPoolMember", resolver);
    }

    /// <summary>
    /// 两个就绪组件问的是同一件事的两个侧面，可用线路的判据必须是同一份。
    ///
    /// 此前 scenario 组件只问「线路 enabled 且没被熔断」，不问它指向的东西还在不在、
    /// 过不过得了名录门；router 组件两样都问。于是同一份配置能让一个判红、另一个判绿。
    /// </summary>
    [Fact]
    public void 两个就绪组件共用同一份可用线路判据()
    {
        var probe = ReadRepoFile("llmgw/serving/GatewayServingReadinessProbe.cs");

        Assert.Contains("private async Task<TenantRoutingView> BuildTenantRoutingViewAsync(", probe);
        // 两个组件各调一次，没有第二条取数路径。
        var uses = System.Text.RegularExpressions.Regex
            .Matches(probe, @"await BuildTenantRoutingViewAsync\(").Count;
        Assert.True(uses >= 2, $"router 与 scenario 都要从这份视图取数，实际只有 {uses} 处");

        // 纯函数入口收下的是「已经筛过的可用模型 id」，不是裸的线路集合——
        // 收线路就等于把「哪些线路算可用」这个判据又交回给调用方各判一次。
        Assert.Contains("IReadOnlySet<string> routableLogicalModelIds,", probe);
        Assert.DoesNotContain("IReadOnlyCollection<GatewayModelOffering> usableOfferings", probe);
    }

    private static string ReadRepoFile(string relativePath)
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !Directory.Exists(Path.Combine(dir.FullName, ".git")))
            dir = dir.Parent;
        Assert.NotNull(dir);
        var full = Path.Combine(dir!.FullName, relativePath);
        Assert.True(File.Exists(full), $"找不到 {relativePath}");
        return File.ReadAllText(full);
    }
}
