using System.Security.Cryptography;
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
using PrdAgent.Infrastructure.Services;

namespace PrdAgent.Api.Controllers.Api;

[ApiController, Authorize, Route("api/product/claim-webhook")]
[AdminController("product-agent", AdminPermissionCatalog.ProductAgentUse)]
public class ProductClaimWebhookController(MongoDbContext db, IDataProtectionProvider protection, IConfiguration configuration, IServiceProvider? deliveryServices = null) : ControllerBase
{
    public const string ProtectionPurpose = "ProductAgent.ClaimWebhook.v1";
    private const string MaskedWebhook = "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=********";

    private async Task<bool> IsMapAdminAsync() => User.HasClaim("isRoot", "1") || ProductPermissionRules.IsMapAdministrator(
        await db.Users.Find(x => x.UserId == this.GetRequiredUserId()).FirstOrDefaultAsync() ?? new User());

    [HttpGet]
    public async Task<IActionResult> Get()
    {
        if (!await IsMapAdminAsync()) return StatusCode(403);
        var settings = await db.ProductAgentSettings.Find(x => x.Id == ProductAgentSettings.SingletonId).FirstOrDefaultAsync();
        var config = settings?.ClaimWebhook ?? new();
        var canEdit = DeploymentAuthority.CanRotateSharedCiphertext(configuration);
        var sendBlockReason = ProductClaimNotificationQueue.GetDeploymentBlockReason(configuration);
        var users = await db.Users.Find(x => x.Status == UserStatus.Active && x.UserType == UserType.Human).ToListAsync();
        var ready = users.Count(user => ProductClaimMentionIdentity.Resolve(user, protection) != null);
        return Ok(ApiResponse<object>.Ok(new {
            config.Enabled, config.DebugMode, config.NotifyInternal, config.NotifyFormal,
            configured = !string.IsNullOrEmpty(config.ProtectedUrl),
            maskedUrl = MaskWebhook(config.ProtectedUrl, canEdit),
            identityReadyCount = ready, identityPendingCount = users.Count - ready,
            canEdit,
            canSend = sendBlockReason is null,
            sendBlockedReason = sendBlockReason is { } reason
                ? $"{ProductClaimNotificationQueue.DescribeDeploymentBlock(reason)}，无法发送版本申领通知。"
                : null,
        }));
    }

    private string? MaskWebhook(string? protectedUrl, bool canEdit)
    {
        if (string.IsNullOrEmpty(protectedUrl)) return null;
        if (!canEdit) return MaskedWebhook;

        try
        {
            var url = protection.CreateProtector(ProtectionPurpose).Unprotect(protectedUrl);
            if (!ProductClaimWebhookPayload.IsValidWebhook(url)) return MaskedWebhook;
            var key = new Uri(url).Query["?key=".Length..];
            return key.Length > 4 ? MaskedWebhook + key[^4..] : MaskedWebhook;
        }
        catch (CryptographicException)
        {
            return MaskedWebhook;
        }
    }

    [HttpPut]
    public async Task<IActionResult> Save([FromBody] SaveProductClaimWebhook request)
    {
        if (!await IsMapAdminAsync()) return StatusCode(403);
        // 共库预览不能用异钥覆写正式密文，也不能让预览配置意外启用真实群通知。
        if (DeploymentAuthority.IsCdsBranchPreview(configuration))
            return BadRequest(ApiResponse<object>.Fail("PREVIEW_READ_ONLY", "请在正式环境保存Webhook配置，预览不会发送群通知"));
        if (!DeploymentAuthority.CanRotateSharedCiphertext(configuration))
            return StatusCode(403, ApiResponse<object>.Fail("FORBIDDEN", "当前部署未获准修改共享Webhook配置"));
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
            DebugMode = request.DebugMode ?? existing?.ClaimWebhook?.DebugMode ?? false,
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

    [HttpPost("notifications/{kind}/{id}/debug")]
    public async Task<IActionResult> DebugNotify(string kind, string id)
    {
        var actor = this.GetRequiredUserId();
        var admin = await IsMapAdminAsync();
        var config = (await db.ProductAgentSettings.Find(x => x.Id == ProductAgentSettings.SingletonId).FirstOrDefaultAsync())?.ClaimWebhook;
        var record = await ReadNoticeAsync(kind, id);
        if (record.Notification == null || (!admin && record.CreatedBy != actor)
            || (record.Notification.Status != "debug_pending"
                && !(config?.DebugMode == true && record.Notification.Status is "pending" or "waiting_identity")))
            return Conflict(ApiResponse<object>.Fail("INVALID_STATE", "该通知不可调试或已发送；仅申请人本人或MAP管理员可操作，请刷新核对。"));
        return await DeliverAsync(kind, id);
    }

    [HttpPost("notifications/{kind}/{id}/resend")]
    public async Task<IActionResult> Resend(string kind, string id)
    {
        if (!await IsMapAdminAsync()) return StatusCode(403);
        var record = await ReadNoticeAsync(kind, id);
        if (record.Notification?.Status is not ("pending" or "debug_pending" or "waiting_identity" or "failed"))
            return Conflict(ApiResponse<object>.Fail("INVALID_STATE", "仅待发送或明确失败的通知可补发；结果未知请先核对群消息，已发送和历史停用记录不会重复发送。"));
        return await DeliverAsync(kind, id);
    }

    [HttpPost("notifications/{kind}/{id}/retry")]
    public async Task<IActionResult> Retry(string kind, string id)
    {
        if (!await IsMapAdminAsync()) return StatusCode(403);
        if ((await ReadNoticeAsync(kind, id)).Notification?.Status != "failed")
            return Conflict(ApiResponse<object>.Fail("INVALID_STATE", "仅明确失败的通知可重试；发送结果未知时请先核对企微群，避免重复消息"));
        return await DeliverAsync(kind, id);
    }

    private async Task<(ProductClaimNotification? Notification, string? CreatedBy)> ReadNoticeAsync(string kind, string id)
    {
        if (kind == "T")
        {
            var record = await db.ProductInitiations.Find(x => x.Id == id && !x.IsDeleted && x.Status != "voided").FirstOrDefaultAsync();
            return (record?.ClaimNotification, record?.CreatedBy);
        }
        if (kind == "V")
        {
            var record = await db.ProductReleases.Find(x => x.Id == id && !x.IsDeleted && x.Status != "voided").FirstOrDefaultAsync();
            return (record?.ClaimNotification, record?.CreatedBy);
        }
        return (null, null);
    }

    private async Task<IActionResult> DeliverAsync(string kind, string id)
    {
        if (ProductClaimNotificationQueue.GetDeploymentBlockReason(configuration) is { } blocked)
            return BadRequest(ApiResponse<object>.Fail("DELIVERY_DISABLED", ProductClaimNotificationQueue.DescribeDeploymentBlock(blocked)));
        try
        {
            var notice = await ProductClaimWebhookWorker.DispatchRecordAsync(kind, id,
                deliveryServices ?? HttpContext.RequestServices, manualDispatch: true);
            if (notice?.Status == "sent")
                return Ok(ApiResponse<object>.Ok(new { queued = true, sent = true, status = notice.Status, message = "通知已发送到企微群。" }));
            return Conflict(ApiResponse<object>.Fail("DELIVERY_NOT_CONFIRMED", notice?.Error
                ?? (notice?.Status == "sending" ? "通知正在发送，请刷新状态，勿重复点击。" : "本次未发送，请刷新状态并检查通知配置。")));
        }
        catch (InvalidOperationException ex)
        {
            return BadRequest(ApiResponse<object>.Fail("DELIVERY_DISABLED", ex.Message));
        }
    }

}

public record ClaimNoticeRow(string Kind, string Id, string Code, string? OwnerName, DateTime CreatedAt, ProductClaimNotification Notification);

public class SaveProductClaimWebhook
{
    public string? Url { get; set; }
    public bool Enabled { get; set; }
    public bool? DebugMode { get; set; }
    public bool NotifyInternal { get; set; } = true;
    public bool NotifyFormal { get; set; } = true;
}
