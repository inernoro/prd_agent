using System.Text.Json;
using Microsoft.AspNetCore.DataProtection;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Security;

namespace PrdAgent.Infrastructure.Security;

/// <summary>侧车工具沿用既有反向回调 token 通道，改为加密的单次任务授权；不向模型暴露租约密钥。</summary>
public sealed class TaskContinuationTokens(IDataProtectionProvider protection, ITaskExecutionCoordinator executions)
{
    private const string Prefix = "map-task-v2.";
    private readonly IDataProtector _protector = protection.CreateProtector("Platform.TaskContinuation.v2");
    public string Issue(TaskExecutionIdentity identity, string callbackRun, string subject, DateTime expires)
    {
        if (identity.Lease is null) throw new TaskExecutionAdmissionException("TASK_EXECUTION_LEASE_INVALID", "任务执行租约无效，未启动工具执行。");
        return Prefix + _protector.Protect(JsonSerializer.Serialize(new Ticket(identity, callbackRun, subject, expires)));
    }
    public async Task<TaskExecutionIdentity?> ValidateAsync(string token, string callbackRun, string? subject)
    {
        if (!token.StartsWith(Prefix, StringComparison.Ordinal)) return null;
        try
        {
            var ticket = JsonSerializer.Deserialize<Ticket>(_protector.Unprotect(token[Prefix.Length..]));
            if (ticket is null || ticket.ExpiresAt <= DateTime.UtcNow || ticket.CallbackRun != callbackRun
                || ticket.Subject != subject || ticket.Identity.Lease is not { } lease
                || ticket.Identity.PermitId != lease.PermitId
                || !await executions.ValidateHashAsync(lease.PermitId, lease.RunId, TaskExecutionCoordinator.OwnerHash(lease.OwnerToken),
                    lease.Fence, false, CancellationToken.None, ticket.Identity.RunId)) return null;
            return ticket.Identity;
        }
        catch (Exception e) when (e is System.Security.Cryptography.CryptographicException or JsonException or FormatException) { return null; }
    }
    public async Task<bool> ValidateTokenAsync(string token)
    {
        try
        {
            if (!IsTaskToken(token)) return false;
            var ticket = JsonSerializer.Deserialize<Ticket>(_protector.Unprotect(token[Prefix.Length..]));
            return ticket is not null && await ValidateAsync(token, ticket.CallbackRun, ticket.Subject) is not null;
        }
        catch (Exception e) when (e is System.Security.Cryptography.CryptographicException or JsonException or FormatException) { return false; }
    }
    public static bool IsTaskToken(string token) => token.StartsWith(Prefix, StringComparison.Ordinal);
    private sealed record Ticket(TaskExecutionIdentity Identity, string CallbackRun, string Subject, DateTime ExpiresAt);
}
