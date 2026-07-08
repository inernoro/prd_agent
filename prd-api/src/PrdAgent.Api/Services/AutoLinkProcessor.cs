using System.Text.Json;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Services.DocumentStore;

namespace PrdAgent.Api.Services;

/// <summary>
/// 知识库自动补链处理器 —— 扫描库内全部文本文档，凡正文出现「其他文档的标题」
/// （精确匹配），把第一处合法出现改写为 [[标题]]（Obsidian 风格双链）并写回正文。
///
/// 纯字符串处理，无 LLM 调用。写回走 EntryContentWriteService（与在线编辑同一条
/// 核心路径：ParsedPrd 内容寻址 + 摘要索引 + 重锚评论 + 重算双链 + 版本快照），
/// 保证可回滚、图谱即时可见。幂等：已是 [[标题]] 的不再包，二次运行零写入。
///
/// 跳过（只作为链接目标，不改写自身）：
/// - 附件型条目（AttachmentId 有值且无 DocumentId）：ExtractedText 是派生物不可回写
/// - html 条目：[[..]] 在 html 渲染路径不生效
/// - ParsedPrd 行丢失的条目：不能拿 2000 字截断的 ContentIndex 回写整篇
/// </summary>
public class AutoLinkProcessor
{
    private readonly IDocumentService _documentService;
    private readonly EntryContentWriteService _entryContentWriter;
    private readonly ILogger<AutoLinkProcessor> _logger;

    public AutoLinkProcessor(
        IDocumentService documentService,
        EntryContentWriteService entryContentWriter,
        ILogger<AutoLinkProcessor> logger)
    {
        _documentService = documentService;
        _entryContentWriter = entryContentWriter;
        _logger = logger;
    }

    public async Task ProcessAsync(DocumentStoreAgentRun run, MongoDbContext db, IRunEventStore runStore)
    {
        var store = await db.DocumentStores.Find(s => s.Id == run.StoreId).FirstOrDefaultAsync();
        if (store == null)
            throw new InvalidOperationException("文档空间不存在");

        // 操作者显示名（写进版本历史 / UpdatedByName）
        var user = await db.Users.Find(u => u.UserId == run.UserId).FirstOrDefaultAsync();
        var userName = user != null && !string.IsNullOrWhiteSpace(user.DisplayName)
            ? user.DisplayName
            : (user?.Username ?? "自动补链");

        var entries = await db.DocumentEntries
            .Find(e => e.StoreId == run.StoreId && !e.IsFolder)
            .ToListAsync();

        // 候选标题 = 库内全部非文件夹条目的标题（可作为链接目标，即便自身不可改写）
        var allTitles = entries.Select(e => e.Title).ToList();
        // 标题 → entryId（撞名取最早创建，与 MentionService.ResyncDocumentMentionsAsync 同口径），
        // 用于把改写命中的标题映射成图谱边的目标节点，供前端「经脉长出」动画增量绘制
        var titleToId = BuildTitleToIdMap(entries.Select(e => (e.Id, e.Title, e.CreatedAt)));

        var total = entries.Count;
        int processed = 0, changed = 0, linksAdded = 0, skipped = 0;

        await UpdateProgressAsync(db, runStore, run, 0, $"准备扫描 {total} 篇文档",
            processed, total, changed, linksAdded);

        foreach (var entry in entries)
        {
            processed++;
            List<object>? newLinks = null;
            try
            {
                var content = await LoadWritableContentAsync(entry);
                if (content != null)
                {
                    var candidates = allTitles.Where(t => t != entry.Title).ToList();
                    var result = WikiLinkAutoLinker.LinkTitles(content, candidates);
                    if (result.LinksAdded > 0)
                    {
                        await _entryContentWriter.WriteAsync(
                            entry, store, result.Content, run.UserId, userName, DocumentVersionSource.Edit);
                        changed++;
                        linksAdded += result.LinksAdded;
                        // 本篇新增链接明细（from=当前条目 → to=标题命中的目标条目），随 progress 事件推给前端做边生长动画
                        newLinks = result.LinkedTitles
                            .Select(t => titleToId.TryGetValue(t, out var toId) && toId != entry.Id
                                ? new { from = entry.Id, to = toId, anchorText = t }
                                : null)
                            .Where(l => l != null)
                            .Cast<object>()
                            .ToList();
                    }
                }
                else
                {
                    skipped++;
                }
            }
            catch (Exception ex)
            {
                // 单篇失败不中断整库任务：记日志、计入 skipped，继续下一篇
                skipped++;
                _logger.LogWarning(ex, "[auto-link] 处理条目失败 entry={EntryId} store={StoreId}", entry.Id, run.StoreId);
            }

            var progress = total == 0 ? 100 : Math.Min(99, (int)Math.Round(processed * 100.0 / total));
            await UpdateProgressAsync(db, runStore, run, progress,
                $"扫描中 {processed}/{total}", processed, total, changed, linksAdded, newLinks);
        }

        // 汇总写入 GeneratedText：Worker 通用 done 事件自带该字段，前端解析展示
        var summary = JsonSerializer.Serialize(new { scanned = total, changed, linksAdded, skipped });
        await db.DocumentStoreAgentRuns.UpdateOneAsync(
            r => r.Id == run.Id,
            Builders<DocumentStoreAgentRun>.Update
                .Set(r => r.GeneratedText, summary)
                .Set(r => r.Phase, "完成"),
            cancellationToken: CancellationToken.None);

        _logger.LogInformation(
            "[auto-link] store={StoreId} scanned={Total} changed={Changed} linksAdded={LinksAdded} skipped={Skipped}",
            run.StoreId, total, changed, linksAdded, skipped);
    }

    /// <summary>
    /// 读取条目的可回写正文；不可回写（附件型 / html / ParsedPrd 丢失 / 空文）返回 null。
    /// </summary>
    private async Task<string?> LoadWritableContentAsync(DocumentEntry entry)
    {
        var contentType = (entry.ContentType ?? string.Empty).ToLowerInvariant();
        if (contentType.Contains("html")) return null;

        if (!string.IsNullOrEmpty(entry.DocumentId))
        {
            var doc = await _documentService.GetByIdAsync(entry.DocumentId);
            var raw = doc?.RawContent;
            return string.IsNullOrWhiteSpace(raw) ? null : raw;
        }

        // 附件型（无 DocumentId）：ExtractedText 是解析派生物，不可回写
        if (!string.IsNullOrEmpty(entry.AttachmentId)) return null;

        // 无 DocumentId 的短文：ContentIndex 即完整正文；长度达到截断上限说明可能被截断，不敢回写
        var idx = entry.ContentIndex;
        if (string.IsNullOrWhiteSpace(idx) || idx.Length >= 2000) return null;
        return idx;
    }

    /// <summary>
    /// 标题 → entryId 映射。同库标题撞名取最早创建（CreatedAt 最小，再按 Id 稳定破平），
    /// 与 MentionService.ResyncDocumentMentionsAsync 的账本落点保持同口径。
    /// </summary>
    internal static Dictionary<string, string> BuildTitleToIdMap(
        IEnumerable<(string Id, string Title, DateTime CreatedAt)> entries)
    {
        return entries
            .GroupBy(e => e.Title, StringComparer.Ordinal)
            .ToDictionary(
                g => g.Key,
                g => g.OrderBy(e => e.CreatedAt).ThenBy(e => e.Id, StringComparer.Ordinal).First().Id,
                StringComparer.Ordinal);
    }

    private static async Task UpdateProgressAsync(
        MongoDbContext db, IRunEventStore runStore, DocumentStoreAgentRun run,
        int progress, string phase, int processed, int total, int changed, int linksAdded,
        IReadOnlyList<object>? newLinks = null)
    {
        await db.DocumentStoreAgentRuns.UpdateOneAsync(
            r => r.Id == run.Id,
            Builders<DocumentStoreAgentRun>.Update
                .Set(r => r.Progress, progress)
                .Set(r => r.Phase, phase),
            cancellationToken: CancellationToken.None);
        try
        {
            await runStore.AppendEventAsync(
                DocumentStoreRunKinds.AutoLink, run.Id, "progress",
                new { progress, phase, processed, total, changed, linksAdded, newLinks },
                ct: CancellationToken.None);
        }
        catch { /* 事件失败不阻塞主流程 */ }
    }
}
