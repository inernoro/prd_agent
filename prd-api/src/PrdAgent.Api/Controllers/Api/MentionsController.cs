using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Extensions;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Services.DocumentStore;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 双链 + 反向链接 + 宇宙图查询接口。
///
/// 设计原则：mentions 是「保存正文时自动派生」的纯账本，本控制器只读，
/// 没有人工创建/删除 mention 的端点 —— 写入永远由 DocumentStoreController.UpdateEntryContent
/// 触发，保证「正文是 SSOT」。
///
/// 详见 doc/design.knowledge-base.mention-network.md。
/// </summary>
[ApiController]
[Route("api/mentions")]
[Authorize]
[AdminController("document-store", AdminPermissionCatalog.DocumentStoreRead)]
public class MentionsController : ControllerBase
{
    private readonly MongoDbContext _db;
    private readonly MentionService _mentions;

    public MentionsController(MongoDbContext db, MentionService mentions)
    {
        _db = db;
        _mentions = mentions;
    }

    private string GetUserId() => this.GetRequiredUserId();

    /// <summary>
    /// 取某个文档条目的反向链接（谁引用了我）+ 出链（我引用了谁）。
    /// 返回的卡片带源标题、源摘要、引用上下文，前端直接渲染。
    /// </summary>
    [HttpGet("documents/{entryId}/links")]
    public async Task<IActionResult> GetDocumentLinks(string entryId)
    {
        // 校验目标条目存在 + 用户对所在库可读
        var entry = await _db.DocumentEntries.Find(e => e.Id == entryId).FirstOrDefaultAsync();
        if (entry == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "文档不存在"));

        var userId = GetUserId();
        var store = await _db.DocumentStores.Find(s => s.Id == entry.StoreId).FirstOrDefaultAsync();
        if (store == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "知识库不存在"));
        if (!await CanReadAsync(store, userId))
            return Forbid();

        var backlinks = await _mentions.GetBacklinksAsync(MentionEntityType.Document, entryId);
        var forwardLinks = await _mentions.GetForwardLinksAsync(MentionEntityType.Document, entryId);

        var relatedIds = backlinks.Select(m => m.FromId)
            .Concat(forwardLinks.Select(m => m.ToId))
            .Distinct()
            .ToList();

        var relatedEntries = await _db.DocumentEntries
            .Find(e => relatedIds.Contains(e.Id))
            .ToListAsync();
        var entryMap = relatedEntries.ToDictionary(e => e.Id);

        var backlinkCards = backlinks
            .Where(m => entryMap.ContainsKey(m.FromId))
            .Select(m => new
            {
                mentionId = m.Id,
                fromEntryId = m.FromId,
                fromTitle = entryMap[m.FromId].Title,
                fromSummary = entryMap[m.FromId].Summary,
                fromUpdatedAt = entryMap[m.FromId].UpdatedAt,
                fromUpdatedByName = entryMap[m.FromId].UpdatedByName ?? entryMap[m.FromId].CreatedByName,
                anchorText = m.AnchorText,
                context = m.Context,
                isAutoDetected = m.IsAutoDetected,
                createdAt = m.CreatedAt,
            })
            .ToList();

        var forwardCards = forwardLinks
            .Where(m => entryMap.ContainsKey(m.ToId))
            .Select(m => new
            {
                mentionId = m.Id,
                toEntryId = m.ToId,
                toTitle = entryMap[m.ToId].Title,
                toSummary = entryMap[m.ToId].Summary,
                anchorText = m.AnchorText,
            })
            .ToList();

        return Ok(ApiResponse<object>.Ok(new
        {
            entryId,
            backlinks = backlinkCards,
            forwardLinks = forwardCards,
            backlinksCount = backlinkCards.Count,
            forwardLinksCount = forwardCards.Count,
        }));
    }

    /// <summary>
    /// 返回某知识库的全图数据（用于宇宙图渲染）。
    /// 返回结构：nodes（文档列表）+ edges（引用关系列表）。
    /// </summary>
    [HttpGet("stores/{storeId}/graph")]
    public async Task<IActionResult> GetStoreGraph(string storeId)
    {
        var userId = GetUserId();
        var store = await _db.DocumentStores.Find(s => s.Id == storeId).FirstOrDefaultAsync();
        if (store == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "知识库不存在"));
        if (!await CanReadAsync(store, userId))
            return Forbid();

        // 节点：库里所有非文件夹文档
        var entries = await _db.DocumentEntries
            .Find(e => e.StoreId == storeId && !e.IsFolder)
            .ToListAsync();

        var mentions = await _mentions.GetStoreGraphAsync(storeId);

        var nodes = entries.Select(e => new
        {
            id = e.Id,
            title = e.Title,
            summary = e.Summary,
            tags = e.Tags,
            category = e.Category,
            updatedAt = e.UpdatedAt,
            createdAt = e.CreatedAt,
        });

        var edges = mentions.Select(m => new
        {
            id = m.Id,
            from = m.FromId,
            to = m.ToId,
            anchorText = m.AnchorText,
            isAutoDetected = m.IsAutoDetected,
        });

        return Ok(ApiResponse<object>.Ok(new
        {
            storeId,
            storeName = store.Name,
            nodes,
            edges,
            stats = new
            {
                nodeCount = entries.Count,
                edgeCount = mentions.Count,
            },
        }));
    }

    /// <summary>
    /// 编辑器自动补全：在某知识库内按标题模糊匹配，返回 wiki 链接候选。
    /// 前端打 [[xxx 触发，返回最多 10 个候选。
    /// </summary>
    [HttpGet("stores/{storeId}/suggest")]
    public async Task<IActionResult> SuggestLinks(string storeId, [FromQuery] string? q, [FromQuery] int limit = 10)
    {
        var userId = GetUserId();
        var store = await _db.DocumentStores.Find(s => s.Id == storeId).FirstOrDefaultAsync();
        if (store == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "知识库不存在"));
        if (!await CanReadAsync(store, userId))
            return Forbid();

        limit = Math.Clamp(limit, 1, 30);
        var keyword = (q ?? string.Empty).Trim();

        var query = _db.DocumentEntries.Find(e => e.StoreId == storeId && !e.IsFolder);
        var all = await query.ToListAsync();

        // 内存里做包含匹配（10000 内的库轻松）。命中的优先；其余按更新时间倒序。
        IEnumerable<DocumentEntry> ranked;
        if (string.IsNullOrEmpty(keyword))
        {
            ranked = all.OrderByDescending(e => e.UpdatedAt);
        }
        else
        {
            ranked = all
                .Where(e => e.Title?.IndexOf(keyword, StringComparison.OrdinalIgnoreCase) >= 0)
                .OrderByDescending(e => e.Title?.StartsWith(keyword, StringComparison.OrdinalIgnoreCase) ?? false)
                .ThenByDescending(e => e.UpdatedAt);
        }

        var items = ranked.Take(limit).Select(e => new
        {
            entryId = e.Id,
            title = e.Title,
            summary = e.Summary,
            updatedAt = e.UpdatedAt,
        }).ToList();

        return Ok(ApiResponse<object>.Ok(new { items, total = items.Count }));
    }

    // ── 权限辅助 ──

    private async Task<bool> CanReadAsync(DocumentStore store, string userId)
    {
        if (store.OwnerId == userId) return true;
        if (store.IsPublic) return true;
        // SharedTeamIds 判定：简化版（足以覆盖 MVP）；完整版走 DocumentStoreController 的辅助
        if (store.SharedTeamIds.Count > 0)
        {
            var myTeams = await _db.TeamMembers
                .Find(m => m.UserId == userId)
                .Project(m => m.TeamId)
                .ToListAsync();
            if (store.SharedTeamIds.Any(myTeams.Contains)) return true;
        }
        return false;
    }
}
