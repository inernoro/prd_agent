namespace PrdAgent.Core.Models;

/// <summary>
/// 管理后台写接口幂等记录（替代 Redis 缓存）。
/// - 按用户要求：不使用 Redis/内存等时效缓存；幂等记录落 MongoDB。
/// - 通过唯一索引 (ownerAdminId, scope, idempotencyKey) 保证幂等键唯一。
/// </summary>
public class AdminIdempotencyRecord
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    public string OwnerAdminId { get; set; } = string.Empty;

    /// <summary>
    /// 幂等范围（区分不同 API/不同 key），例如：admin prompts put/reset、prompt overrides put/del。
    /// </summary>
    public string Scope { get; set; } = string.Empty;

    public string IdempotencyKey { get; set; } = string.Empty;

    /// <summary>
    /// 直接保存“data payload”的 JSON 字符串（避免引入 Mongo 原生类型字段）。
    /// </summary>
    public string PayloadJson { get; set; } = string.Empty;

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}


