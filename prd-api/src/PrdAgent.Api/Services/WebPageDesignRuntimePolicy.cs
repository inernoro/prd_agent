using PrdAgent.Core.Models;

namespace PrdAgent.Api.Services;

/// <summary>
/// 新网页生成与修改任务的运行时权威。普通客户端提交的 runtime 只作兼容输入，
/// 不再决定执行器；历史任务仍由已持久化的 DesignArtifactRun.Runtime 分派。
/// </summary>
public static class WebPageDesignRuntimePolicy
{
    public const string RequiredRuntime = DesignArtifactRuntimes.OpenDesign;

    public static WebPageDesignRuntimeDecision ResolveForNewRun(string? requestedRuntime)
    {
        var requested = requestedRuntime?.Trim().ToLowerInvariant();
        return new WebPageDesignRuntimeDecision(
            RequiredRuntime,
            !string.IsNullOrWhiteSpace(requested)
            && !string.Equals(requested, RequiredRuntime, StringComparison.Ordinal));
    }
}

public sealed record WebPageDesignRuntimeDecision(
    string Runtime,
    bool ClientOverrideIgnored);
