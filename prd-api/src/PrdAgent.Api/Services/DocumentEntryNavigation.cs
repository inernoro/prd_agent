using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Services;

/// <summary>调用方先完成公开性或分享范围门禁；此处只在该范围内检索和翻页。</summary>
public static class DocumentEntryNavigation
{
    public sealed record Page(List<DocumentEntry> items, long total, string? nextCursor);

    public static async Task<Page?> ReadAsync(MongoDbContext db, string storeId,
        FilterDefinition<DocumentEntry> scope, int pageSize, string? cursor,
        string? keyword, bool searchContent, CancellationToken ct)
    {
        DocumentEntryCursor? position = null;
        if (!string.IsNullOrEmpty(cursor) && !DocumentEntryCursor.TryDecode(cursor, storeId, out position)) return null;
        position ??= new DocumentEntryCursor(storeId, DateTime.UtcNow, "");
        var f = Builders<DocumentEntry>.Filter;
        scope &= f.Lte(e => e.CreatedAt, position.Before);
        if (!string.IsNullOrWhiteSpace(keyword))
        {
            var kw = System.Text.RegularExpressions.Regex.Escape(keyword.Trim());
            var regex = new MongoDB.Bson.BsonRegularExpression(kw, "i");
            var matches = f.Regex(e => e.Title, regex) | f.Regex(e => e.Summary, regex);
            if (searchContent)
                matches |= f.In(e => e.Id, await DocumentEntryContentSearch.FindAsync(db, scope & !matches, kw, ct));
            scope &= matches;
        }
        var total = await db.DocumentEntries.CountDocumentsAsync(scope, cancellationToken: ct);
        pageSize = Math.Clamp(pageSize, 1, 2000);
        var items = await db.DocumentEntries.Find(scope & position.Filter()).SortBy(e => e.Id)
            .Project<DocumentEntry>(Builders<DocumentEntry>.Projection.Exclude(e => e.ContentIndex))
            .Limit(pageSize + 1).ToListAsync(ct);
        string? next = null;
        if (items.Count > pageSize)
        {
            items.RemoveAt(items.Count - 1);
            next = (position with { AfterId = items[^1].Id }).Encode();
        }
        return new Page(items, total, next);
    }
}
