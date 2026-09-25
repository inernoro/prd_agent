namespace PrdAgent.Api.Services;

/// <summary>
/// OpenDesign 远端失败时交给用户的那句话，由这里唯一渲染。
///
/// 此前四个 throw 各自拼字符串，于是三处退化成同一句「请在 CDS 会话日志中查看原因后重试」——
/// 而 CDS 的 agent 会话是内存态，失败后随即销毁，用户点进去只会拿到 session_not_found。
/// 更糟的是原因其实就在手上（Error 事件的 message、会话的 LastError），只写进了容器日志。
/// 外因在前、技术细节在后：先说哪一步、因为什么，再说下一步做什么。
/// 远端原文属于技术细节：不进用户读的那句话，挂在异常链里进日志（见 Failure）。
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

    /// <summary>
    /// 远端给了诊断、但原文只进日志时的下一步：用户看不到原文，就不能让他「按上面这条原因处理」。
    /// </summary>
    internal const string NextStepWithDiagnosticInLog =
        "先重新发起一次；连续失败就请管理员按本次任务在服务端日志里查看这条诊断";

    internal static readonly OpenDesignFailureStage Dispatch = new(
        "CDS 没有接下这次远程任务",
        "重新发起一次；仍然接不下就说明 CDS 侧暂时不可用，需要管理员检查 CDS 连接");

    internal static readonly OpenDesignFailureStage RemoteRun = new(
        "远端已经开始执行，但中途报错退出",
        NextStepWithDiagnosticInLog);

    internal static readonly OpenDesignFailureStage RemoteSessionEnded = new(
        "远端会话在交出产物之前就已失败",
        NextStepWithDiagnosticInLog);

    internal static readonly OpenDesignFailureStage StartupFailed = new(
        "远端会话没能进入可用状态",
        NextStepWithDiagnosticInLog);

    /// <summary>共享 CDS 节点在上一个会话结束后会做一次能力自检，自检期间新会话会被拒绝。</summary>
    internal static readonly OpenDesignFailureStage RuntimeVerifying = new(
        "CDS 执行节点刚结束上一个设计任务、正在做能力自检，已自动换新会话重试仍未就绪",
        "等一两分钟后按原要求重试；反复出现说明节点自检卡住，需要管理员查看 CDS 节点");

    internal static readonly OpenDesignFailureStage StartupDeadline = new(
        "远端会话在超时前一直没有就绪",
        "重新发起一次；持续超时说明 CDS 侧当前起不出容器，需要管理员检查远程执行器");

    internal static OpenDesignFailureStage Deadline(TimeSpan timeout) => new(
        $"远端在 {(int)timeout.TotalMinutes} 分钟内没有交出产物",
        "缩小设计要求的范围或减少引用的知识篇数后重新发起");
}

/// <summary>
/// 远端回传的原始诊断，挂在给用户那条异常的 InnerException 上：用户读 Message（人话），
/// 排障看日志里的异常链（worker 用 LogError(ex, ...) 记录，内层会一起打出来）。
/// </summary>
internal sealed class OpenDesignRemoteDiagnosticException : Exception
{
    internal OpenDesignRemoteDiagnosticException(string? code, string diagnostic)
        : base(string.IsNullOrWhiteSpace(code) ? diagnostic : $"[{code}] {diagnostic}")
    {
        RemoteCode = code;
        Diagnostic = diagnostic;
    }

    internal string? RemoteCode { get; }

    internal string Diagnostic { get; }
}

internal static class OpenDesignFailureMessage
{
    /// <summary>
    /// 远端错误码 → 用户读得懂的原因与下一步。这是数据不是 if：一行一类，码取自 CDS
    /// AgentWorkspaceRuntimeError 的有限集合。没登记的码、没有码的自由文本，一律走
    /// <see cref="UnmappedReason"/>——不把远端原文（文件名、端点名、HTTP 细节）摆到用户面前
    ///（PR #1533 评审 4081291421）。原文不丢，挂在异常链里进日志。
    /// </summary>
    private static readonly (string[] Codes, string Reason, string NextStep)[] KnownRemoteCodes =
    [
        (["design_output_quality_rejected", "design_output_invalid", "design_output_missing",
          "design_output_too_large", "design_output_too_many_files"],
            "生成出来的页面没有通过发布前的校验",
            "直接重新发起一次；反复出现就缩小设计要求或减少引用的知识后再试"),
        (["open_design_run_timeout"],
            "远端设计执行超时",
            "缩小设计要求的范围或减少引用的知识篇数后重新发起"),
        (["workspace_package_invalid", "workspace_package_hash_mismatch", "workspace_transfer_invalid",
          "workspace_transfer_too_large", "workspace_transfer_required", "workspace_copy_failed",
          "workspace_commit_invalid_response"],
            "远端与 MAP 之间传递任务资料或结果时失败",
            "重新发起一次；连续失败请管理员检查 CDS 与 MAP 之间的连接"),
        (["workspace_runtime_unavailable", "workspace_container_start_failed", "workspace_container_address_failed",
          "workspace_network_create_failed", "workspace_volume_create_failed", "workspace_egress_unavailable",
          "open_design_not_ready"],
            "CDS 执行节点暂时起不出可用的设计容器",
            "等一两分钟后重新发起；持续出现请管理员检查 CDS 远程执行器"),
        (["open_design_contract_mismatch", "design_instruction_invalid"],
            "远端执行器与本次任务的约定不一致",
            "重新发起一次；仍然失败说明执行器版本与 MAP 不匹配，需要管理员处理"),
    ];

    /// <summary>远端给了诊断、但不在上表里：说清有原因、原因在哪，不把原文端给用户。</summary>
    internal const string UnmappedReason = "远端回传了一条技术诊断（原文已记入服务端日志）";

    /// <summary>
    /// 构造交给用户的那条异常：Message 是人话，远端原文放进 InnerException。
    /// 有远端原因的抛点一律走这里，不再自己 new InvalidOperationException(Describe(...))。
    /// </summary>
    internal static InvalidOperationException Failure(
        OpenDesignFailureStage stage,
        string? remoteReason,
        string? remoteCode = null)
    {
        var diagnostic = string.IsNullOrWhiteSpace(remoteReason) ? null : remoteReason.Trim();
        return new InvalidOperationException(
            Describe(stage, remoteReason, remoteCode),
            diagnostic == null ? null : new OpenDesignRemoteDiagnosticException(remoteCode?.Trim(), diagnostic));
    }

    internal static string Describe(OpenDesignFailureStage stage, string? remoteReason, string? remoteCode = null)
    {
        if (!HasReason(remoteReason))
            return $"网页生成失败：{stage.Happened}，而且远端没有回传原因。下一步：{OpenDesignFailureStage.NextStepWithoutReason}。";

        var code = remoteCode?.Trim();
        foreach (var (codes, reason, nextStep) in KnownRemoteCodes)
        {
            if (code != null && codes.Contains(code, StringComparer.Ordinal))
                return $"网页生成失败：{stage.Happened}——{reason}。下一步：{nextStep}。";
        }
        return $"网页生成失败：{stage.Happened}——{UnmappedReason}。下一步：{stage.NextStepWithReason}。";
    }

    private static bool HasReason(string? remoteReason)
    {
        if (string.IsNullOrWhiteSpace(remoteReason)) return false;
        // 远端偶尔只回传一个占位词，它和「没回传」是同一件事，不该被渲染成一条像模像样的原因。
        return !string.Equals(remoteReason.Trim(), "unknown", StringComparison.OrdinalIgnoreCase);
    }
}
