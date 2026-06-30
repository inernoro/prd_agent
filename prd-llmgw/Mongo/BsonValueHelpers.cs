using MongoDB.Bson;

namespace PrdAgent.LlmGw.Mongo;

/// <summary>
/// 从 BsonDocument 安全读取字段的辅助方法。
/// 历史日志里数值字段可能是 Int32 / Int64 / Double 混存，日期可能是 BsonDateTime 或字符串，
/// 直接强类型反序列化容易抛异常，因此统一走这里手动归一。
/// </summary>
public static class BsonValueHelpers
{
    public static string? AsNullableString(this BsonDocument doc, string name)
    {
        if (!doc.TryGetValue(name, out var v) || v.IsBsonNull) return null;
        return v.BsonType switch
        {
            BsonType.String => v.AsString,
            _ => v.ToString(),
        };
    }

    public static string GetStringOrEmpty(this BsonDocument doc, string name)
        => doc.AsNullableString(name) ?? string.Empty;

    public static int? AsNullableInt(this BsonDocument doc, string name)
    {
        if (!doc.TryGetValue(name, out var v) || v.IsBsonNull) return null;
        return v.BsonType switch
        {
            BsonType.Int32 => v.AsInt32,
            BsonType.Int64 => (int)v.AsInt64,
            BsonType.Double => (int)v.AsDouble,
            BsonType.String when int.TryParse(v.AsString, out var p) => p,
            _ => null,
        };
    }

    public static long? AsNullableLong(this BsonDocument doc, string name)
    {
        if (!doc.TryGetValue(name, out var v) || v.IsBsonNull) return null;
        return v.BsonType switch
        {
            BsonType.Int32 => v.AsInt32,
            BsonType.Int64 => v.AsInt64,
            BsonType.Double => (long)v.AsDouble,
            BsonType.String when long.TryParse(v.AsString, out var p) => p,
            _ => null,
        };
    }

    public static bool? AsNullableBool(this BsonDocument doc, string name)
    {
        if (!doc.TryGetValue(name, out var v) || v.IsBsonNull) return null;
        return v.BsonType switch
        {
            BsonType.Boolean => v.AsBoolean,
            BsonType.Int32 => v.AsInt32 != 0,
            BsonType.Int64 => v.AsInt64 != 0,
            BsonType.String when bool.TryParse(v.AsString, out var p) => p,
            _ => null,
        };
    }

    /// <summary>读取 UTC DateTime（可空）。</summary>
    public static DateTime? AsNullableUtcDateTime(this BsonDocument doc, string name)
    {
        if (!doc.TryGetValue(name, out var v) || v.IsBsonNull) return null;
        return v.BsonType switch
        {
            BsonType.DateTime => DateTime.SpecifyKind(v.ToUniversalTime(), DateTimeKind.Utc),
            BsonType.String when DateTime.TryParse(
                v.AsString,
                System.Globalization.CultureInfo.InvariantCulture,
                System.Globalization.DateTimeStyles.AdjustToUniversal | System.Globalization.DateTimeStyles.AssumeUniversal,
                out var parsed) => DateTime.SpecifyKind(parsed, DateTimeKind.Utc),
            _ => null,
        };
    }

    /// <summary>UTC DateTime 转 ISO 8601 字符串（带 Z），null 透传。</summary>
    public static string? ToIso(this DateTime? value)
        => value?.ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ", System.Globalization.CultureInfo.InvariantCulture);
}
