using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Core.Models;

namespace PrdAgent.Api.Controllers.Api;

public partial class DocumentStoreController
{
    [HttpGet("entries/{entryId}/writing/export")]
    public async Task<IActionResult> ExportWritingHtml(string entryId, [FromQuery] int version)
    {
        var (entry, _, error) = await LoadReadableEntryAsync(entryId, GetUserId());
        if (error != null) return error;
        var publication = entry!.Writing?.Published;
        if (publication == null || version < 1 || version > publication.Version)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "该发布版本不存在"));
        if (publication.Version != version) publication = (await _db.Database.GetCollection<WritingPublicationRecord>("document_writing_publications")
            .Find(r => r.EntryId == entryId && r.StoreId == entry.StoreId && r.Publication.Version == version).FirstOrDefaultAsync())?.Publication;
        if (publication == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "该发布版本不存在"));
        var safeTitle = string.Concat(publication.Title.Take(80).Select(c => char.IsControl(c) || "\\/:*?\"<>|".Contains(c) ? '_' : c)).Trim(' ', '.');
        if (string.IsNullOrWhiteSpace(safeTitle)) safeTitle = "文档";
        return Ok(ApiResponse<object>.Ok(new { html = WritingHtmlExport.Render(publication), version = publication.Version,
            contentFingerprint = publication.ContentFingerprint, fileName = $"{safeTitle}-v{publication.Version}.html" }));
    }
}
