using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Services.ProductAgent;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Services;

namespace PrdAgent.Api.Controllers.Api;

public partial class ProductAgentController
{
    [HttpPost("version-workflow/void")]
    public async Task<IActionResult> VoidVersion([FromBody] ProductVersionVoidOperationRequest request)
    {
        var reason = ProductVersionClaimGuard.NormalizeRemovalReason(request.Reason);
        if (reason == null || request.Kind is not ("T" or "V") || string.IsNullOrWhiteSpace(request.Id))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "请选择T或V记录，并填写至少6个字符的作废理由。"));
        var userId = GetUserId();
        var manager = await CanManageAsync(userId);
        var id = request.Id.Trim();
        string collection, applicationId, owner;
        if (id.StartsWith("legacy:", StringComparison.Ordinal))
        {
            id = id["legacy:".Length..];
            var kind = request.Kind == "T" ? VersionRegistrationKind.Internal : VersionRegistrationKind.Formal;
            var old = await _db.VersionRegistrations.Find(x => x.Id == id && x.Kind == kind).FirstOrDefaultAsync();
            if (old == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "历史版本记录不存在"));
            owner = old.CreatedBy;
            var name = VersionRegistryCatalog.NormalizeName(old.ApplicationName);
            var products = await _db.Products.Find(x => !x.IsDeleted).Project(x => new { x.Id, x.Name }).ToListAsync();
            var matches = products.Where(x => VersionRegistryCatalog.NormalizeName(x.Name) == name).Take(2).ToList();
            applicationId = matches.Count == 1 ? matches[0].Id : "legacy-app:" + name;
            collection = "version_registrations";
        }
        else if (request.Kind == "T")
        {
            var item = await _db.ProductInitiations.Find(x => x.Id == id && !x.IsDeleted).FirstOrDefaultAsync();
            if (item == null || await FindAccessibleProductAsync(item.ProductId, userId) == null)
                return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "内部版本不存在或无权访问"));
            owner = item.CreatedBy;
            applicationId = string.IsNullOrWhiteSpace(item.LinkedProductId) ? item.ProductId : item.LinkedProductId;
            collection = "product_initiations";
        }
        else
        {
            var item = await _db.ProductReleases.Find(x => x.Id == id && !x.IsDeleted).FirstOrDefaultAsync();
            if (item == null || await FindAccessibleProductAsync(item.ProductId, userId) == null)
                return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "正式版本不存在或无权访问"));
            owner = item.CreatedBy;
            var source = string.IsNullOrWhiteSpace(item.InitiationId) ? null
                : await _db.ProductInitiations.Find(x => x.Id == item.InitiationId).FirstOrDefaultAsync();
            applicationId = source == null ? item.ProductId : string.IsNullOrWhiteSpace(source.LinkedProductId) ? source.ProductId : source.LinkedProductId;
            collection = "product_releases";
        }
        if (owner != userId && !manager)
            return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "仅申请人或产品管理人员可作废该记录。"));
        if (!await ProductVersionVoiding.ApplyAsync(_db, collection, id, applicationId, owner, userId, reason))
            return Conflict(ApiResponse<object>.Fail("INVALID_STATE", "记录已作废、已变化或通知正在发送，请刷新后核对。"));
        return Ok(ApiResponse<object>.Ok(new { voided = true }));
    }
}

public sealed class ProductVersionVoidOperationRequest : ProductVersionVoidRequest
{
    public string Id { get; set; } = string.Empty;
    public string Kind { get; set; } = string.Empty;
}
