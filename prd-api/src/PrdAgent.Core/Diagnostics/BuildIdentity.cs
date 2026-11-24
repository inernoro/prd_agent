namespace PrdAgent.Core.Diagnostics;

/// <summary>
/// 构建身份对账：区分「实际值」与「期待值」。
///
/// 背景（2026-08-04 真实事故）：版本端点原先只报一个 commit，取自容器启动时注入的
/// GIT_COMMIT 环境变量。而部署平台会把该变量刷成分支当前 commit —— 镜像还没换、
/// 二进制还是旧的，端点却照样报最新 commit。验收的人据此认为新代码上线了，实际
/// 新增的路由在容器里根本不存在。
///
/// 结论：**一个值没法自证**。运行态必须同时给出
///   - 实际值 Actual：编译期烤进程序集的 commit（运行时改不了）
///   - 期待值 Declared：部署声明希望跑的 commit（env 注入，可被改写）
/// 两者不一致就是「跑的不是你以为的那版」，必须当场标出来而不是让人事后猜。
/// </summary>
public static class BuildIdentity
{
    /// <summary>实际值与期待值的对账结论</summary>
    public enum MatchState
    {
        /// <summary>两者一致：运行的就是部署声明的那版</summary>
        Match,

        /// <summary>两者不一致：容器多半还是旧镜像，端点的版本号在骗人</summary>
        Mismatch,

        /// <summary>缺其中一边，无法对账（旧镜像没烤 commit，或未注入部署声明）</summary>
        Unknown,
    }

    /// <summary>
    /// 从 AssemblyInformationalVersion 里取出编译期烤进来的 commit。
    /// 约定：publish 时传 -p:SourceRevisionId=&lt;sha&gt;，.NET 会把它拼成 "1.0.0+&lt;sha&gt;"。
    /// 取不到就返回 null（旧镜像），由调用方降级为 Unknown，不要伪造。
    /// </summary>
    public static string? ParseBakedCommit(string? informationalVersion)
    {
        if (string.IsNullOrWhiteSpace(informationalVersion)) return null;
        var idx = informationalVersion.IndexOf('+');
        if (idx < 0 || idx >= informationalVersion.Length - 1) return null;
        var sha = informationalVersion[(idx + 1)..].Trim();
        return string.IsNullOrWhiteSpace(sha) ? null : sha;
    }

    /// <summary>
    /// 对账。两边都拿得到才判 Match/Mismatch；缺一边一律 Unknown —— 缺证据不等于没问题。
    /// 允许短 SHA 与长 SHA 比对（一方是另一方的前缀且长度 >= 7 视为同一 commit）。
    /// </summary>
    public static MatchState Compare(string? actual, string? declared)
    {
        if (string.IsNullOrWhiteSpace(actual) || string.IsNullOrWhiteSpace(declared))
            return MatchState.Unknown;

        var a = actual.Trim();
        var d = declared.Trim();
        if (string.Equals(a, d, StringComparison.OrdinalIgnoreCase)) return MatchState.Match;

        var shorter = a.Length <= d.Length ? a : d;
        var longer = a.Length <= d.Length ? d : a;
        if (shorter.Length >= 7 && longer.StartsWith(shorter, StringComparison.OrdinalIgnoreCase))
            return MatchState.Match;

        return MatchState.Mismatch;
    }

    /// <summary>对账不通过时给一句说人话的告警；通过或无法对账时返回 null。</summary>
    public static string? DescribeMismatch(MatchState state, string? actual, string? declared)
    {
        if (state != MatchState.Mismatch) return null;
        return $"运行中的二进制编译自 {Short(actual)}，而本次部署声明的是 {Short(declared)}："
             + "容器很可能仍是旧镜像，请以 actualCommit 为准，不要拿本端点确认新代码已上线。";
    }

    public static string? Short(string? commit)
    {
        if (string.IsNullOrWhiteSpace(commit)) return null;
        var t = commit.Trim();
        return t.Length <= 8 ? t : t[..8];
    }

    public static string ToWireValue(MatchState state) => state switch
    {
        MatchState.Match => "match",
        MatchState.Mismatch => "mismatch",
        _ => "unknown",
    };
}
