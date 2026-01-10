using PrdAgent.Core.Models;

namespace PrdAgent.Core.Interfaces;

/// <summary>
/// 开放平台服务接口
/// </summary>
public interface IOpenPlatformService
{
    /// <summary>
    /// 创建应用
    /// </summary>
    /// <param name="appName">应用名称</param>
    /// <param name="description">应用描述</param>
    /// <param name="boundUserId">绑定用户 ID</param>
    /// <param name="boundGroupId">绑定群组 ID（可选）</param>
    /// <param name="ignoreUserSystemPrompt">是否忽略外部请求中的系统提示词（role=system），启用后将过滤外部 system 消息（默认 true）</param>
    /// <returns>应用实体和明文 API Key</returns>
    Task<(OpenPlatformApp app, string apiKey)> CreateAppAsync(
        string appName,
        string? description,
        string boundUserId,
        string? boundGroupId,
        bool ignoreUserSystemPrompt = true);

    /// <summary>
    /// 通过 API Key 获取应用
    /// </summary>
    /// <param name="apiKey">API Key 明文</param>
    /// <returns>应用实体，如果不存在或未启用则返回 null</returns>
    Task<OpenPlatformApp?> GetAppByApiKeyAsync(string apiKey);

    /// <summary>
    /// 通过 ID 获取应用
    /// </summary>
    Task<OpenPlatformApp?> GetAppByIdAsync(string appId);

    /// <summary>
    /// 获取应用列表（分页）
    /// </summary>
    Task<(List<OpenPlatformApp> apps, long total)> GetAppsAsync(
        int page,
        int pageSize,
        string? search = null);

    /// <summary>
    /// 更新应用
    /// </summary>
    Task<bool> UpdateAppAsync(
        string appId,
        string? appName = null,
        string? description = null,
        string? boundUserId = null,
        string? boundGroupId = null);

    /// <summary>
    /// 删除应用
    /// </summary>
    Task<bool> DeleteAppAsync(string appId);

    /// <summary>
    /// 重新生成 API Key
    /// </summary>
    /// <returns>新的 API Key 明文</returns>
    Task<string?> RegenerateApiKeyAsync(string appId);

    /// <summary>
    /// 切换应用启用状态
    /// </summary>
    Task<bool> ToggleAppStatusAsync(string appId);

    /// <summary>
    /// 记录请求日志
    /// </summary>
    Task LogRequestAsync(OpenPlatformRequestLog log);

    /// <summary>
    /// 获取请求日志（分页）
    /// </summary>
    Task<(List<OpenPlatformRequestLog> logs, long total)> GetRequestLogsAsync(
        int page,
        int pageSize,
        string? appId = null,
        DateTime? startTime = null,
        DateTime? endTime = null,
        int? statusCode = null);

    /// <summary>
    /// 更新应用使用统计
    /// </summary>
    Task UpdateAppUsageAsync(string appId);
}
