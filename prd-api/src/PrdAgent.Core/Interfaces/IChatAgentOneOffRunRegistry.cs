namespace PrdAgent.Core.Interfaces;

/// <summary>
/// 一次性转派（<see cref="IChatAgentService.StreamOneOffAsync"/>）的 runId → 发起人台账。
///
/// 为什么需要它：工具是由运行时反向回调主服务执行的，回调里只有 runId。
/// 会话路径能靠 runId 回查 ChatAgentMessages 找到归属用户；一次性转派不落库，
/// 这条线断了——工具全都会因「没有用户身份」而拒绝执行，
/// 表现为「通用体说它调了工具，但什么也没发生」。
///
/// **已知边界（进程内存，非共享）**：多副本部署时，回调打到别的实例就查不到。
/// 当前部署形态是「一个作用域一个容器」（与 ChatAgentService.ReconcileInterruptedTurnsAsync
/// 的前提一致），成立。真要横向扩容，这里必须换成共享存储。
/// 记在 doc/debt.knowledge-base.md。
/// </summary>
public interface IChatAgentOneOffRunRegistry
{
    /// <summary>登记一次转派的发起人。</summary>
    void Register(string runId, string userId);

    /// <summary>转派结束后销号，不留悬挂身份。</summary>
    void Release(string runId);

    /// <summary>回查发起人。查不到返回 null——调用方必须据此拒绝，绝不放行无主调用。</summary>
    string? TryResolveUserId(string? runId);
}
