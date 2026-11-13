using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Services.DocumentStore;

namespace PrdAgent.Api.Controllers.Api;

public partial class DocumentStoreController
{
    private async Task<IActionResult> TrashActionAsync(Func<DocumentTrashService, Task> action)
    {
        try
        {
            await action(new DocumentTrashService(_db));
            return Ok(ApiResponse<object>.Ok(new { success = true }));
        }
        catch (DocumentTrashService.ConflictException ex)
        {
            return Conflict(ApiResponse<object>.Fail("DOCUMENT_TRASH_CONFLICT", ex.Message));
        }
    }

    private Task<IActionResult> MoveStoreToTrashAsync(DocumentStore store, string userId) =>
        TrashActionAsync(service => service.DeleteAsync(store.Id, null, userId));
    private async Task<IActionResult> MoveEntryToTrashAsync(DocumentEntry entry, DocumentStore store, string userId)
    {
        var result = await TrashActionAsync(service => service.DeleteAsync(store.Id, entry.Id, userId));
        if (result is OkObjectResult && entry.Trash == null)
            await LogStoreActivityAsync(store, userId, TeamActivityAction.EntryDeleted, "entry", entry.Id, entry.Title);
        return result;
    }

    /// <summary>仅返回当前仍可写的库的回收根对象；公开读者和已退出团队的成员不可见。</summary>
    [HttpGet("stores/trash")]
    public async Task<IActionResult> ListTrash([FromQuery] string? storeId = null)
    {
        var userId = GetUserId();
        var teamIds = await _teams.GetMyTeamIdsAsync(userId);
        var candidates = await _db.DocumentStoresIncludingTrash.Find(x => storeId == null || x.Id == storeId).ToListAsync();
        var result = new List<object>();
        foreach (var store in candidates)
        {
            if (store.Trash != null)
            {
                if (store.OwnerId == userId) result.Add(TrashItem("store", store.Id, store.Name, store, store.Trash));
                continue;
            }
            if (!await CanWriteStoreAsync(store, userId, teamIds)) continue;
            var entries = await _db.DocumentEntriesIncludingTrash.Find(x => x.StoreId == store.Id && x.Trash != null && x.Trash.RootEntryId == x.Id).ToListAsync();
            result.AddRange(entries.Select(entry => TrashItem("entry", entry.Id, entry.Title, store, entry.Trash!)));
        }
        return Ok(ApiResponse<object>.Ok(new { items = result, retentionDays = DocumentTrashState.RetentionDays }));
    }

    private static object TrashItem(string kind, string id, string title, DocumentStore store, DocumentTrashState state) => new
    {
        kind, id, title, storeId = store.Id, storeName = store.Name,
        state.DeletedAt, state.DeletedBy, expiresAt = state.DeletedAt.AddDays(DocumentTrashState.RetentionDays),
        canRestore = state.CanRestore(DateTime.UtcNow), pending = state.Pending,
    };

    [HttpPost("stores/{storeId}/restore")]
    public async Task<IActionResult> RestoreStore(string storeId)
    {
        var store = await _db.DocumentStoresIncludingTrash.Find(x => x.Id == storeId).FirstOrDefaultAsync();
        if (store == null || store.OwnerId != GetUserId())
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "知识库不存在"));
        return await TrashActionAsync(service => service.RestoreAsync(storeId, null));
    }

    [HttpPost("entries/{entryId}/restore")]
    public async Task<IActionResult> RestoreEntry(string entryId)
    {
        var entry = await _db.DocumentEntriesIncludingTrash.Find(x => x.Id == entryId).FirstOrDefaultAsync();
        if (entry == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "条目不存在"));
        var (store, error) = await LoadWritableStoreAsync(entry.StoreId, GetUserId());
        if (error != null) return error;
        var result = await TrashActionAsync(service => service.RestoreAsync(store!.Id, entryId));
        if (result is OkObjectResult && entry.Trash != null)
            await LogStoreActivityAsync(store!, GetUserId(), TeamActivityAction.EntryUpdated, "entry", entry.Id, $"恢复：{entry.Title}");
        return result;
    }
}
