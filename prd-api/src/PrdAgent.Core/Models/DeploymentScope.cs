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
/// 作用域为 null。分支级 slug 取**实际被平台注入**的变量
/// （cds/src/services/env-provenance.ts）——注意 CDS_BRANCH_SLUG 只用于镜像模板
/// 替换、并不注入容器 env（Codex P1，PR #1193），不能单独依赖：
///   1. CDS_BRANCH_SLUG   —— 当前不注入，仅为未来 CDS 补注入时的首选位；
///   2. BULLMQ_PREFIX     —— 平台按分支兜底注入的 branch-db-slug（步骤 4.5）；
///   3. VITE_GIT_BRANCH   —— 平台强制注入的原始分支名（版本元数据）；
///   4. CDS_PROJECT_ID    —— 全部取不到时退化为项目级隔离（仍与生产区隔）。
///
/// run 入队时盖上本部署作用域，worker 只认领同作用域的 run（生产认 null，
/// 天然兼容没有该字段的存量文档——Mongo 的 Eq null 匹配字段缺失）。
/// </summary>
public static class DeploymentScope
{
    /// <summary>
    /// 当前部署作用域：CDS 分支预览 = 分支级 slug（见类注释的取值链），生产/本地 = null。
    /// </summary>
    public static string? Current
    {
        get
        {
            // 分支预览的唯一可靠标记是 CDS_PROJECT_ID（与 DeploymentAuthority.IsAuthoritativeDeployment 同口径）。
            var projectId = Read("CDS_PROJECT_ID");
            if (projectId is null) return null;

            return Read("CDS_BRANCH_SLUG")
                   ?? Read("BULLMQ_PREFIX")
                   ?? Read("VITE_GIT_BRANCH")
                   ?? projectId;
        }
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
        var value = Environment.GetEnvironmentVariable(name)?.Trim();
        return string.IsNullOrEmpty(value) ? null : value;
    }
}
