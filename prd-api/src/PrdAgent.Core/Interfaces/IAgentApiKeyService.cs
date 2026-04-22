using PrdAgent.Core.Models;

namespace PrdAgent.Core.Interfaces;

/// <summary>
/// Agent 开放接口 API Key 管理服务。
/// </summary>
public interface IAgentApiKeyService
{
    /// <summary>
    /// 创建 Key。返回 (实体, 明文 Key)；明文仅此处返回一次，后续只存哈希。
    /// </summary>
    Task<(AgentApiKey key, string plaintext)> CreateAsync(
        string ownerUserId,
        string name,
        string? description,
        IEnumerable<string> scopes,
        int ttlDays,
        CancellationToken ct = default);

    /// <summary>
    /// 通过明文 Key 查找（鉴权路径；返回 null 表示无效/未启用/已撤销/已超宽限期）。
    /// 同时返回是否处于"过期但在宽限期内"的状态，便于上层推送续期提示。
    /// </summary>
    Task<AgentApiKeyLookupResult?> LookupByPlaintextAsync(string plaintext, CancellationToken ct = default);

    /// <summary>列出某用户的所有 Key（管理 UI 消费）</summary>
    Task<List<AgentApiKey>> ListByOwnerAsync(string ownerUserId, CancellationToken ct = default);

    /// <summary>查单个 Key（供所有权校验）</summary>
    Task<AgentApiKey?> GetByIdAsync(string id, CancellationToken ct = default);

    /// <summary>续期：把 ExpiresAt 延长 ttlDays 天（以当前时间或原过期时间两者较晚者为基准）</summary>
    Task<bool> RenewAsync(string id, int ttlDays, CancellationToken ct = default);

    /// <summary>撤销 Key（立即失效，不可恢复）</summary>
    Task<bool> RevokeAsync(string id, CancellationToken ct = default);

    /// <summary>更新元数据（名称/说明/Scopes/激活状态）</summary>
    Task<bool> UpdateMetadataAsync(
        string id,
        string? name,
        string? description,
        IEnumerable<string>? scopes,
        bool? isActive,
        CancellationToken ct = default);

    /// <summary>删除 Key（硬删除；撤销用 RevokeAsync）</summary>
    Task<bool> DeleteAsync(string id, CancellationToken ct = default);

    /// <summary>鉴权成功后记录一次调用（LastUsedAt + TotalRequests +=1）</summary>
    Task TouchUsageAsync(string id, CancellationToken ct = default);
}

/// <summary>
/// Key 鉴权查找结果。InGracePeriod=true 时请求仍放行，但应在响应头提示续期。
/// </summary>
public record AgentApiKeyLookupResult(AgentApiKey Key, bool InGracePeriod);
