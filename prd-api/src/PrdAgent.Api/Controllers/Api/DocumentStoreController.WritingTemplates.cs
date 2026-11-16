using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Core.Models;

namespace PrdAgent.Api.Controllers.Api;

public partial class DocumentStoreController
{
    private IMongoCollection<WritingTemplateDocument> OrganizationWritingTemplates => _db.Database.GetCollection<WritingTemplateDocument>("document_writing_templates");

    // 读者只需要展示身份；完整写作提示保留在有写权限的作者上下文和权威快照中。
    private static WritingTemplate? WritingTemplateDisplay(WritingTemplate? template) => template == null ? null
        : new WritingTemplate(template.Id, template.Name, template.Type, template.Role, "", Array.Empty<WritingHeading>(), template.Version);

    private static WritingPublication WritingPublicationForReader(WritingPublication publication)
    {
        var view = WritingTeachingPolicy.Freeze(publication);
        view.TemplateSnapshot = null;
        return view;
    }

    private async Task<IReadOnlyList<WritingTemplate>> WritingTemplatesAsync(string storeId)
    {
        var custom = await OrganizationWritingTemplates.Find(t => t.StoreId == storeId).SortBy(t => t.CreatedAt).ToListAsync();
        return WritingTemplateRegistry.All.Concat(custom.Select(t => t.Template)).ToList();
    }

    private async Task<WritingTemplate?> FindWritingTemplateAsync(string storeId, string id)
    {
        var builtIn = WritingTemplateRegistry.Find(id);
        return builtIn ?? (await OrganizationWritingTemplates.Find(t => t.StoreId == storeId && t.Template.Id == id).FirstOrDefaultAsync())?.Template;
    }

    [HttpPost("stores/{storeId}/writing-templates/import")]
    public async Task<IActionResult> ImportWritingTemplate(string storeId, [FromBody] WritingTemplateImportRequest request)
    {
        var (_, error) = await LoadWritableStoreAsync(storeId, GetUserId());
        if (error != null) return error;
        if (await OrganizationWritingTemplates.CountDocumentsAsync(t => t.StoreId == storeId) >= 100)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "当前知识库最多保留100个模版版本"));
        try {
            var record = new WritingTemplateDocument { StoreId = storeId, CreatedBy = GetUserId() };
            record.Template = WritingDeliveryPolicy.ImportTemplate("org-" + record.Id, request.Name ?? "", request.Markdown ?? "");
            await OrganizationWritingTemplates.InsertOneAsync(record);
            return Ok(ApiResponse<object>.Ok(new { template = record.Template }));
        }
        catch (InvalidOperationException ex) { return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, ex.Message)); }
    }
}

public class WritingTemplateImportRequest
{
    public string Name { get; set; } = "";
    public string Markdown { get; set; } = "";
}
