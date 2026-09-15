using PrdAgent.Core.Models;

namespace PrdAgent.Core.Interfaces;

public interface IHostedSiteOptimizationService
{
    Task<HostedSiteOptimizationSession> CreateUploadAsync(
        string userId,
        CreateHostedSiteOptimizationUploadRequest request,
        CancellationToken ct = default);

    Task UploadChunkAsync(
        string sessionId,
        string userId,
        int chunkIndex,
        byte[] chunkBytes,
        CancellationToken ct = default);

    Task QueueUploadAsync(string sessionId, string userId, CancellationToken ct = default);

    Task<HostedSiteOptimizationUploadStatusResult> GetUploadStatusAsync(
        string sessionId,
        string userId,
        CancellationToken ct = default);

    Task<bool> ProcessNextQueuedAsync(CancellationToken ct = default);

    Task<HostedSiteOptimizationQueueHealth> GetQueueHealthAsync(CancellationToken ct = default);

    HostedSiteOptimizationAnalysis Analyze(byte[] zipBytes);

    Task<HostedSiteOptimizationPreviewResult> PreparePreviewAsync(
        string sessionId,
        string userId,
        CancellationToken ct = default);

    Task<HostedSiteOptimizationPreviewFileResult?> GetPreviewFileAsync(
        string sessionId,
        string accessToken,
        string filePath,
        CancellationToken ct = default);

    Task<HostedSite> ConfirmAsync(
        string sessionId,
        string userId,
        string variant,
        CancellationToken ct = default);

    Task CancelAsync(string sessionId, string userId, CancellationToken ct = default);
    Task<(int Selected, int Deleted)> CleanupExpiredAsync(CancellationToken ct = default);
}
