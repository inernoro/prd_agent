namespace PrdAgent.Core.Models;

/// <summary>
/// 当前容器的部署作用域标识（run 队列隔离用）。
///
/// 背景：image_gen_runs 等 run 队列集合被所有 CDS 分支预览容器 + 生产容器共享同一个
/// Mongo 库（dbScope shared，见 .claude/rules/cross-project-isolation.md 通道 4）。
/// 历史上 ImageGenRunWorker 的认领过滤只看 Status，任何部署的 worker 都能抢走任意
/// 部署入队的 run——跑旧构建的 worker 抢到新分支的 run 后用旧代码执行，表现为
/// 「分支上修好的 bug 在分支预览里反复复现 / 新旧两种错误文案混出」（2026-07-19
/// 视觉创作 stub-vision 事故）。与 BULLMQ_PREFIX（通道 7）同性质，本类是 Mongo
/// run 队列侧的对应物。
///
/// 判定口径（与 DeploymentAuthority 同源）：CDS 给每个分支预览容器注入
/// CDS_PROJECT_ID（cds/src/routes/branches.ts）；生产走独立发布链路没有该标记，
/// 作用域为 null。分支预览作用域 = "{CDS_PROJECT_ID}::{分支级 slug}::revision::{commit}"——项目 ID
/// 必须参与复合，否则共库的两个项目部同名分支会撞 slug。分支级 slug 取
/// **实际被平台强制注入**的变量（cds/src/services/env-provenance.ts）：
///   1. VITE_GIT_BRANCH   —— 平台**强制覆盖**注入的原始分支名（版本元数据），
///                           不可被项目配置改写，是唯一可信的分支身份；
///   2. BULLMQ_PREFIX     —— 兜底。注意它可被项目 customEnv 显式钉死以跨分支
///                           共享队列（受支持配置），此时不是分支身份——故只在
///                           强制注入值取不到时才用（Codex P2，Round 3）。
///   不读 CDS_BRANCH_SLUG：它不是平台保留派生键，容器里若出现只能来自项目
///   可配置 env 层（在强制注入层之前合并），把它当作用域等于允许配置伪造 /
///   跨分支撞车（Codex P2，Round 4）。若未来 CDS 以受保护来源注入它再启用。
///   分支变量全部取不到时退化为纯 CDS_PROJECT_ID 项目级隔离（仍与生产区隔）。
/// revision 取 GIT_COMMIT / COMMIT_SHA / GITHUB_SHA / SOURCE_VERSION /
/// CDS_COMMIT_SHA / VERCEL_GIT_COMMIT_SHA 的首个非空值。revision 必须参与预览
/// scope：同一分支滚动部署时，旧容器仍可能短暂存活；若 scope 只到分支级，旧
/// Worker 会抢走新 commit 入队的任务并用旧代码执行。把 revision 写进原有等值
/// 过滤字段后，旧 Worker 无需理解新字段也无法匹配新任务。
///
/// run 入队时盖上本部署作用域，worker 只认领同作用域的 run（生产认 null，
/// 天然兼容没有该字段的存量文档——Mongo 的 Eq null 匹配字段缺失）。
/// </summary>
public static class DeploymentScope
{
    /// <summary>
    /// 当前部署作用域：CDS 分支预览 = "{projectId}::{分支级 slug}::revision::{commit}"
    /// （见类注释的取值链），
    /// 生产/本地 = null。项目 ID 必须参与复合（Codex P1，Round 2）：BULLMQ_PREFIX /
    /// VITE_GIT_BRANCH 都是纯分支值，两个共享同一 Mongo 库的 CDS 项目若部署同名分支
    /// （如都叫 main），纯分支 slug 会撞车、互相认领/复用对方的 run。
    /// </summary>
    public static string? Current
    {
        get
        {
            // 分支预览的唯一可靠标记是 CDS_PROJECT_ID（与 DeploymentAuthority.IsAuthoritativeDeployment 同口径）。
            var projectId = Read("CDS_PROJECT_ID");
            if (projectId is null) return null;

            var branch = Read("VITE_GIT_BRANCH")
                         ?? Read("BULLMQ_PREFIX");
            var revision = Read("GIT_COMMIT")
                           ?? Read("COMMIT_SHA")
                           ?? Read("GITHUB_SHA")
                           ?? Read("SOURCE_VERSION")
                           ?? Read("CDS_COMMIT_SHA")
                           ?? Read("VERCEL_GIT_COMMIT_SHA");

            return Compose(projectId, branch, revision);
        }
    }

    internal static string? Compose(string? projectId, string? branch, string? revision)
    {
        projectId = Normalize(projectId);
        if (projectId is null) return null;

        branch = Normalize(branch);
        revision = Normalize(revision);
        var scope = branch is null ? projectId : $"{projectId}::{branch}";
        return revision is null ? scope : $"{scope}::revision::{revision}";
    }

    /// <summary>
    /// 把调用方给的幂等键升格为部署作用域内的键：分支预览加 "{scope}::" 前缀，
    /// 生产/本地（作用域 null）原样返回（兼容存量键与既有唯一索引语义）。
    ///
    /// 背景（Codex P1，PR #1193）：image_gen_runs 的幂等唯一索引是
    /// (OwnerAdminId, IdempotencyKey)，而前端会用确定性键（如
    /// imRun_{workspaceId}_{key}）——run 按部署作用域隔离后，若键不隔离，
    /// 在 A 分支重试会命中 B 分支（另一个 DeploymentSlug）的 run：要么拿到
    /// 旧部署的陈旧结果，要么撞唯一索引后本地 worker 无 run 可执行。
    /// 空白键原样返回（调用方自行判空决定是否启用幂等）。
    /// </summary>
    public static string ScopeIdempotencyKey(string key)
    {
        if (string.IsNullOrWhiteSpace(key)) return key;
        var scope = Current;
        return scope is null ? key : $"{scope}::{key}";
    }

    private static string? Read(string name)
    {
        return Normalize(Environment.GetEnvironmentVariable(name));
    }

    private static string? Normalize(string? value)
    {
        value = value?.Trim();
        return string.IsNullOrEmpty(value) ? null : value;
    }
}
