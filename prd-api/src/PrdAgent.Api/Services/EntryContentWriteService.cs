using System.Text.RegularExpressions;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using DocStoreServices = PrdAgent.Infrastructure.Services.DocumentStore;

namespace PrdAgent.Api.Services;

/// <summary>
/// 知识库正文写入的共享核心路径（从 DocumentStoreController 抽取）。
/// 一次 WriteAsync = ParsedPrd 内容寻址写入（共享保护）→ 更新 Summary/ContentIndex →
/// 重锚定划词评论 → 重算双链账本 → 双版本快照。
///
/// 消费方：
/// - DocumentStoreController.UpdateEntryContent（在线编辑）
/// - DocumentStoreController.ApplyContentToEntryAsync（版本恢复等）
/// - AutoLinkProcessor（知识库级自动补链批处理）
/// 任何新的「往条目写正文」路径必须走本服务，禁止绕开（否则评论锚点/双链/版本历史会脱节）。
/// </summary>
public class EntryContentWriteService
{
    private readonly MongoDbContext _db;
    private readonly IDocumentService _documentService;
    private readonly DocStoreServices.MentionService _mentions;
    private readonly DocStoreServices.DocumentVersionService _versions;

    public EntryContentWriteService(
        MongoDbContext db,
        IDocumentService documentService,
        DocStoreServices.MentionService mentions,
        DocStoreServices.DocumentVersionService versions)
    {
        _db = db;
        _documentService = documentService;
        _mentions = mentions;
        _versions = versions;
    }

    /// <param name="UpdatedAt">写入使用的统一时间戳（DB 与响应必须同值，避免前端缓存键错位）</param>
    /// <param name="MentionsWritten">重算后写入的双链数</param>
    /// <param name="Rebound">重锚定成功的划词评论数</param>
    /// <param name="Orphaned">失锚的划词评论数</param>
    /// <param name="DocumentId">写入后的 ParsedPrd id（内容寻址可能与旧值不同）</param>
    public record WriteResult(DateTime UpdatedAt, int MentionsWritten, int Rebound, int Orphaned, string DocumentId);

    /// <summary>
    /// 把一段正文写入条目。调用方负责：权限校验、资产归一化、模板校验、活动日志。
    /// </summary>
    /// <param name="versionSource">新正文快照的来源（DocumentVersionSource.*）</param>
    /// <param name="restoredFromVersionId">版本恢复时指向被恢复的版本</param>
    /// <param name="contentTypeOverride">非空白时写入 entry.ContentType；索引取材时 null 回退 entry.ContentType（与旧行为一致）</param>
    public async Task<WriteResult> WriteAsync(
        DocumentEntry entry,
        DocumentStore store,
        string content,
        string actorId,
        string? actorName,
        string versionSource,
        string? restoredFromVersionId = null,
        string? contentTypeOverride = null)
    {
        // 更新或创建 ParsedPrd（内容寻址 + 共享保护）
        var (newDocId, oldContent) = await WriteEntryContentDocAsync(entry, content);
        entry.DocumentId = newDocId;

        // 摘要/搜索索引：html 条目剥标签取可读文本
        var indexable = ToIndexableText(content, contentTypeOverride ?? entry.ContentType);
        var summary = indexable.Length > 200 ? indexable[..200] : indexable;
        var contentIndex = indexable.Length > 2000 ? indexable[..2000] : indexable;
        // 单一时间戳：DB 写入与响应必须用同一个 now（否则前端 loadedContentKey 缓存键不一致 → 多余重拉）
        var now = DateTime.UtcNow;

        var contentUpdate = Builders<DocumentEntry>.Update
            .Set(e => e.DocumentId, entry.DocumentId)
            .Set(e => e.Summary, summary.Trim())
            .Set(e => e.ContentIndex, contentIndex.Trim())
            .Set(e => e.UpdatedBy, actorId)
            .Set(e => e.UpdatedByName, actorName)
            .Set(e => e.UpdatedAt, now);
        if (!string.IsNullOrWhiteSpace(contentTypeOverride))
            contentUpdate = contentUpdate.Set(e => e.ContentType, contentTypeOverride);

        await _db.DocumentEntries.UpdateOneAsync(e => e.Id == entry.Id, contentUpdate);

        // 重锚定划词评论
        var (rebound, orphaned) = await RebindInlineCommentsAsync(entry.Id, content);

        // 重算双链账本
        var mentionsWritten = await _mentions.ResyncDocumentMentionsAsync(store.Id, entry.Id, content);

        // 版本快照：先把改动前基线落库（去重），再记本次新正文。最新版本恒等于当前正文。
        // 基线用 Edit：这是用户当前的工作内容，标其他 source 会在历史里误显示来源。
        if (oldContent != null)
            await _versions.SnapshotAsync(entry.Id, store.Id, oldContent, DocumentVersionSource.Edit, actorId, actorName);
        await _versions.SnapshotAsync(entry.Id, store.Id, content, versionSource, actorId, actorName, restoredFromVersionId);

        return new WriteResult(now, mentionsWritten, rebound, orphaned, entry.DocumentId!);
    }

    /// <summary>
    /// 把正文写入 entry 对应的 ParsedPrd，返回 (最终 DocumentId, 改动前正文)。
    /// ParsedPrd 内容寻址（id=内容 hash），相同内容会被多个 entry 共享（相同上传等）。
    /// 若旧 DocumentId 被别的 entry 共享，不得就地覆盖（会改到别的 entry 的正文）——
    /// 按新内容 hash 落库 + 只把本 entry 重指向新文档；旧文档为本 entry 独占时沿用旧 id 就地更新，
    /// 避免产生孤儿文档。即便旧 ParsedPrd 行已丢失也照样落库。
    /// 改动前正文取旧 RawContent；ParsedPrd 行确已丢失时不回退 ContentIndex
    /// （它截断到 2000 字，宁可不快照也不存截断版本）。
    /// </summary>
    public async Task<(string documentId, string? oldContent)> WriteEntryContentDocAsync(DocumentEntry entry, string content)
    {
        var parsed = await _documentService.ParseAsync(content); // parsed.Id = 内容 hash
        string? oldContent;
        if (!string.IsNullOrEmpty(entry.DocumentId))
        {
            var oldDoc = await _documentService.GetByIdAsync(entry.DocumentId);
            oldContent = oldDoc?.RawContent;
            parsed.Title = oldDoc?.Title ?? entry.Title;
            if (parsed.Id != entry.DocumentId)
            {
                var sharedByOthers = await _db.DocumentEntries.CountDocumentsAsync(
                    e => e.DocumentId == entry.DocumentId && e.Id != entry.Id) > 0;
                if (!sharedByOthers)
                    parsed.Id = entry.DocumentId; // 独占 → 复用旧 id 就地更新，不产生孤儿
                // 共享 → 保留新内容 hash id，仅把本 entry 重指向，旧共享文档保持不变
            }
        }
        else
        {
            oldContent = entry.ContentIndex;
            parsed.Title = entry.Title;
        }
        await _documentService.SaveAsync(parsed);
        return (parsed.Id, oldContent);
    }

    /// <summary>
    /// 摘要 / 搜索索引取材：text/html 条目先剥注释、script/style 块与标签取可读文本，
    /// 否则库列表、卡片预览、搜索片段会展示原始 HTML 标记。仅用于派生 Summary/ContentIndex，
    /// 不改动正文本身。非 html 条目原样返回。
    /// </summary>
    public static string ToIndexableText(string content, string? contentType)
    {
        if (string.IsNullOrEmpty(content) ||
            contentType?.Contains("html", StringComparison.OrdinalIgnoreCase) != true)
            return content;
        var text = Regex.Replace(content, @"<!--.*?-->", " ", RegexOptions.Singleline);
        text = Regex.Replace(text, @"<(script|style)\b[^>]*>.*?</\1\s*>", " ",
            RegexOptions.Singleline | RegexOptions.IgnoreCase);
        text = Regex.Replace(text, @"<[^>]+>", " ");
        text = System.Net.WebUtility.HtmlDecode(text);
        return Regex.Replace(text, @"\s+", " ").Trim();
    }

    /// <summary>
    /// 文档正文更新后重新锚定划词评论。
    /// 算法（按成本递增）：
    ///   1) SelectedText 在新正文中唯一出现 → 直接更新 offset
    ///   2) 多处出现 → 用 ContextBefore/ContextAfter 前后文进行消歧，取最佳匹配位置
    ///   3) 零出现 → 状态改为 orphaned，评论保留但前端不再高亮正文
    /// </summary>
    public async Task<(int rebound, int orphaned)> RebindInlineCommentsAsync(string entryId, string newContent)
    {
        // 全文评论（IsWholeDocument）无锚点，不参与正文 rebind。
        // Ne(...,true) 在 MongoDB 下匹配 false / null / 缺字段三种，正好覆盖历史数据。
        var rebindFilter = Builders<DocumentInlineComment>.Filter.And(
            Builders<DocumentInlineComment>.Filter.Eq(c => c.EntryId, entryId),
            Builders<DocumentInlineComment>.Filter.Eq(c => c.Status, DocumentInlineCommentStatus.Active),
            Builders<DocumentInlineComment>.Filter.Ne(c => c.IsWholeDocument, true));
        var comments = await _db.DocumentInlineComments
            .Find(rebindFilter)
            .ToListAsync();

        if (comments.Count == 0) return (0, 0);

        var newHash = ComputeSha256(newContent);
        int rebound = 0, orphaned = 0;

        foreach (var c in comments)
        {
            // 哈希未变（理论上不应走到这里，但保险）
            if (c.ContentHash == newHash) { rebound++; continue; }

            // 委托给纯函数做重锚定（便于单元测试覆盖）
            var result = DocStoreServices.InlineCommentRebinder.TryRebind(
                newContent,
                c.SelectedText ?? string.Empty,
                c.ContextBefore ?? string.Empty,
                c.ContextAfter ?? string.Empty);

            if (result is null)
            {
                await MarkCommentOrphaned(c.Id, newHash);
                orphaned++;
                continue;
            }

            await _db.DocumentInlineComments.UpdateOneAsync(
                x => x.Id == c.Id,
                Builders<DocumentInlineComment>.Update
                    .Set(x => x.StartOffset, result.StartOffset)
                    .Set(x => x.EndOffset, result.EndOffset)
                    .Set(x => x.ContextBefore, result.ContextBefore)
                    .Set(x => x.ContextAfter, result.ContextAfter)
                    .Set(x => x.ContentHash, newHash)
                    .Set(x => x.UpdatedAt, DateTime.UtcNow));
            rebound++;
        }

        return (rebound, orphaned);
    }

    private async Task MarkCommentOrphaned(string commentId, string newHash)
    {
        await _db.DocumentInlineComments.UpdateOneAsync(
            x => x.Id == commentId,
            Builders<DocumentInlineComment>.Update
                .Set(x => x.Status, DocumentInlineCommentStatus.Orphaned)
                .Set(x => x.ContentHash, newHash)
                .Set(x => x.UpdatedAt, DateTime.UtcNow));
    }

    public static string ComputeSha256(string content)
    {
        var bytes = System.Text.Encoding.UTF8.GetBytes(content);
        var hash = System.Security.Cryptography.SHA256.HashData(bytes);
        return Convert.ToHexString(hash);
    }
}
