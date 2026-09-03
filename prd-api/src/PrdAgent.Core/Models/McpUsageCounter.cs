using MongoDB.Bson.Serialization.Attributes;

namespace PrdAgent.Core.Models;

/// <summary>
/// 接入台按密钥的当日用量计数器 —— 配额闸门的事实源。
///
/// 为什么不直接数调用记录：那是「先查历史、后写记录」，两步之间有窗口。
/// 并发打进来的请求都会读到同一个还没被谁写过的旧值，于是一把 50 张额度的密钥
/// 能同时放行 100 个生图请求，成本闸门形同虚设（多实例部署把窗口拉得更大）。
/// 这里改成「先原子占坑、失败再退还」：占坑用 $inc + upsert 一次完成，没有中间态。
///
/// Id 是确定性的 `{keyId}:{yyyyMMdd}:{kind}`，靠主键天然唯一，不需要额外索引。
/// </summary>
[BsonIgnoreExtraElements]
public class McpUsageCounter
{
    /// <summary>`{keyId}:{yyyyMMdd(UTC)}:{kind}`</summary>
    public string Id { get; set; } = string.Empty;

    public string KeyId { get; set; } = string.Empty;

    /// <summary>image（生图张数）或 write（写入类动作次数）</summary>
    public string Kind { get; set; } = string.Empty;

    /// <summary>所属自然日（UTC 零点）。与配额文案里写的口径一致。</summary>
    public DateTime DayUtc { get; set; }

    public int Count { get; set; }

    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}
