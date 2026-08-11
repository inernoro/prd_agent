using Microsoft.Extensions.Configuration;

namespace PrdAgent.Api.Services;

/// <summary>
/// 当前部署实例标识 —— 由稳定的部署域标识与 git 分支名共同组成。
///
/// 用途：后台任务"定向消费"。同一项目的所有分支预览 + 主干 **共用同一个 MongoDB**
/// （见 .claude/rules/cross-project-isolation.md）。后台 Worker 若按 Status==Queued 无差别
/// 抢任务，A 分支创建的 run 会被 B 分支 / 主干（可能跑着旧代码）抢走处理，导致
/// "代码部署对了但运行的是别的容器的旧代码"。部署域必须区分 CDS 与正式环境，且不能
/// 使用容器 ID 或 commit，才能同时隔离环境并保持滚动发布前后的任务连续性。
/// </summary>
public static class InstanceIdentity
{
    public static string Get(IConfiguration config)
    {
        var branch = Normalize(config["Changelog:GitHubBranch"], "main");
        var environment = Normalize(config["ASPNETCORE_ENVIRONMENT"], "unknown").ToLowerInvariant();
        var deploymentIdentity = Normalize(config["Deployment:Identity"], $"prd-agent:{environment}");
        return $"{deploymentIdentity}::{branch}";
    }

    private static string Normalize(string? value, string fallback)
        => string.IsNullOrWhiteSpace(value) ? fallback : value.Trim();
}
