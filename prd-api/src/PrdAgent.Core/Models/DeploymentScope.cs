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
/// 语义：CDS 给分支预览容器注入 CDS_BRANCH_SLUG；生产走独立发布链路没有该变量，
/// 作用域为 null。run 入队时盖上本部署作用域，worker 只认领同作用域的 run
/// （生产认 null，天然兼容没有该字段的存量文档——Mongo 的 Eq null 匹配字段缺失）。
/// </summary>
public static class DeploymentScope
{
    /// <summary>
    /// 当前部署作用域：分支预览 = CDS_BRANCH_SLUG（trim 后），生产/本地 = null。
    /// </summary>
    public static string? Current
    {
        get
        {
            var slug = Environment.GetEnvironmentVariable("CDS_BRANCH_SLUG");
            slug = slug?.Trim();
            return string.IsNullOrEmpty(slug) ? null : slug;
        }
    }
}
