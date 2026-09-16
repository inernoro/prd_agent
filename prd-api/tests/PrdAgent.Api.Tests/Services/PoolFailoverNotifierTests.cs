using PrdAgent.Infrastructure.ModelPool;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public class PoolFailoverNotifierTests
{
    [Fact]
    public void QuotaAlert_CdsPreview_IncludesBranchEnvironmentModelAndPlatform()
    {
        var values = new Dictionary<string, string?>
        {
            ["CDS_PROJECT_ID"] = "project-1",
            ["VITE_GIT_BRANCH"] = "fix/quota-alert",
            ["ASPNETCORE_ENVIRONMENT"] = "Production",
        };

        var environment = PoolFailoverNotifier.ResolveQuotaEnvironment(
            name => values.GetValueOrDefault(name));
        var message = PoolFailoverNotifier.BuildQuotaNotificationMessage(
            environment.Label,
            "OpenRouter",
            "anthropic/claude-sonnet");

        environment.Label.ShouldBe("CDS 预览环境（分支：fix/quota-alert）");
        message.ShouldContain("环境：CDS 预览环境（分支：fix/quota-alert）");
        message.ShouldContain("模型：anthropic/claude-sonnet");
        message.ShouldContain("平台：OpenRouter");
        message.ShouldNotContain("Key limit exceeded");
    }

    [Fact]
    public void QuotaAlert_Production_UsesFormalEnvironmentLabel()
    {
        var values = new Dictionary<string, string?>
        {
            ["ASPNETCORE_ENVIRONMENT"] = "Production",
        };

        var environment = PoolFailoverNotifier.ResolveQuotaEnvironment(
            name => values.GetValueOrDefault(name));

        environment.Label.ShouldBe("正式环境");
        environment.Identity.ShouldBe("production");
    }

    [Fact]
    public void QuotaAlert_DedupKey_IsolatedByEnvironmentAndModel()
    {
        var first = PoolFailoverNotifier.BuildQuotaNotificationKey(
            "cds:project-1:branch-a",
            "OpenRouter",
            "model-a");
        var otherModel = PoolFailoverNotifier.BuildQuotaNotificationKey(
            "cds:project-1:branch-a",
            "OpenRouter",
            "model-b");
        var otherEnvironment = PoolFailoverNotifier.BuildQuotaNotificationKey(
            "production",
            "OpenRouter",
            "model-a");

        first.ShouldStartWith("llm-quota-exceeded:v2:");
        otherModel.ShouldNotBe(first);
        otherEnvironment.ShouldNotBe(first);
    }
}
