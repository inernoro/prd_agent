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
    /// 当前部署是否有权**写共享库里的全局告警行**（notification 层）。
    /// 默认：无 CDS 分支预览标记（CDS_PROJECT_ID）的部署（即生产）为权威；分支预览非权威。
    /// 可用显式开关 <see cref="ManageGlobalNotificationKey"/> 让某个分支临时接管全局告警。
    ///
    /// 注意：本判定**只管通知**，绝不代表可以改写共享库密文——那是 <see cref="CanRotateSharedCiphertext"/>
    /// 的职责，两者独立。接管通知的分支若同时被允许 rotate，会用本分支密钥改写生产密文（P2，
    /// Codex review r3580140302）。
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
    /// 当前部署是否有权**改写共享库存量密文**（rotation 层，把 legacy 密文重加密到 primary）。
    /// 与通知授权**独立且更严**，同时满足两条才允许：
    /// 1. 未被显式关停共享状态归属——`ManageGlobalNotification=false` 是「我不拥有任何共享状态」的
    ///    总开关，standby/canary 用它退出时，连密文也不许动（P2，Codex review r3580192158）；
    /// 2. 是真正的生产部署（无 CDS 分支预览标记 CDS_PROJECT_ID）。
    ///
    /// 关键：`ManageGlobalNotification=true` 这个「接管通知」开关**绝不**解锁 preview 的 rotation
    /// （落到第 2 条的 CDS 标记判定，preview 恒 false）。否则异钥 CDS 预览分支一旦接管通知，就会把
    /// legacy-decrypted 的共享库密文重加密成本分支密钥、打哑生产——正是本 PR 要防的密文腐蚀场景。
    /// 一句话：软开关只能**收紧**（false 一票否决），不能**放宽** rotation。
    /// </summary>
    public static bool CanRotateSharedCiphertext(IConfiguration configuration)
    {
        // 条件 1：显式 false = 退出所有共享状态归属 → 一票否决，连密文都不动。
        var explicitFlag = configuration[ManageGlobalNotificationKey];
        if (bool.TryParse(explicitFlag, out var forced) && !forced)
            return false;

        // 条件 2：rotation 只认生产（无 CDS 分支预览标记）；true 开关不额外为 preview 放宽。
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
