using Microsoft.Extensions.Configuration;

namespace PrdAgent.Api.Services;

/// <summary>
/// 当前部署实例标识 —— 用 git 分支名（每个 CDS 预览分支 / 主干各不相同，主干默认 "main"）。
///
/// 用途：后台任务"定向消费"。同一项目的所有分支预览 + 主干 **共用同一个 MongoDB**
/// （见 .claude/rules/cross-project-isolation.md）。后台 Worker 若按 Status==Queued 无差别
/// 抢任务，A 分支创建的 run 会被 B 分支 / 主干（可能跑着旧代码）抢走处理，导致
/// "代码部署对了但运行的是别的容器的旧代码"。给每个 run 打上 OwnerInstanceId，Worker
/// 只领取 == 自己实例（或历史无主）的 run，即可让每个容器只消费自己的任务。
/// </summary>
public static class InstanceIdentity
{
    public static string Get(IConfiguration config)
        => (config["Changelog:GitHubBranch"] ?? "main").Trim();
}
