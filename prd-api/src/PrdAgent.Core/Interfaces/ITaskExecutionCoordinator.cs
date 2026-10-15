using PrdAgent.Core.LlmGateway;
using PrdAgent.Core.Security;

namespace PrdAgent.Core.Interfaces;

/// <summary>平台付费任务的业务身份、执行代次与撤销裁决。业务不得以本地状态代替此授权。</summary>
public interface ITaskExecutionCoordinator
{
    Task<TaskExecutionAdmission> RegisterAsync(GatewayTaskPermitRecord permit, bool inline, CancellationToken ct);
    Task<TaskExecutionLease> AcquireAsync(string permitId, string? runId, CancellationToken ct);
    Task<bool> RenewAsync(TaskExecutionLeaseProof proof, CancellationToken ct);
    Task<bool> ValidateAsync(TaskExecutionLeaseProof proof, bool beforeDispatch, CancellationToken ct);
    Task<bool> ValidateHashAsync(string permitId, string? runId, string ownerHash, long fence,
        bool beforeDispatch, CancellationToken ct, string? businessRunId = null);
    Task<bool> CompleteAsync(TaskExecutionLeaseProof proof, CancellationToken ct);
    Task RevokeAsync(string permitId, string? runId, CancellationToken ct);
    Task ChangeActorAuthorizationAsync(string tenantId, string actorId, bool enabled, CancellationToken ct);
    Task ChangeCredentialAuthorizationAsync(string tenantId, string credentialId, bool enabled, CancellationToken ct);
    Task RevokeCredentialAsync(string tenantId, string credentialId, CancellationToken ct);
    Task<(long Actor, long Credential)> ReadAuthorizationVersionsAsync(
        string tenantId, string actorId, string credentialId, CancellationToken ct);
    Task SaveAcceptedResponseAsync(string permitId, int status, string contentType, string? body, CancellationToken ct);
}

public sealed record TaskExecutionAdmission(GatewayTaskPermitRecord Permit, bool Replayed, TaskExecutionLease? Lease);

public sealed record TaskExecutionAttempt(TaskExecutionLease? Lease, bool ShouldSkip) : IAsyncDisposable
{
    public static async Task<TaskExecutionAttempt> AcquireAsync(ITaskExecutionCoordinator? coordinator,
        string? permitId, string runId)
    {
        // 无平台服务的测试装配不制造权限；生产统一出口仍强制拒绝没有租约的身份。
        if (coordinator is null || string.IsNullOrWhiteSpace(permitId)) return new(null, false);
        try { return new(await coordinator.AcquireAsync(permitId, runId, CancellationToken.None), false); }
        catch (TaskExecutionAdmissionException e) when (e.Code == "TASK_EXECUTION_UNAVAILABLE" && e.StatusCode == 409)
        { return new(null, true); }
    }
    public ValueTask DisposeAsync() => Lease?.DisposeAsync() ?? ValueTask.CompletedTask;
}

/// <summary>租约由后台独立续期，HTTP 被动断开不取消。失效后永久停止续期，不能复活旧代次。</summary>
public sealed class TaskExecutionLease : IAsyncDisposable
{
    private readonly ITaskExecutionCoordinator _coordinator;
    private readonly CancellationTokenSource _stop = new();
    private readonly CancellationTokenSource _lost = new();
    private readonly Task _renewal;
    private readonly bool _borrowed;
    private int _disposed;

    public TaskExecutionLeaseProof Proof { get; }
    public TaskExecutionIdentity Identity => new(Proof.PermitId, Proof.RunId, Proof);
    public CancellationToken LostToken => _lost.Token;
    public bool IsLost => _lost.IsCancellationRequested;

    public TaskExecutionLease(ITaskExecutionCoordinator coordinator, TaskExecutionLeaseProof proof, bool borrowed = false)
    {
        _coordinator = coordinator;
        Proof = proof;
        _borrowed = borrowed;
        _renewal = borrowed ? Task.CompletedTask : RenewAsync();
    }

    private async Task RenewAsync()
    {
        try
        {
            while (!_stop.IsCancellationRequested)
            {
                await Task.Delay(TimeSpan.FromSeconds(10), _stop.Token);
                if (!await _coordinator.RenewAsync(Proof, _stop.Token))
                {
                    _lost.Cancel();
                    return;
                }
            }
        }
        catch (OperationCanceledException) when (_stop.IsCancellationRequested) { }
        catch { _lost.Cancel(); }
    }

    public async ValueTask DisposeAsync()
    {
        if (Interlocked.Exchange(ref _disposed, 1) != 0) return;
        _stop.Cancel();
        try { await _renewal; }
        catch (OperationCanceledException) { }
        if (!_borrowed)
        {
            try
            {
                if (!await _coordinator.CompleteAsync(Proof, CancellationToken.None)) _lost.Cancel();
            }
            catch { _lost.Cancel(); }
        }
        _stop.Dispose();
        // 异步子操作可能仍观察 LostToken；不释放其源，失效状态必须保持可观察。
    }
}
