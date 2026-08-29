namespace PrdAgent.Core.LlmGateway;

/// <summary>
/// 网关路由失败，带着**结构化原因**一起抛。
///
/// 为什么要它：`GatewayRouteFailure` 的约定写得很明白——判据只此一份，
/// 应用层只做展示映射，禁止再对错误文案做字符串匹配猜原因。而在这之前，
/// 网关解析失败只留下一句中文，业务层要区分「配置没配好」与「上游暂时抖动」就只能去猜措辞：
/// 猜中了一种写法，另外几种（appCaller 未绑池、池空、平台被关）照样漏，
/// 于是重试一万次也好不了的配置问题被排进了自动重试队列。
/// </summary>
public sealed class GatewayRouteFailureException : Exception
{
    /// <summary><see cref="GatewayRouteFailure"/> 里的常量；上游没给分类时为 null。</summary>
    public string? FailureCode { get; }

    public GatewayRouteFailureException(string? failureCode, string message)
        : base(message)
    {
        FailureCode = failureCode;
    }

    /// <summary>
    /// 把一个 error 流块转成异常，**把码一起带上**。
    ///
    /// 三处业务 Worker 都要做同一件事，各写各的就会像 Codex 第四十六轮 P1 抓到的那样：
    /// 一处带了码、另一处还在 `new InvalidOperationException($"...{chunk.ErrorMessage}")`，
    /// 于是那条链路上的配置失败照旧被判成暂时故障，而据此写的文案分支永远走不到
    /// （predicate-and-wiring-discipline 形状 2：建了一半，删掉不会红）。
    /// </summary>
    /// <param name="prefix">给用户/日志看的场景前缀，如「LLM 调用失败」。</param>
    public static GatewayRouteFailureException FromChunk(Interfaces.LLMStreamChunk chunk, string prefix)
        => new(chunk.ErrorCode, $"{prefix}: {chunk.ErrorMessage}");
}
