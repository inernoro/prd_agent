using PrdAgent.Core.Models;

namespace PrdAgent.Core.Interfaces;

/// <summary>
/// 视频生成领域服务接口
/// 封装视频生成任务的创建、查询、状态流转等通用逻辑，
/// 供 VideoAgentController、VisualAgentVideoController 及工作流胶囊复用。
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

    /// <summary>
    /// 按 ID 查询视频生成任务（带所有者 + appKey 过滤）
    /// </summary>
    Task<VideoGenRun?> GetRunAsync(string runId, string ownerAdminId, string? appKey = null, CancellationToken ct = default);

    /// <summary>
    /// 分页列出视频生成任务
    /// </summary>
    Task<(long total, List<VideoGenRun> items)> ListRunsAsync(string ownerAdminId, string? appKey = null, int limit = 20, int skip = 0, CancellationToken ct = default);

    /// <summary>
    /// 更新单个分镜内容（仅 Editing 阶段）
    /// </summary>
    Task<(VideoGenScene scene, double totalDuration)> UpdateSceneAsync(string runId, string ownerAdminId, int sceneIndex, UpdateVideoSceneRequest request, string? appKey = null, CancellationToken ct = default);

    /// <summary>
    /// 标记分镜为重新生成状态（Worker 自动拾取）
    /// </summary>
    Task RegenerateSceneAsync(string runId, string ownerAdminId, int sceneIndex, string? appKey = null, CancellationToken ct = default);

    /// <summary>
    /// 触发视频渲染（Editing → Rendering）
    /// </summary>
    Task TriggerRenderAsync(string runId, string ownerAdminId, string? appKey = null, CancellationToken ct = default);

    /// <summary>
    /// 标记分镜预览渲染（imageStatus=running）
    /// </summary>
    Task RequestScenePreviewAsync(string runId, string ownerAdminId, int sceneIndex, string? appKey = null, CancellationToken ct = default);

    /// <summary>
    /// 标记分镜背景图生成（backgroundImageStatus=running）
    /// </summary>
    Task RequestSceneBgImageAsync(string runId, string ownerAdminId, int sceneIndex, string? appKey = null, CancellationToken ct = default);

    /// <summary>
    /// 请求取消任务
    /// </summary>
    Task<bool> CancelRunAsync(string runId, string ownerAdminId, string? appKey = null, CancellationToken ct = default);

    /// <summary>
    /// 统计指定用户今日在指定 appKey 下的视频生成次数
    /// </summary>
    Task<long> CountTodayRunsAsync(string ownerAdminId, string appKey, CancellationToken ct = default);

    /// <summary>
    /// 等待任务完成（轮询，用于工作流胶囊等同步调用场景）
    /// </summary>
    /// <param name="runId">任务 ID</param>
    /// <param name="timeout">超时时间</param>
    /// <param name="ct">取消令牌</param>
    /// <returns>完成的 VideoGenRun，超时则返回 null</returns>
    Task<VideoGenRun?> WaitForCompletionAsync(string runId, TimeSpan timeout, CancellationToken ct = default);

    /// <summary>
    /// 标记单个分镜的 TTS 音频为生成中（audioStatus=running），Worker 自动拾取
    /// </summary>
    Task RequestSceneAudioAsync(string runId, string ownerAdminId, int sceneIndex, string? appKey = null, CancellationToken ct = default);

    /// <summary>
    /// 批量标记所有分镜的 TTS 音频为生成中
    /// </summary>
    Task RequestAllAudioAsync(string runId, string ownerAdminId, string? appKey = null, CancellationToken ct = default);
}
