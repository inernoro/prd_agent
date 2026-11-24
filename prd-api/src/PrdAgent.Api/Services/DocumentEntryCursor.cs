using System.Text;
using System.Text.Json;
using MongoDB.Driver;
using PrdAgent.Core.Models;

namespace PrdAgent.Api.Services;

/// <summary>导航游标：固定创建时间边界，按不可变 ID 翻页；权限仍由每次请求独立判定。</summary>
public sealed record DocumentEntryCursor(string StoreId, DateTime Before, string AfterId)
{
    public string Encode() => Convert.ToBase64String(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(this)));

    public static bool TryDecode(string value, string storeId, out DocumentEntryCursor? cursor)
    {
        cursor = null;
        if (value.Length > 2048) return false;
        try
        {
            cursor = JsonSerializer.Deserialize<DocumentEntryCursor>(Convert.FromBase64String(value));
            return cursor != null && cursor.StoreId == storeId && !string.IsNullOrEmpty(cursor.AfterId)
                && cursor.Before.Kind == DateTimeKind.Utc && cursor.Before <= DateTime.UtcNow;
        }
        catch (Exception ex) when (ex is FormatException or JsonException or ArgumentException) { return false; }
    }

    public FilterDefinition<DocumentEntry> Filter()
    {
        var f = Builders<DocumentEntry>.Filter;
        return f.Eq(e => e.StoreId, StoreId) & f.Lte(e => e.CreatedAt, Before)
            & (string.IsNullOrEmpty(AfterId) ? f.Empty : f.Gt(e => e.Id, AfterId));
    }
}
