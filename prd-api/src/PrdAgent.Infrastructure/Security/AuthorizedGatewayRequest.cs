using PrdAgent.Core.Interfaces;
using PrdAgent.Core.LlmGateway;
using PrdAgent.Core.Security;

namespace PrdAgent.Infrastructure.Security;

/// <summary>
/// 所有 MAP 模型运输共用的发送门。许可只由服务端 authorizer 核验，HTTP 自报字段不能开门。
/// 本类型不选模型、不消耗次数；次数由 serving 对每一次真正发送原子核销。
/// </summary>
public static class AuthorizedGatewayRequest
{
    public const string HttpClientName = "MapModelGateway";
    private sealed record AuthorizationStamp(Uri? Target, HttpMethod Method, string PermitId);
    private static readonly HttpRequestOptionsKey<AuthorizationStamp?> Authorized = new("map.task-authorized");

    public static async Task PrepareAsync(
        HttpRequestMessage message,
        ITaskExecutionAuthorizer? authorizer,
        string appCallerCode,
        GatewayRequestContext? context,
        CancellationToken ct)
    {
        message.Options.Set(Authorized, null);
        // 不能把请求自带头或旧 AutomaticTaskExecutionContext 当作许可。
        message.Headers.Remove("X-Gateway-Task-Permit");
        message.Headers.Remove("X-Gateway-Execution-Origin");
        message.Headers.Remove("X-Gateway-Source-Deployment");
        message.Headers.Remove("X-Gateway-Source-Task");
        message.Headers.Remove("X-Gateway-Trigger-Credential");
        if (authorizer is null)
            throw new TaskExecutionAdmissionException("TASK_EXECUTION_NOT_ADMITTED",
                "本次任务尚未获得执行许可，请从正常操作入口重新发起。", 403);

        await authorizer.AuthorizeOutboundAsync(message, appCallerCode, context, ct);
        if (!message.Headers.TryGetValues("X-Gateway-Task-Permit", out var permits)
            || permits.Count() != 1 || string.IsNullOrWhiteSpace(permits.Single()))
            throw new TaskExecutionAdmissionException("TASK_EXECUTION_NOT_ADMITTED",
                "本次任务尚未获得执行许可，请从正常操作入口重新发起。", 403);
        message.Options.Set(Authorized, new(message.RequestUri, message.Method, permits.Single()));
    }

    internal static bool WasAuthorized(HttpRequestMessage message)
        => message.Options.TryGetValue(Authorized, out var stamp) && stamp is not null
           && message.RequestUri == stamp.Target && message.Method == stamp.Method
           && message.Headers.TryGetValues("X-Gateway-Task-Permit", out var permits)
           && permits.SequenceEqual(new[] { stamp.PermitId }, StringComparer.Ordinal);
}
