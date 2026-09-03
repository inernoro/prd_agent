using PrdAgent.Core.Models;

namespace PrdAgent.Core.Interfaces;

public interface IHostedSiteOptimizationService
{
    HostedSiteOptimizationAnalysis Analyze(byte[] zipBytes);

    Task<HostedSiteOptimizationSession> CreateSessionAsync(
        string userId,
        byte[] zipBytes,
        string fileName,
        string? targetSiteId,
        string? title,
        string? description,
        string? folder,
        List<string> tags,
        HostedSiteOptimizationAnalysis analysis,
        CancellationToken ct = default);

    Task<HostedSiteOptimizationPreviewResult> PreparePreviewAsync(
        string sessionId,
        string userId,
        CancellationToken ct = default);

    Task<HostedSite> ConfirmAsync(
        string sessionId,
        string userId,
        string variant,
        CancellationToken ct = default);

    Task CancelAsync(string sessionId, string userId, CancellationToken ct = default);
    Task<int> CleanupExpiredAsync(CancellationToken ct = default);
}
