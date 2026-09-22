namespace PrdAgent.Api.Services;

/// <summary>
/// OpenDesign 远端失败时交给用户的那句话，由这里唯一渲染。
///
/// 此前四个 throw 各自拼字符串，于是三处退化成同一句「请在 CDS 会话日志中查看原因后重试」——
/// 而 CDS 的 agent 会话是内存态，失败后随即销毁，用户点进去只会拿到 session_not_found。
/// 更糟的是原因其实就在手上（Error 事件的 message、会话的 LastError），只写进了容器日志。
/// 外因在前、技术细节在后：先说哪一步、因为什么，再说下一步做什么。
///
/// 凭据安全：两个入参都是 MAP 侧落库前已经过滤过的文本——CDS 事件在
/// <see cref="PrdAgent.Infrastructure.Services.InfraAgentSessions.InfraAgentSessionService"/>
/// 落 Error/Status 事件前走 SanitizeCdsEventPayload，会话 LastError 走 SanitizeCdsErrorMessage。
/// 这里不再重做一遍脱敏，避免同一份判据分裂成两处各自漂移。
/// </summary>
internal sealed record OpenDesignFailureStage
{
    /// <summary>
    /// 阶段是数据不是 switch：构造时就必须同时交出「发生了什么」和「下一步做什么」，
    /// 漏填一个编译不过。新增阶段没有「忘了写下一步」这种写法。
    /// </summary>
    private OpenDesignFailureStage(string happened, string nextStepWithReason)
    {
        Happened = happened;
        NextStepWithReason = nextStepWithReason;
    }

    internal string Happened { get; }

    internal string NextStepWithReason { get; }

    /// <summary>原因追不到时统一的下一步：不编造原因，只给一条真的走得通的路。</summary>
    internal const string NextStepWithoutReason =
        "先重新发起一次；连续失败就请管理员在 CDS 分支面板的容器日志里查这次会话";

    internal static readonly OpenDesignFailureStage Dispatch = new(
        "CDS 没有接下这次远程任务",
        "重新发起一次；仍然接不下就说明 CDS 侧暂时不可用，需要管理员检查 CDS 连接");

    internal static readonly OpenDesignFailureStage RemoteRun = new(
        "远端已经开始执行，但中途报错退出",
        "按上面这条原因处理后重新发起");

    internal static readonly OpenDesignFailureStage RemoteSessionEnded = new(
        "远端会话在交出产物之前就已失败",
        "按上面这条原因处理后重新发起");

    internal static readonly OpenDesignFailureStage StartupFailed = new(
        "远端会话没能进入可用状态",
        "按上面这条原因处理后重新发起");

    internal static readonly OpenDesignFailureStage StartupDeadline = new(
        "远端会话在超时前一直没有就绪",
        "重新发起一次；持续超时说明 CDS 侧当前起不出容器，需要管理员检查远程执行器");

    internal static OpenDesignFailureStage Deadline(TimeSpan timeout) => new(
        $"远端在 {(int)timeout.TotalMinutes} 分钟内没有交出产物",
        "缩小设计要求的范围或减少引用的知识篇数后重新发起");
}

internal static class OpenDesignFailureMessage
{
    /// <summary>用户读的是一句话，不是一段日志；原因过长就截断，排障细节本来就在容器日志里。</summary>
    private const int MaxReasonChars = 300;

    internal static string Describe(OpenDesignFailureStage stage, string? remoteReason)
    {
        var reason = Normalize(remoteReason);
        return reason is null
            ? $"网页生成失败：{stage.Happened}，而且远端没有回传原因。下一步：{OpenDesignFailureStage.NextStepWithoutReason}。"
            : $"网页生成失败：{stage.Happened}——{reason}。下一步：{stage.NextStepWithReason}。";
    }

    private static string? Normalize(string? remoteReason)
    {
        if (string.IsNullOrWhiteSpace(remoteReason)) return null;
        var flattened = remoteReason.Replace('\r', ' ').Replace('\n', ' ').Trim();
        // 远端偶尔只回传一个占位词，它和「没回传」是同一件事，不该被渲染成一条像模像样的原因。
        if (flattened.Length == 0 || string.Equals(flattened, "unknown", StringComparison.OrdinalIgnoreCase))
            return null;
        return flattened.Length <= MaxReasonChars ? flattened : flattened[..MaxReasonChars] + "…";
    }
}
