using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Services.ProductAgent;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Services;

namespace PrdAgent.Api.Controllers.Api;

public partial class ProductAgentController
{
    [HttpPatch("releases/{id}")]
    public async Task<IActionResult> UpdateRelease(string id, [FromBody] UpdateProductReleaseRequest request)
    {
        var userId = GetUserId();
        var item = await _db.ProductReleases.Find(x => x.Id == id && !x.IsDeleted).FirstOrDefaultAsync();
        if (item == null || await FindAccessibleProductAsync(item.ProductId, userId) == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "正式版本不存在或无权访问。"));
        if (item.CreatedBy != userId && !await CanManageAsync(userId))
            return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "仅申请人或产品管理人员可编辑该正式版本。"));
        var source = string.IsNullOrWhiteSpace(item.InitiationId) ? null
            : await _db.ProductInitiations.Find(x => x.Id == item.InitiationId).FirstOrDefaultAsync();
        var applicationId = source == null ? item.ProductId : ProductVersionApplicationLatest.Application(source);
        await using var lease = await ProductVersionApplicationLease.AcquireAsync(_db, new[] { applicationId });
        item = await _db.ProductReleases.Find(x => x.Id == id && !x.IsDeleted).FirstOrDefaultAsync();
        if (item == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "正式版本已删除，请刷新列表。"));
        if (item.Status == "voided" || item.ClaimNotification?.Status == "sending")
            return Conflict(ApiResponse<object>.Fail("INVALID_STATE", "记录已作废或通知正在发送，请刷新后核对。"));
        if (!request.ExpectedUpdatedAt.HasValue || request.ExpectedUpdatedAt.Value != item.UpdatedAt)
            return Conflict(ApiResponse<object>.Fail("INVALID_STATE", "记录已更新，请刷新后重新编辑；本次未覆盖其他修改。"));
        if (request.PlanName != null && string.IsNullOrWhiteSpace(request.PlanName))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "方案名称不能为空。"));
        if (request.PlannedTrainingMinutes < 0)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "预计培训时长须为非负整数分钟。"));
        if (request.ReleasedAt.HasValue && item.Status != "released")
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "未上线记录不能填写实际上线日期。"));
        var ownerId = request.OwnerId?.Trim();
        if (request.OwnerId != null && (string.IsNullOrEmpty(ownerId) || !await _db.Users.Find(x => x.UserId == ownerId).AnyAsync()))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "请选择有效的产品负责人。"));
        var memberIds = request.TeamMemberIds?.Where(x => !string.IsNullOrWhiteSpace(x)).Select(x => x.Trim()).Distinct().ToList();
        var memberNames = item.ProjectMemberNames;
        if (memberIds != null)
        {
            var users = await _db.Users.Find(x => memberIds.Contains(x.UserId)).ToListAsync();
            if (memberIds.Count == 0 || users.Count != memberIds.Count)
                return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "请选择有效的项目组成员。"));
            memberNames = memberIds.Select(memberId => users.First(x => x.UserId == memberId))
                .Select(x => string.IsNullOrWhiteSpace(x.DisplayName) ? x.Username : x.DisplayName).ToList();
        }
        if (request.IsGlobalOpen == true && item.IsGlobalOpen != true && item.ProjectType != "custom"
            && ProductReleaseTrainingPolicy.IsRequired(item.AppName ?? string.Empty)
            && !(request.PlannedTrainingMinutes ?? item.PlannedTrainingMinutes).HasValue)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "全域开放请填写预计培训时长。"));

        // 只更新资料白名单；编号、应用、来源T、状态和通知队列均不参与更新。
        var updates = new List<UpdateDefinition<ProductRelease>> { Builders<ProductRelease>.Update.Set(x => x.UpdatedAt, DateTime.UtcNow) };
        var update = Builders<ProductRelease>.Update;
        if (request.PlanName != null) updates.Add(update.Set(x => x.PlanName, request.PlanName.Trim()));
        if (request.DemandSource != null) updates.Add(update.Set(x => x.DemandSource, request.DemandSource.Trim()));
        if (request.DepartmentName != null) updates.Add(update.Set(x => x.DepartmentName, request.DepartmentName.Trim()));
        if (request.PlanUrl != null) updates.Add(update.Set(x => x.PlanUrl, request.PlanUrl.Trim()));
        if (request.RequirementDescription != null) updates.Add(update.Set(x => x.RequirementDescription, request.RequirementDescription.Trim()));
        if (request.ContractParty != null) updates.Add(update.Set(x => x.ContractParty, request.ContractParty.Trim()));
        if (request.Remark != null) updates.Add(update.Set(x => x.Remark, request.Remark.Trim()));
        if (request.OpenBrandScope != null) updates.Add(update.Set(x => x.OpenBrandScope, request.OpenBrandScope.Trim()));
        if (request.IsGlobalOpen.HasValue) updates.Add(update.Set(x => x.IsGlobalOpen, request.IsGlobalOpen));
        if (request.PlannedReleaseAt.HasValue) updates.Add(update.Set(x => x.PlannedReleaseAt, request.PlannedReleaseAt));
        if (request.ReleasedAt.HasValue) updates.Add(update.Set(x => x.ReleasedAt, request.ReleasedAt));
        if (request.PlannedTrainingMinutes.HasValue) updates.Add(update.Set(x => x.PlannedTrainingMinutes, request.PlannedTrainingMinutes));
        if (ownerId != null)
        {
            updates.Add(update.Set(x => x.OwnerId, ownerId));
            updates.Add(update.Set(x => x.OwnerName, await ResolveInitiationApplicantNameAsync(ownerId) ?? ownerId));
        }
        if (memberIds != null)
        {
            updates.Add(update.Set(x => x.TeamMemberIds, memberIds));
            updates.Add(update.Set(x => x.ProjectMemberNames, memberNames));
        }
        await lease.EnsureHeldAsync();
        var saved = await _db.ProductReleases.UpdateOneAsync(x => x.Id == id && !x.IsDeleted
            && x.UpdatedAt == item.UpdatedAt && x.Status == item.Status
            && (x.ClaimNotification == null || x.ClaimNotification.Status != "sending"),
            update.Combine(updates), cancellationToken: CancellationToken.None);
        if (saved.MatchedCount == 0)
            return Conflict(ApiResponse<object>.Fail("INVALID_STATE", "记录已变化，本次未覆盖其他修改，请刷新后重试。"));
        var result = await _db.ProductReleases.Find(x => x.Id == id && !x.IsDeleted).FirstOrDefaultAsync();
        if (result == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "正式版本已删除，请刷新列表。"));
        await ProductReleaseDeletion.AnnotateAsync(_db, new[] { result }, userId);
        return Ok(ApiResponse<object>.Ok(result));
    }
}

public sealed class UpdateProductReleaseRequest
{
    public DateTime? ExpectedUpdatedAt { get; set; }
    public string? PlanName { get; set; }
    public string? OwnerId { get; set; }
    public List<string>? TeamMemberIds { get; set; }
    public string? DemandSource { get; set; }
    public string? DepartmentName { get; set; }
    public string? PlanUrl { get; set; }
    public string? RequirementDescription { get; set; }
    public string? ContractParty { get; set; }
    public string? Remark { get; set; }
    public string? OpenBrandScope { get; set; }
    public bool? IsGlobalOpen { get; set; }
    public DateTime? PlannedReleaseAt { get; set; }
    public DateTime? ReleasedAt { get; set; }
    public int? PlannedTrainingMinutes { get; set; }
}
