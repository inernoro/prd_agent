using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Extensions;
using PrdAgent.Api.Middleware;
using PrdAgent.Api.Services.ProductAgent;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Security;

namespace PrdAgent.Api.Controllers.Api;

[ApiController, Authorize, Route("api/product/claim-webhook")]
[AdminController("product-agent", AdminPermissionCatalog.ProductAgentUse)]
public class ProductClaimWebhookController(MongoDbContext db, IDataProtectionProvider protection, IConfiguration configuration) : ControllerBase
{
    public const string ProtectionPurpose = "ProductAgent.ClaimWebhook.v1";

    private async Task<bool> IsMapAdminAsync() => ProductPermissionRules.IsMapAdministrator(
        await db.Users.Find(x => x.UserId == this.GetRequiredUserId()).FirstOrDefaultAsync() ?? new User());

    [HttpGet]
    public async Task<IActionResult> Get()
    {
        if (!await IsMapAdminAsync()) return StatusCode(403);
        var settings = await db.ProductAgentSettings.Find(x => x.Id == ProductAgentSettings.SingletonId).FirstOrDefaultAsync();
        var config = settings?.ClaimWebhook ?? new();
        var users = await db.Users.Find(x => x.Status == UserStatus.Active && x.UserType == UserType.Human).ToListAsync();
        var ready = users.Count(user => ProductClaimMentionIdentity.Resolve(user, protection) != null);
        return Ok(ApiResponse<object>.Ok(new {
            config.Enabled, config.NotifyInternal, config.NotifyFormal,
            configured = !string.IsNullOrEmpty(config.ProtectedUrl),
            maskedUrl = string.IsNullOrEmpty(config.ProtectedUrl) ? null : "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=********",
            identityReadyCount = ready, identityPendingCount = users.Count - ready,
            canSend = DeploymentAuthority.CanRunSharedScheduledWork(configuration) && !DeploymentAuthority.IsCdsBranchPreview(configuration),
        }));
    }

    [HttpPut]
    public async Task<IActionResult> Save([FromBody] SaveProductClaimWebhook request)
    {
        if (!await IsMapAdminAsync()) return StatusCode(403);
        // 共库预览不能用异钥覆写正式密文，也不能让预览配置意外启用真实群通知。
        if (DeploymentAuthority.IsCdsBranchPreview(configuration))
            return BadRequest(ApiResponse<object>.Fail("PREVIEW_READ_ONLY", "请在正式环境保存Webhook配置，预览不会发送群通知"));
        var existing = await db.ProductAgentSettings.Find(x => x.Id == ProductAgentSettings.SingletonId).FirstOrDefaultAsync();
        var protectedUrl = existing?.ClaimWebhook?.ProtectedUrl;
        if (!string.IsNullOrWhiteSpace(request.Url))
        {
            if (!ProductClaimWebhookPayload.IsValidWebhook(request.Url.Trim()))
                return BadRequest(ApiResponse<object>.Fail("INVALID_FORMAT", "请填写有效的企微群机器人HTTPS Webhook地址"));
            protectedUrl = protection.CreateProtector(ProtectionPurpose).Protect(request.Url.Trim());
        }
        if (request.Enabled && string.IsNullOrEmpty(protectedUrl))
            return BadRequest(ApiResponse<object>.Fail("INVALID_FORMAT", "启用通知前请填写Webhook地址"));
        var config = new ProductClaimWebhookConfig {
            Enabled = request.Enabled, NotifyInternal = request.NotifyInternal, NotifyFormal = request.NotifyFormal,
            ProtectedUrl = protectedUrl, InitializedAt = existing?.ClaimWebhook?.InitializedAt ?? DateTime.UtcNow,
        };
        await db.ProductAgentSettings.UpdateOneAsync(x => x.Id == ProductAgentSettings.SingletonId,
            Builders<ProductAgentSettings>.Update.Set(x => x.ClaimWebhook, config)
                .Set(x => x.UpdatedBy, this.GetRequiredUserId()).Set(x => x.UpdatedAt, DateTime.UtcNow),
            new UpdateOptions { IsUpsert = true }, CancellationToken.None);
        return Ok(ApiResponse<object>.Ok(new { saved = true }));
    }

    [HttpGet("notifications")]
    public async Task<IActionResult> Notifications()
    {
        if (!await IsMapAdminAsync()) return StatusCode(403);
        var t = await db.ProductInitiations.Find(x => x.ClaimNotification != null && !x.IsDeleted)
            .SortByDescending(x => x.CreatedAt).Limit(20).ToListAsync();
        var v = await db.ProductReleases.Find(x => x.ClaimNotification != null && !x.IsDeleted)
            .SortByDescending(x => x.CreatedAt).Limit(20).ToListAsync();
        var rows = t.Select(x => new ClaimNoticeRow("T", x.Id, x.TCode ?? "", x.OwnerName, x.CreatedAt, x.ClaimNotification!))
            .Concat(v.Select(x => new ClaimNoticeRow("V", x.Id, x.VCode, x.OwnerName, x.CreatedAt, x.ClaimNotification!)))
            .OrderByDescending(x => x.CreatedAt).Take(20);
        return Ok(ApiResponse<object>.Ok(new { items = rows }));
    }

    [HttpPost("notifications/{kind}/{id}/retry")]
    public async Task<IActionResult> Retry(string kind, string id)
    {
        if (!await IsMapAdminAsync()) return StatusCode(403);
        if (DeploymentAuthority.IsCdsBranchPreview(configuration))
            return BadRequest(ApiResponse<object>.Fail("PREVIEW_READ_ONLY", "预览不能重发真实群通知"));
        long count;
        if (kind == "T") count = (await db.ProductInitiations.UpdateOneAsync(x => x.Id == id && !x.IsDeleted && x.ClaimNotification != null && x.ClaimNotification.Status == "failed",
            Builders<ProductInitiation>.Update.Set(x => x.ClaimNotification!.Status, "pending").Set(x => x.ClaimNotification!.Error, null), cancellationToken: CancellationToken.None)).ModifiedCount;
        else if (kind == "V") count = (await db.ProductReleases.UpdateOneAsync(x => x.Id == id && !x.IsDeleted && x.ClaimNotification != null && x.ClaimNotification.Status == "failed",
            Builders<ProductRelease>.Update.Set(x => x.ClaimNotification!.Status, "pending").Set(x => x.ClaimNotification!.Error, null), cancellationToken: CancellationToken.None)).ModifiedCount;
        else return BadRequest(ApiResponse<object>.Fail("INVALID_FORMAT", "不支持的通知类型"));
        return count == 1 ? Ok(ApiResponse<object>.Ok(new { queued = true }))
            : Conflict(ApiResponse<object>.Fail("INVALID_STATE", "仅明确失败的通知可重试；发送结果未知时请先核对企微群，避免重复消息"));
    }
}

public record ClaimNoticeRow(string Kind, string Id, string Code, string? OwnerName, DateTime CreatedAt, ProductClaimNotification Notification);

public class SaveProductClaimWebhook
{
    public string? Url { get; set; }
    public bool Enabled { get; set; }
    public bool NotifyInternal { get; set; } = true;
    public bool NotifyFormal { get; set; } = true;
}
