using Microsoft.Extensions.Configuration;

namespace PrdAgent.Infrastructure.Security;

/// <summary>
/// 判定当前容器是否为「权威部署」（authoritative deployment），并产出可追溯的来源标签。
///
/// 背景：admin_notifications 等集合被所有 CDS 分支预览容器 + 生产容器共享同一个 Mongo 库
/// （dbScope 默认 shared，prd-api 读的 MongoDB__DatabaseName 不做 per-branch 后缀，恒为
/// 「prdagent」）。全局告警行（TargetUserId=null + 固定 Key）只有一行，谁都能开/关。
/// 若每个分支预览容器都去写这行，任何跑着旧构建（缺 IsStub 过滤）或注入了不匹配密钥的分支，
/// 都会把一条误报「复活」成看似全局的生产事故——这正是「平台 API key 解密失败」告警反复出现的
/// 物理根因（见 .claude/rules/cross-project-isolation.md 通道 1/2/4）。
///
/// 规则：只有权威部署（非 CDS 分支预览）才管理共享库里的全局告警行、才做密文自动重加密。
/// CDS 分支预览容器（env 带 CDS_PROJECT_ID）仍做只读自检并在容器日志里 LogWarning，
/// 但绝不写共享库，避免污染全局。
/// </summary>
public static class DeploymentAuthority
{
    /// <summary>
    /// 显式开关。设为 "true"/"false" 时优先于自动判定：
    /// 生产强制权威可写 true；某个分支想临时接管全局告警可写 true；反之写 false 彻底静默。
    /// </summary>
    public const string ManageGlobalNotificationKey = "PlatformKeyIntegrity:ManageGlobalNotification";

    /// <summary>
    /// 当前部署是否有权写共享库里的全局告警行 / 自动重加密存量密文。
    /// 默认：无 CDS 分支预览标记（CDS_PROJECT_ID）的部署（即生产）为权威；分支预览非权威。
    /// </summary>
    public static bool IsAuthoritativeDeployment(IConfiguration configuration)
    {
        var explicitFlag = configuration[ManageGlobalNotificationKey];
        if (bool.TryParse(explicitFlag, out var forced))
            return forced;

        // CDS 给每个分支预览容器注入 CDS_PROJECT_ID（cds/src/routes/branches.ts）；
        // 生产走独立发布链路，没有这个标记。
        var cdsProjectId = ReadFirst(configuration, "CDS_PROJECT_ID");
        return string.IsNullOrWhiteSpace(cdsProjectId);
    }

    /// <summary>
    /// 产出短来源标签（host@sha·branch），写进告警文案，便于一眼看出是「哪个容器、哪个构建」在喊，
    /// 旧容器的喊叫不再冒充无名的全局事故。
    /// </summary>
    public static string DescribeSource(IConfiguration configuration)
    {
        var host = SafeMachineName();

        var commit = ReadFirst(configuration, "GIT_COMMIT", "COMMIT_SHA", "GITHUB_SHA", "SOURCE_VERSION", "CDS_COMMIT_SHA");
        var shortCommit = string.IsNullOrWhiteSpace(commit) ? "unknown" : commit!.Trim();
        if (shortCommit.Length > 8)
            shortCommit = shortCommit[..8];

        var branch = ReadFirst(configuration, "CDS_BRANCH_SLUG", "CDS_PROJECT_SLUG");
        var label = $"{host}@{shortCommit}";
        return string.IsNullOrWhiteSpace(branch) ? label : $"{label}·{branch!.Trim()}";
    }

    // 只从 IConfiguration 读——prd-api 的 host builder 默认 AddEnvironmentVariables，
    // 容器注入的 CDS_PROJECT_ID / GIT_COMMIT 等 OS 环境变量已在 IConfiguration 里。
    // 不再额外探 Environment.GetEnvironmentVariable：那是冗余的（生产行为不变），
    // 且会泄漏进程环境导致单测受 CI runner 的 GITHUB_SHA 等 ambient env 干扰、非确定。
    private static string? ReadFirst(IConfiguration configuration, params string[] keys)
    {
        foreach (var key in keys)
        {
            var value = configuration[key];
            if (!string.IsNullOrWhiteSpace(value))
                return value;
        }
        return null;
    }

    private static string SafeMachineName()
    {
        try { return Environment.MachineName; }
        catch { return "host"; }
    }
}
