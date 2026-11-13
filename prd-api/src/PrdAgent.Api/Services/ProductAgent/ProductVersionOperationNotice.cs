using System.Text;
using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Services.ProductAgent;

internal sealed class ProductVersionOperationNotice
{
    private const string CollectionName = "product_version_operation_notices";

    public string Id { get; set; } = string.Empty;
    public bool Formal { get; set; }
    public string Text { get; set; } = string.Empty;
    public ProductClaimNotification ClaimNotification { get; set; } = new();

    internal static IMongoCollection<ProductVersionOperationNotice> Collection(MongoDbContext db)
        => db.Database.GetCollection<ProductVersionOperationNotice>(CollectionName);

    internal static async Task<bool?> QueueAsync(MongoDbContext db, bool formal, string action, string id,
        string? code, string? application, string? plan, string actor, string reason, DateTime now)
    {
        var config = (await db.ProductAgentSettings.Find(x => x.Id == ProductAgentSettings.SingletonId).FirstOrDefaultAsync())?.ClaimWebhook;
        if (config?.Enabled != true || (formal ? !config.NotifyFormal : !config.NotifyInternal)) return null;

        var key = $"{action}:{(formal ? "V" : "T")}:{id}";
        var text = BuildText(action == "void", code, application, plan, actor, reason, now);
        var update = Builders<ProductVersionOperationNotice>.Update
            .SetOnInsert(x => x.Formal, formal)
            .SetOnInsert(x => x.Text, text)
            .SetOnInsert(x => x.ClaimNotification, new ProductClaimNotification());
        await Collection(db).UpdateOneAsync(x => x.Id == key, update, new UpdateOptions { IsUpsert = true }, CancellationToken.None);
        return true;
    }

    internal static string BuildText(bool isVoid, string? code, string? application, string? plan,
        string actor, string reason, DateTime now)
    {
        var operation = isVoid ? "作废" : "删除";
        return string.Join("\n",
            $"【版本{operation}】",
            $"版本号：{Compact(code, 30, "未发号")}",
            $"所属应用：{Compact(application, 60)}",
            $"方案：{Compact(plan, 110)}",
            $"操作人：{Compact(actor, 40)}",
            $"{operation}原因：{Compact(reason, 170)}",
            $"操作时间：{now.AddHours(8):yyyy.MM.dd HH:mm}（北京时间）",
            isVoid ? "处理结果：记录已作废，原版本号保留。" : "处理结果：记录已删除，后续按保留的记录发号。");
    }

    private static string Compact(string? value, int limit, string fallback = "—")
    {
        if (string.IsNullOrWhiteSpace(value)) return fallback;
        var characters = value.Trim().Replace('\r', ' ').Replace('\n', ' ').EnumerateRunes().Take(limit + 1).ToArray();
        var text = string.Concat(characters.Take(limit).Select(character => character.ToString()));
        return characters.Length > limit ? text + "…" : text;
    }
}
