using MongoDB.Bson;
using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Services;

/// <summary>只查询已获准空间内的正文引用，不依赖截断索引，也不在读路径回填数据。</summary>
public static class DocumentEntryContentSearch
{
    public static async Task<List<string>> FindAsync(MongoDbContext db,
        FilterDefinition<DocumentEntry> scope, string escapedKeyword, CancellationToken ct)
    {
        var references = await db.DocumentEntries.Find(scope)
            .Project(e => new { e.Id, e.DocumentId, e.AttachmentId }).ToListAsync(ct);
        var matches = new HashSet<string>();
        var regex = new BsonRegularExpression(escapedKeyword, "i");
        // 分批限制 $in 大小；只投影命中标识，正文不回传应用进程。
        foreach (var batch in references.Chunk(500))
        {
            var documentIds = batch.Select(e => e.DocumentId).Where(id => !string.IsNullOrEmpty(id)).Distinct().ToList();
            var docScope = Builders<ParsedPrd>.Filter.In(d => d.Id, documentIds!);
            var authoritative = documentIds.Count == 0 ? new HashSet<string>() : (await db.Documents
                .Find(docScope & Builders<ParsedPrd>.Filter.Ne(d => d.RawContent, null)
                    & Builders<ParsedPrd>.Filter.Ne(d => d.RawContent, ""))
                .Project(d => d.Id).ToListAsync(ct)).ToHashSet();
            var matchedDocs = documentIds.Count == 0 ? new HashSet<string>() : (await db.Documents
                .Find(docScope & Builders<ParsedPrd>.Filter.Regex(d => d.RawContent, regex))
                .Project(d => d.Id).ToListAsync(ct)).ToHashSet();
            var fallback = batch.Where(e => e.DocumentId == null || !authoritative.Contains(e.DocumentId)).ToList();
            var attachmentIds = fallback.Select(e => e.AttachmentId).Where(id => !string.IsNullOrEmpty(id)).Distinct().ToList();
            var matchedAttachments = attachmentIds.Count == 0 ? new List<string>() : await db.Attachments
                .Find(Builders<Attachment>.Filter.In(a => a.AttachmentId, attachmentIds!) &
                    Builders<Attachment>.Filter.Regex(a => a.ExtractedText, regex))
                .Project(a => a.AttachmentId).ToListAsync(ct);
            var attachments = matchedAttachments.ToHashSet();
            foreach (var e in batch)
                if ((e.DocumentId != null && matchedDocs.Contains(e.DocumentId)) ||
                    ((e.DocumentId == null || !authoritative.Contains(e.DocumentId)) && e.AttachmentId != null && attachments.Contains(e.AttachmentId)))
                    matches.Add(e.Id);
        }
        return matches.ToList();
    }
}
