using System.Text;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using DocStoreServices = PrdAgent.Infrastructure.Services.DocumentStore;

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
    private readonly DocStoreServices.DocumentVersionService _versions;
    private readonly ILogger<ContentReprocessApplyService> _logger;

    public ContentReprocessApplyService(
        IDocumentService documentService,
        DocStoreServices.DocumentVersionService versions,
        ILogger<ContentReprocessApplyService> logger)
    {
        _documentService = documentService;
        _versions = versions;
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
        MongoDbContext db,
        string? targetParentId = null)
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
            "new" => await CreateNewAsync(sourceEntry, content, title, actorId, db, targetParentId),
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
        // 严格模式：entry 有 DocumentId 时必须能读到完整 RawContent；
        // 否则用 ContentIndex 当作"既有正文"再 append 会把完整文档替换成"2000 字前缀 + AI 输出"
        // 把整个文档截了（Bugbot 十五轮 High）。无 DocumentId 的 entry 本来就是短文，
        // ContentIndex 等于完整正文，那种情况允许 fallback。
        string existing;
        if (!string.IsNullOrEmpty(entry.DocumentId))
        {
            var doc = await _documentService.GetByIdAsync(entry.DocumentId);
            if (doc == null || string.IsNullOrEmpty(doc.RawContent))
            {
                throw new InvalidOperationException(
                    "无法读取文档完整正文以执行追加。请稍后再试，或用「另存为新文档」生成新条目，避免把原文截断到 2000 字预览。");
            }
            existing = doc.RawContent;
        }
        else
        {
            existing = entry.ContentIndex ?? string.Empty;
        }
        var merged = string.IsNullOrEmpty(existing)
            ? content
            : existing.TrimEnd() + "\n\n" + content;
        await SaveContentToEntryAsync(entry, merged, actorId, db);
        return new ApplyResult("append", null, entry.Id, FinalBody: merged);
    }

    private async Task<ApplyResult> CreateNewAsync(
        DocumentEntry sourceEntry, string content, string? title, string userId, MongoDbContext db,
        string? targetParentId = null)
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
            // Phase 2：另存为新文档可落到用户指定目录；未指定时沿用源文档所在目录
            ParentId = string.IsNullOrEmpty(targetParentId) ? sourceEntry.ParentId : targetParentId,
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
        var parsed = await _documentService.ParseAsync(content); // parsed.Id = 内容 hash
        string? oldContent;
        if (!string.IsNullOrEmpty(entry.DocumentId))
        {
            var existing = await _documentService.GetByIdAsync(entry.DocumentId);
            // 不回退截断的 ContentIndex（2000 字上限），长文档基线会被截断无法完整恢复（Bugbot）
            oldContent = existing?.RawContent;
            parsed.Title = existing?.Title ?? entry.Title;
            // 内容寻址 + 共享保护：旧 ParsedPrd 被别的 entry 共享（相同内容上传等）时不得就地覆盖，
            // 否则会改到别的 entry 正文；改为按新内容 hash 落库 + 只重指向本 entry（Codex P1）。
            if (parsed.Id != entry.DocumentId)
            {
                var sharedByOthers = await db.DocumentEntries.CountDocumentsAsync(
                    e => e.DocumentId == entry.DocumentId && e.Id != entry.Id) > 0;
                if (!sharedByOthers)
                    parsed.Id = entry.DocumentId; // 独占 → 复用旧 id 就地更新，不产生孤儿
            }
        }
        else
        {
            // 无 DocumentId 的短文档，ContentIndex 即完整正文（见 AppendAsync 约定），
            // 也要快照成改动前基线，否则这类条目 AI 改写后无法从历史撤销（Bugbot）。
            oldContent = entry.ContentIndex;
            parsed.Title = entry.Title;
        }
        await _documentService.SaveAsync(parsed);

        // 版本快照：AI 再加工（replace/append）也走版本控制，否则历史里缺这次写入、
        // 用户无法用「历史版本」撤销 AI 改写（Codex P2）。先存改动前基线，再存新内容（去重）。
        if (oldContent != null)
            await _versions.SnapshotAsync(entry.Id, entry.StoreId, oldContent, DocumentVersionSource.Edit, actorId, null);
        await _versions.SnapshotAsync(entry.Id, entry.StoreId, content, DocumentVersionSource.Edit, actorId, null);

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
