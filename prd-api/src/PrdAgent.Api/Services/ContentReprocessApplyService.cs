using System.Text;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Services;

/// <summary>
/// 文档再加工「写回」服务 —— 不消耗 LLM，只把对话里某条 assistant 消息落到 DocumentEntry。
///
/// 三种模式：
///   - replace : 覆盖源 entry 的正文
///   - append  : 把生成内容追加到源 entry 正文末尾
///   - new     : 落成一篇新 DocumentEntry（同父目录），返回新 entry id
/// </summary>
public class ContentReprocessApplyService
{
    private readonly IDocumentService _documentService;
    private readonly ILogger<ContentReprocessApplyService> _logger;

    public ContentReprocessApplyService(IDocumentService documentService, ILogger<ContentReprocessApplyService> logger)
    {
        _documentService = documentService;
        _logger = logger;
    }

    /// <summary>
    /// 写回结果。FinalBody 是真正落到 entry / 新 entry 上的最终正文，调用方需要在写回后
    /// 重绑划词评论 offset 时直接拿这份字符串用，不要再去 DB 重新读 —— 因为这时候 DB 已经
    /// 是后置状态，对 append 模式会让"重新拼"再 append 一次 aiContent，造成 offset 偏移
    /// （Codex P2 反馈）。
    /// </summary>
    public record ApplyResult(string Mode, string? OutputEntryId, string? UpdatedEntryId, string FinalBody);

    public async Task<ApplyResult> ApplyAsync(
        DocumentStoreAgentRun run,
        DocumentEntry sourceEntry,
        int messageSeq,
        string mode,
        string? title,
        MongoDbContext db)
    {
        // 旧 BSON 文档可能没 Messages 字段（Bugbot #1 四轮 High）
        var messages = run.Messages ?? new List<ReprocessChatMessage>();
        if (messages.Count <= messageSeq || messageSeq < 0)
            throw new InvalidOperationException("messageSeq 越界");

        var msg = messages[messageSeq];
        if (msg.Role != "assistant")
            throw new InvalidOperationException("只有 assistant 消息可以写回");

        var content = msg.Content?.Trim() ?? string.Empty;
        if (string.IsNullOrEmpty(content))
            throw new InvalidOperationException("消息内容为空");

        // actor = 发起这次写回的用户。chat 路径上 run.UserId 就是登录用户；apply-content
        // 路径上 controller 构造了 tmpRun 也用 GetUserId() 喂 UserId。两路径都正确。
        var actorId = run.UserId;

        return mode switch
        {
            "replace" => await ReplaceAsync(sourceEntry, content, actorId, db),
            "append" => await AppendAsync(sourceEntry, content, actorId, db),
            "new" => await CreateNewAsync(sourceEntry, content, title, actorId, db),
            _ => throw new InvalidOperationException($"未知 mode: {mode}"),
        };
    }

    private async Task<ApplyResult> ReplaceAsync(DocumentEntry entry, string content, string actorId, MongoDbContext db)
    {
        await SaveContentToEntryAsync(entry, content, actorId, db);
        return new ApplyResult("replace", null, entry.Id, FinalBody: content);
    }

    private async Task<ApplyResult> AppendAsync(DocumentEntry entry, string content, string actorId, MongoDbContext db)
    {
        var existing = await LoadEntryContentAsync(entry);
        var merged = string.IsNullOrEmpty(existing)
            ? content
            : existing.TrimEnd() + "\n\n" + content;
        await SaveContentToEntryAsync(entry, merged, actorId, db);
        return new ApplyResult("append", null, entry.Id, FinalBody: merged);
    }

    private async Task<ApplyResult> CreateNewAsync(
        DocumentEntry sourceEntry, string content, string? title, string userId, MongoDbContext db)
    {
        var parsed = await _documentService.ParseAsync(content);
        var finalTitle = string.IsNullOrWhiteSpace(title)
            ? BuildOutputTitle(sourceEntry.Title)
            : title!.Trim();
        parsed.Title = finalTitle;
        await _documentService.SaveAsync(parsed);

        var newEntry = new DocumentEntry
        {
            StoreId = sourceEntry.StoreId,
            ParentId = sourceEntry.ParentId,
            Title = finalTitle,
            Summary = content.Length > 200 ? content[..200] : content,
            SourceType = DocumentSourceType.Upload,
            ContentType = "text/markdown",
            FileSize = Encoding.UTF8.GetByteCount(content),
            DocumentId = parsed.Id,
            CreatedBy = userId,
            ContentIndex = content.Length > 2000 ? content[..2000] : content,
            LastChangedAt = DateTime.UtcNow,
            Metadata = new Dictionary<string, string>
            {
                ["generated_kind"] = "reprocess",
                ["source_entry_id"] = sourceEntry.Id,
            },
        };
        await db.DocumentEntries.InsertOneAsync(newEntry);

        await db.DocumentStores.UpdateOneAsync(
            s => s.Id == sourceEntry.StoreId,
            Builders<DocumentStore>.Update
                .Inc(s => s.DocumentCount, 1)
                .Set(s => s.UpdatedAt, DateTime.UtcNow),
            cancellationToken: CancellationToken.None);

        _logger.LogInformation(
            "[doc-store-agent] Apply mode=new src={SrcId} → new={NewId}", sourceEntry.Id, newEntry.Id);
        return new ApplyResult("new", newEntry.Id, null, FinalBody: content);
    }

    private async Task<string> LoadEntryContentAsync(DocumentEntry entry)
    {
        if (!string.IsNullOrEmpty(entry.DocumentId))
        {
            var doc = await _documentService.GetByIdAsync(entry.DocumentId);
            if (doc != null && !string.IsNullOrEmpty(doc.RawContent))
                return doc.RawContent;
        }
        return entry.ContentIndex ?? string.Empty;
    }

    private async Task SaveContentToEntryAsync(DocumentEntry entry, string content, string actorId, MongoDbContext db)
    {
        ParsedPrd parsed;
        if (!string.IsNullOrEmpty(entry.DocumentId))
        {
            var existing = await _documentService.GetByIdAsync(entry.DocumentId);
            parsed = await _documentService.ParseAsync(content);
            parsed.Id = entry.DocumentId;
            parsed.Title = existing?.Title ?? entry.Title;
        }
        else
        {
            parsed = await _documentService.ParseAsync(content);
            parsed.Title = entry.Title;
        }
        await _documentService.SaveAsync(parsed);

        // 与 UpdateEntryContent 保持一致：把"最近编辑者"更新到当前 actor，
        // 否则团队场景下 audit/活动流会错误归属（Codex P2 十轮）
        // run.UserId 就是发起这次 AI 写回的人（chat endpoint 写入 run 时校验过 GetUserId）。
        await db.DocumentEntries.UpdateOneAsync(
            e => e.Id == entry.Id,
            Builders<DocumentEntry>.Update
                .Set(e => e.DocumentId, parsed.Id)
                .Set(e => e.Summary, content.Length > 200 ? content[..200] : content)
                .Set(e => e.ContentIndex, content.Length > 2000 ? content[..2000] : content)
                .Set(e => e.FileSize, Encoding.UTF8.GetByteCount(content))
                .Set(e => e.ContentType, "text/markdown")
                .Set(e => e.LastChangedAt, DateTime.UtcNow)
                .Set(e => e.UpdatedAt, DateTime.UtcNow)
                .Set(e => e.UpdatedBy, actorId),
            cancellationToken: CancellationToken.None);

        _logger.LogInformation(
            "[doc-store-agent] Apply entry={EntryId} chars={Len}", entry.Id, content.Length);
    }

    private static string BuildOutputTitle(string srcTitle)
    {
        var baseName = Path.GetFileNameWithoutExtension(srcTitle);
        if (string.IsNullOrWhiteSpace(baseName)) baseName = srcTitle;
        return $"{baseName}-AI 再加工.md";
    }
}
