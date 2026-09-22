using PrdAgent.Core.Models;

namespace PrdAgent.Api.Services;

/// <summary>
/// 精读稿的部署作用域判据。
///
/// 形状与 `ModelLeaderboardScope` 一致，理由也一样：判据写成纯函数、env 读取只留薄薄一层，
/// 否则这套东西只有真跑在 CDS 分支预览容器里才走得到，测试得去改进程环境变量、
/// 并行还互相干扰，最后多半写成一条永远跳过的绿灯
/// （`predicate-and-wiring-discipline` 形状 4：不会红的证据比没有证据更糟）。
/// </summary>
public static class BookshelfDigestScope
{
    /// <summary>本部署的作用域。权威部署（生产 / 本地）为 null，CDS 分支预览为 "{projectId}::{branch}"。</summary>
    public static string? Current => DeploymentScope.CurrentDurable;

    /// <summary>这一篇是不是本部署自己写的。</summary>
    public static bool IsOwnDocument(string? deploymentSlug, string? scope)
        => string.Equals(deploymentSlug, scope, StringComparison.Ordinal);

    /// <summary>
    /// 本部署看不看得见它：自己写的，或权威部署写的（存量文档无该字段 = null）。
    ///
    /// 兜底认权威那份是有意的：不认的话每条新预览分支都是一页空书，
    /// 第一个点进来的人要等一篇全新生成才有东西读，验收无从下手。
    /// </summary>
    public static bool IsVisible(string? deploymentSlug, string? scope)
        => deploymentSlug is null || IsOwnDocument(deploymentSlug, scope);

    /// <summary>
    /// 从候选里挑该读的那一篇：**自己的优先，权威的兜底**。
    ///
    /// 顺序不能反。反了就是「本分支明明刚生成过，却一直读到权威那份旧的」，
    /// 于是每次点开都判过期、每次都重烧一篇。
    /// </summary>
    public static BookDigest? PickVisible(IEnumerable<BookDigest> candidates, string? scope)
    {
        BookDigest? authoritative = null;
        foreach (var d in candidates)
        {
            if (IsOwnDocument(d.DeploymentSlug, scope)) return d;
            if (d.DeploymentSlug is null) authoritative = d;
        }
        return authoritative;
    }
}
