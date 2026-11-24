namespace PrdAgent.Api.Services;

/// <summary>
/// 生成任务归属目标团队失败时，给用户看的那句话。
///
/// 它会原样进浏览器的提示框，所以必须是**有限枚举**而不是异常的 Message——
/// Mongo、网络、驱动抛出来的消息里常带库名、主机、协议状态，那些只该进服务端日志
/// （external-cause-first：判断类输出收敛成唯一构造器，分支碰不到句子本身）。
/// </summary>
internal static class DestinationAssignmentFailure
{
    /// <summary>站点查不到或不归发起人所有——归属这一步没有发生。</summary>
    internal const string SiteUnavailable = "站点归属校验未通过";

    /// <summary>发起时还有发布权，应用时已经没有了（角色被降级 / 退出团队）。</summary>
    internal const string PermissionChanged = "你在目标团队的权限已变更，无法投放";

    /// <summary>其余一切：基础设施抖动、超时、未预料的异常。</summary>
    internal const string Unexpected = "归属目标团队时发生错误";

    internal static string Describe(Exception error) =>
        error is UnauthorizedAccessException ? PermissionChanged : Unexpected;
}
