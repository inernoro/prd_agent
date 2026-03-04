using System.Security.Claims;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Services;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 账户数据分享：支持跨账户深拷贝 Workspace、提示词、参考图等数据。
/// 用于账户吊销前的数据迁移场景。
/// </summary>
[ApiController]
[Route("api/account/data-transfers")]
[Authorize]
[AdminController("system", AdminPermissionCatalog.Access)]
public class DataTransferController : ControllerBase
{
    private readonly MongoDbContext _db;
    private readonly WorkspaceCloneService _cloneService;
    private readonly ILogger<DataTransferController> _logger;

    public DataTransferController(
        MongoDbContext db,
        WorkspaceCloneService cloneService,
        ILogger<DataTransferController> logger)
    {
        _db = db;
        _cloneService = cloneService;
        _logger = logger;
    }

    private string GetAdminId() =>
        User.FindFirst("sub")?.Value
        ?? User.FindFirst(ClaimTypes.NameIdentifier)?.Value
        ?? "unknown";

    // ─────────────────────── 创建分享请求 ───────────────────────

    public class CreateTransferRequest
    {
        public string ReceiverUserId { get; set; } = string.Empty;
        public string? Message { get; set; }
        public List<CreateTransferItemRequest> Items { get; set; } = new();
    }

    public class CreateTransferItemRequest
    {
        public string SourceType { get; set; } = string.Empty;
        public string SourceId { get; set; } = string.Empty;
        public string? AppKey { get; set; }
    }

    [HttpPost]
    public async Task<IActionResult> Create([FromBody] CreateTransferRequest req, CancellationToken ct)
    {
        var senderId = GetAdminId();
        if (senderId == req.ReceiverUserId)
            return BadRequest(ApiResponse<object>.Fail("INVALID_RECEIVER", "不能分享给自己"));

        if (req.Items.Count == 0)
            return BadRequest(ApiResponse<object>.Fail("EMPTY_ITEMS", "请至少选择一项数据"));

        if (req.Items.Count > 50)
            return BadRequest(ApiResponse<object>.Fail("TOO_MANY_ITEMS", "单次最多分享 50 项"));

        // 验证接收方存在
        var receiver = await _db.Users.Find(u => u.UserId == req.ReceiverUserId).FirstOrDefaultAsync(ct);
        if (receiver == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "接收用户不存在"));

        var sender = await _db.Users.Find(u => u.UserId == senderId).FirstOrDefaultAsync(ct);

        // 构建清单（含预览快照）
        var items = new List<DataTransferItem>();
        foreach (var ri in req.Items)
        {
            var item = await BuildTransferItemAsync(ri, senderId, ct);
            if (item == null)
                return BadRequest(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, $"数据不存在或无权限: {ri.SourceType}/{ri.SourceId}"));
            items.Add(item);
        }

        var transfer = new AccountDataTransfer
        {
            SenderUserId = senderId,
            SenderUserName = sender?.DisplayName ?? "未知用户",
            SenderUserAvatar = sender?.AvatarFileName,
            ReceiverUserId = req.ReceiverUserId,
            ReceiverUserName = receiver.DisplayName,
            Items = items,
            Message = req.Message?.Trim(),
            ExpiresAt = DateTime.UtcNow.AddDays(7),
        };

        await _db.AccountDataTransfers.InsertOneAsync(transfer, cancellationToken: ct);

        // 发送系统通知给接收方
        var wsCount = items.Count(i => i.SourceType == "workspace");
        var otherCount = items.Count - wsCount;
        var notifTitle = $"{sender?.DisplayName ?? "某用户"} 向你分享了数据";
        var notifMsg = wsCount > 0
            ? $"包含 {wsCount} 个工作区" + (otherCount > 0 ? $"和 {otherCount} 项配置" : "")
            : $"包含 {items.Count} 项配置";

        if (!string.IsNullOrWhiteSpace(req.Message))
            notifMsg += $"\n附言：{req.Message.Trim()}";

        var notification = new AdminNotification
        {
            Key = $"data-transfer:{transfer.Id}",
            TargetUserId = req.ReceiverUserId,
            Title = notifTitle,
            Message = notifMsg,
            Level = "info",
            ActionLabel = "查看详情",
            ActionUrl = $"/data-transfers?id={transfer.Id}",
            Source = "system",
            ExpiresAt = transfer.ExpiresAt,
        };
        await _db.AdminNotifications.InsertOneAsync(notification, cancellationToken: ct);

        _logger.LogInformation("Data transfer created: {TransferId} from {Sender} to {Receiver}, {Count} items",
            transfer.Id, senderId, req.ReceiverUserId, items.Count);

        return Ok(ApiResponse<object>.Ok(new { transfer.Id, itemCount = items.Count }));
    }

    // ─────────────────────── 列出分享请求 ───────────────────────

    [HttpGet]
    public async Task<IActionResult> List([FromQuery] string? direction, CancellationToken ct)
    {
        var adminId = GetAdminId();

        FilterDefinition<AccountDataTransfer> filter;
        if (direction == "sent")
            filter = Builders<AccountDataTransfer>.Filter.Eq(t => t.SenderUserId, adminId);
        else if (direction == "received")
            filter = Builders<AccountDataTransfer>.Filter.Eq(t => t.ReceiverUserId, adminId);
        else
            filter = Builders<AccountDataTransfer>.Filter.Or(
                Builders<AccountDataTransfer>.Filter.Eq(t => t.SenderUserId, adminId),
                Builders<AccountDataTransfer>.Filter.Eq(t => t.ReceiverUserId, adminId));

        var transfers = await _db.AccountDataTransfers
            .Find(filter)
            .SortByDescending(t => t.CreatedAt)
            .Limit(100)
            .ToListAsync(ct);

        return Ok(ApiResponse<object>.Ok(new { items = transfers }));
    }

    // ─────────────────────── 查看详情 ───────────────────────

    [HttpGet("{id}")]
    public async Task<IActionResult> GetById(string id, CancellationToken ct)
    {
        var adminId = GetAdminId();
        var transfer = await _db.AccountDataTransfers.Find(t => t.Id == id).FirstOrDefaultAsync(ct);

        if (transfer == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "分享请求不存在"));

        // 只有发送方和接收方可以查看
        if (transfer.SenderUserId != adminId && transfer.ReceiverUserId != adminId)
            return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "无权查看此分享请求"));

        return Ok(ApiResponse<object>.Ok(new { transfer }));
    }

    // ─────────────────────── 接受分享 ───────────────────────

    [HttpPost("{id}/accept")]
    public async Task<IActionResult> Accept(string id, CancellationToken ct)
    {
        var adminId = GetAdminId();

        // 乐观锁：只有 pending 状态才能接受
        var transfer = await _db.AccountDataTransfers.FindOneAndUpdateAsync<AccountDataTransfer>(
            t => t.Id == id && t.ReceiverUserId == adminId && t.Status == "pending",
            Builders<AccountDataTransfer>.Update
                .Set(t => t.Status, "processing")
                .Set(t => t.UpdatedAt, DateTime.UtcNow),
            new FindOneAndUpdateOptions<AccountDataTransfer> { ReturnDocument = ReturnDocument.After },
            ct);

        if (transfer == null)
        {
            // 检查是否已过期
            var existing = await _db.AccountDataTransfers.Find(t => t.Id == id).FirstOrDefaultAsync(ct);
            if (existing == null)
                return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "分享请求不存在"));
            if (existing.ReceiverUserId != adminId)
                return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "你不是接收方"));
            if (existing.ExpiresAt < DateTime.UtcNow)
                return BadRequest(ApiResponse<object>.Fail("EXPIRED", "分享请求已过期"));
            return BadRequest(ApiResponse<object>.Fail("ALREADY_HANDLED", $"分享请求状态为 {existing.Status}，无法接受"));
        }

        // 检查过期
        if (transfer.ExpiresAt < DateTime.UtcNow)
        {
            await UpdateTransferStatusAsync(id, "expired", ct);
            return BadRequest(ApiResponse<object>.Fail("EXPIRED", "分享请求已过期"));
        }

        // 执行深拷贝
        var result = new DataTransferResult { TotalItems = transfer.Items.Count };

        foreach (var item in transfer.Items)
        {
            try
            {
                await CloneItemAsync(item, adminId, ct);
                item.CloneStatus = "success";
                result.SuccessCount++;

                if (item.SourceType == "workspace")
                {
                    // 统计 asset/message 数量（粗略计算，精确值已在 CloneService 日志中）
                    var assetCount = await _db.ImageAssets
                        .CountDocumentsAsync(a => a.WorkspaceId == item.SourceId, cancellationToken: ct);
                    var msgCount = await _db.ImageMasterMessages
                        .CountDocumentsAsync(m => m.WorkspaceId == item.SourceId, cancellationToken: ct);
                    result.TotalAssetsCopied += assetCount;
                    result.TotalMessagesCopied += msgCount;
                }
            }
            catch (InvalidOperationException ex) when (ex.Message.Contains("not found"))
            {
                item.CloneStatus = "source_missing";
                item.CloneError = "源数据已被删除";
                result.SkippedCount++;
                _logger.LogWarning("Transfer item source missing: {Type}/{Id}", item.SourceType, item.SourceId);
            }
            catch (Exception ex)
            {
                item.CloneStatus = "failed";
                item.CloneError = ex.Message;
                result.FailedCount++;
                _logger.LogError(ex, "Failed to clone transfer item: {Type}/{Id}", item.SourceType, item.SourceId);
            }
        }

        // 计算最终状态
        var finalStatus = result.FailedCount == 0 && result.SkippedCount == 0
            ? "completed"
            : result.SuccessCount == 0
                ? "failed"
                : "partial";

        await _db.AccountDataTransfers.UpdateOneAsync(
            t => t.Id == id,
            Builders<AccountDataTransfer>.Update
                .Set(t => t.Status, finalStatus)
                .Set(t => t.Items, transfer.Items)
                .Set(t => t.Result, result)
                .Set(t => t.HandledAt, DateTime.UtcNow)
                .Set(t => t.UpdatedAt, DateTime.UtcNow),
            cancellationToken: ct);

        // 通知发送方
        var receiverUser = await _db.Users.Find(u => u.UserId == adminId).FirstOrDefaultAsync(ct);
        var senderNotif = new AdminNotification
        {
            Key = $"data-transfer-accepted:{id}",
            TargetUserId = transfer.SenderUserId,
            Title = $"{receiverUser?.DisplayName ?? "对方"} 已接受你的数据分享",
            Message = $"成功 {result.SuccessCount} 项" +
                      (result.SkippedCount > 0 ? $"，跳过 {result.SkippedCount} 项（源已删除）" : "") +
                      (result.FailedCount > 0 ? $"，失败 {result.FailedCount} 项" : ""),
            Level = result.FailedCount > 0 ? "warning" : "success",
            ActionLabel = "查看详情",
            ActionUrl = $"/data-transfers?id={id}",
            Source = "system",
            ExpiresAt = DateTime.UtcNow.AddDays(14),
        };
        await _db.AdminNotifications.InsertOneAsync(senderNotif, cancellationToken: ct);

        _logger.LogInformation("Data transfer accepted: {TransferId}, status={Status}, success={S}, failed={F}, skipped={Sk}",
            id, finalStatus, result.SuccessCount, result.FailedCount, result.SkippedCount);

        return Ok(ApiResponse<object>.Ok(new { status = finalStatus, result }));
    }

    // ─────────────────────── 拒绝分享 ───────────────────────

    [HttpPost("{id}/reject")]
    public async Task<IActionResult> Reject(string id, CancellationToken ct)
    {
        var adminId = GetAdminId();

        var transfer = await _db.AccountDataTransfers.FindOneAndUpdateAsync(
            t => t.Id == id && t.ReceiverUserId == adminId && t.Status == "pending",
            Builders<AccountDataTransfer>.Update
                .Set(t => t.Status, "rejected")
                .Set(t => t.HandledAt, DateTime.UtcNow)
                .Set(t => t.UpdatedAt, DateTime.UtcNow),
            cancellationToken: ct);

        if (transfer == null)
            return BadRequest(ApiResponse<object>.Fail("ALREADY_HANDLED", "分享请求已处理或不存在"));

        // 通知发送方
        var receiverUser = await _db.Users.Find(u => u.UserId == adminId).FirstOrDefaultAsync(ct);
        var notif = new AdminNotification
        {
            Key = $"data-transfer-rejected:{id}",
            TargetUserId = transfer.SenderUserId,
            Title = $"{receiverUser?.DisplayName ?? "对方"} 拒绝了你的数据分享",
            Level = "info",
            ActionLabel = "查看详情",
            ActionUrl = $"/data-transfers?id={id}",
            Source = "system",
            ExpiresAt = DateTime.UtcNow.AddDays(7),
        };
        await _db.AdminNotifications.InsertOneAsync(notif, cancellationToken: ct);

        return Ok(ApiResponse<object>.Ok(new { status = "rejected" }));
    }

    // ─────────────────────── 发送方取消 ───────────────────────

    [HttpPost("{id}/cancel")]
    public async Task<IActionResult> Cancel(string id, CancellationToken ct)
    {
        var adminId = GetAdminId();

        var transfer = await _db.AccountDataTransfers.FindOneAndUpdateAsync(
            t => t.Id == id && t.SenderUserId == adminId && t.Status == "pending",
            Builders<AccountDataTransfer>.Update
                .Set(t => t.Status, "cancelled")
                .Set(t => t.UpdatedAt, DateTime.UtcNow),
            cancellationToken: ct);

        if (transfer == null)
            return BadRequest(ApiResponse<object>.Fail("ALREADY_HANDLED", "分享请求已处理或不存在"));

        return Ok(ApiResponse<object>.Ok(new { status = "cancelled" }));
    }

    // ─────────────────────── 获取可分享的 Workspace 列表 ───────────────────────

    [HttpGet("my-workspaces")]
    public async Task<IActionResult> ListMyWorkspaces([FromQuery] string? scenarioType, CancellationToken ct)
    {
        var adminId = GetAdminId();

        var filterBuilder = Builders<ImageMasterWorkspace>.Filter;
        var filter = filterBuilder.Eq(w => w.OwnerUserId, adminId);

        if (!string.IsNullOrEmpty(scenarioType))
            filter &= filterBuilder.Eq(w => w.ScenarioType, scenarioType);

        var workspaces = await _db.ImageMasterWorkspaces
            .Find(filter)
            .SortByDescending(w => w.UpdatedAt)
            .Limit(200)
            .ToListAsync(ct);

        // 批量获取每个 workspace 的 asset 数量
        var wsIds = workspaces.Select(w => w.Id).ToList();
        var assetCounts = new Dictionary<string, long>();
        foreach (var wsId in wsIds)
        {
            assetCounts[wsId] = await _db.ImageAssets
                .CountDocumentsAsync(a => a.WorkspaceId == wsId, cancellationToken: ct);
        }

        var items = workspaces.Select(w => new
        {
            w.Id,
            w.Title,
            w.ScenarioType,
            w.FolderName,
            assetCount = assetCounts.GetValueOrDefault(w.Id, 0),
            w.CoverAssetIds,
            w.UpdatedAt,
        });

        return Ok(ApiResponse<object>.Ok(new { items }));
    }

    // ─────────────────────── 获取可分享的提示词/参考图列表 ───────────────────────

    [HttpGet("my-configs")]
    public async Task<IActionResult> ListMyConfigs(CancellationToken ct)
    {
        var adminId = GetAdminId();

        var prompts = await _db.LiteraryPrompts
            .Find(p => p.OwnerUserId == adminId && !p.IsSystem)
            .SortByDescending(p => p.UpdatedAt)
            .ToListAsync(ct);

        var refImages = await _db.ReferenceImageConfigs
            .Find(r => r.CreatedByAdminId == adminId)
            .SortByDescending(r => r.UpdatedAt)
            .ToListAsync(ct);

        return Ok(ApiResponse<object>.Ok(new
        {
            prompts = prompts.Select(p => new { p.Id, p.Title, sourceType = "literary-prompt" }),
            refImages = refImages.Select(r => new { r.Id, r.Name, sourceType = "ref-image-config", r.AppKey }),
        }));
    }

    // ─────────────────────── Private Helpers ───────────────────────

    private async Task<DataTransferItem?> BuildTransferItemAsync(
        CreateTransferItemRequest ri, string adminId, CancellationToken ct)
    {
        switch (ri.SourceType)
        {
            case "workspace":
            {
                var ws = await _db.ImageMasterWorkspaces.Find(w => w.Id == ri.SourceId).FirstOrDefaultAsync(ct);
                if (ws == null || ws.OwnerUserId != adminId) return null;
                var assetCount = await _db.ImageAssets.CountDocumentsAsync(a => a.WorkspaceId == ws.Id, cancellationToken: ct);
                return new DataTransferItem
                {
                    SourceType = "workspace",
                    SourceId = ws.Id,
                    DisplayName = ws.Title,
                    AppKey = ws.ScenarioType == "article-illustration" ? "literary-agent" : "visual-agent",
                    PreviewInfo = $"{assetCount} 张图片",
                };
            }
            case "literary-prompt":
            {
                var prompt = await _db.LiteraryPrompts.Find(p => p.Id == ri.SourceId).FirstOrDefaultAsync(ct);
                if (prompt == null || prompt.OwnerUserId != adminId) return null;
                return new DataTransferItem
                {
                    SourceType = "literary-prompt",
                    SourceId = prompt.Id,
                    DisplayName = prompt.Title,
                    AppKey = "literary-agent",
                };
            }
            case "ref-image-config":
            {
                var refImg = await _db.ReferenceImageConfigs.Find(r => r.Id == ri.SourceId).FirstOrDefaultAsync(ct);
                if (refImg == null || refImg.CreatedByAdminId != adminId) return null;
                return new DataTransferItem
                {
                    SourceType = "ref-image-config",
                    SourceId = refImg.Id,
                    DisplayName = refImg.Name,
                    AppKey = refImg.AppKey ?? ri.AppKey,
                };
            }
            default:
                return null;
        }
    }

    private async Task CloneItemAsync(DataTransferItem item, string newOwnerId, CancellationToken ct)
    {
        switch (item.SourceType)
        {
            case "workspace":
            {
                var result = await _cloneService.CloneAsync(item.SourceId, newOwnerId, ct);
                item.ClonedId = result.NewWorkspaceId;
                break;
            }
            case "literary-prompt":
            {
                var source = await _db.LiteraryPrompts.Find(p => p.Id == item.SourceId).FirstOrDefaultAsync(ct)
                             ?? throw new InvalidOperationException($"Literary prompt not found: {item.SourceId}");
                var senderUser = await _db.Users.Find(u => u.UserId == source.OwnerUserId).FirstOrDefaultAsync(ct);
                var now = DateTime.UtcNow;
                var forked = new LiteraryPrompt
                {
                    OwnerUserId = newOwnerId,
                    Title = $"{source.Title} (来自分享)",
                    Content = source.Content,
                    ScenarioType = source.ScenarioType,
                    Order = source.Order,
                    IsPublic = false,
                    ForkCount = 0,
                    ForkedFromId = source.Id,
                    ForkedFromUserId = source.OwnerUserId,
                    ForkedFromUserName = senderUser?.DisplayName,
                    ForkedFromUserAvatar = senderUser?.AvatarFileName,
                    IsModifiedAfterFork = false,
                    CreatedAt = now,
                    UpdatedAt = now,
                };
                await _db.LiteraryPrompts.InsertOneAsync(forked, cancellationToken: ct);
                item.ClonedId = forked.Id;
                break;
            }
            case "ref-image-config":
            {
                var source = await _db.ReferenceImageConfigs.Find(r => r.Id == item.SourceId).FirstOrDefaultAsync(ct)
                             ?? throw new InvalidOperationException($"Ref image config not found: {item.SourceId}");
                var senderUser = await _db.Users.Find(u => u.UserId == source.CreatedByAdminId).FirstOrDefaultAsync(ct);
                var now = DateTime.UtcNow;
                var forked = new ReferenceImageConfig
                {
                    Name = $"{source.Name} (来自分享)",
                    Prompt = source.Prompt,
                    ImageSha256 = source.ImageSha256,
                    ImageUrl = source.ImageUrl,
                    IsActive = false,
                    AppKey = source.AppKey,
                    CreatedByAdminId = newOwnerId,
                    IsPublic = false,
                    ForkCount = 0,
                    ForkedFromId = source.Id,
                    ForkedFromUserId = source.CreatedByAdminId,
                    ForkedFromUserName = senderUser?.DisplayName,
                    ForkedFromUserAvatar = senderUser?.AvatarFileName,
                    IsModifiedAfterFork = false,
                    CreatedAt = now,
                    UpdatedAt = now,
                };
                await _db.ReferenceImageConfigs.InsertOneAsync(forked, cancellationToken: ct);
                item.ClonedId = forked.Id;
                break;
            }
            default:
                throw new InvalidOperationException($"Unknown source type: {item.SourceType}");
        }
    }

    private async Task UpdateTransferStatusAsync(string transferId, string status, CancellationToken ct)
    {
        await _db.AccountDataTransfers.UpdateOneAsync(
            t => t.Id == transferId,
            Builders<AccountDataTransfer>.Update
                .Set(t => t.Status, status)
                .Set(t => t.UpdatedAt, DateTime.UtcNow),
            cancellationToken: ct);
    }
}
