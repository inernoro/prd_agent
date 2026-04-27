using PrdAgent.Core.Models;

namespace PrdAgent.Core.Interfaces;

/// <summary>
/// 视频生成领域服务接口（纯 OpenRouter 直出模式）
/// 2026-04-27 重构：原本支持 Remotion 拆分镜路径，现已简化为只调 OpenRouter 视频大模型。
/// </summary>
public interface IVideoGenService
{
    /// <summary>
    /// 创建视频生成任务（插入 MongoDB，Worker 自动拾取）
    /// </summary>
    /// <param name="appKey">应用标识（如 video-agent、visual-agent）</param>
    /// <param name="ownerAdminId">创建者用户 ID</param>
    /// <param name="request">创建请求</param>
    /// <param name="ct">取消令牌</param>
    /// <returns>新创建的 Run ID</returns>
    Task<string> CreateRunAsync(string appKey, string ownerAdminId, CreateVideoGenRunRequest request, CancellationToken ct = default);

    /// <summary>按 ID 查询视频生成任务</summary>
    Task<VideoGenRun?> GetRunAsync(string runId, string ownerAdminId, string? appKey = null, CancellationToken ct = default);

    /// <summary>分页列出视频生成任务</summary>
    Task<(long total, List<VideoGenRun> items)> ListRunsAsync(string ownerAdminId, string? appKey = null, int limit = 20, int skip = 0, CancellationToken ct = default);

    /// <summary>请求取消任务</summary>
    Task<bool> CancelRunAsync(string runId, string ownerAdminId, string? appKey = null, CancellationToken ct = default);

    /// <summary>统计指定用户今日在指定 appKey 下的视频生成次数</summary>
    Task<long> CountTodayRunsAsync(string ownerAdminId, string appKey, CancellationToken ct = default);

    /// <summary>等待任务完成（轮询，用于工作流胶囊等同步调用场景）</summary>
    Task<VideoGenRun?> WaitForCompletionAsync(string runId, TimeSpan timeout, CancellationToken ct = default);
}
