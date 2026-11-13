using System.Security.Claims;
using System.Text.Json;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Api.Extensions;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Api.Services;
using PrdAgent.Core.LlmGateway;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 管理后台 - 竞技场（模型盲评对战）
/// </summary>
[ApiController]
[Route("api/lab/arena")]
[Authorize]
[AdminController("arena-agent", AdminPermissionCatalog.ArenaAgentUse)]
public sealed class ArenaController : ControllerBase
{
    private readonly MongoDbContext _db;
    private readonly IRunEventStore _runStore;
    private readonly IRunQueue _runQueue;
    private readonly BusinessModelReferenceService _modelReferences;
    private static readonly JsonSerializerOptions JsonOptions = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

    public ArenaController(MongoDbContext db, IRunEventStore runStore, IRunQueue runQueue, BusinessModelReferenceService modelReferences)
    {
        _db = db;
        _runStore = runStore;
        _runQueue = runQueue;
        _modelReferences = modelReferences;
    }

    private string GetUserId() => this.GetRequiredUserId();

    private Task<IReadOnlyList<BusinessModelOption>> ReadModels(CancellationToken ct) =>
        _modelReferences.GetOptionsAsync(AppCallerRegistry.Desktop.Arena.BattleChat, ModelTypes.Chat, ct);

    private async Task AnnotateSlots(IReadOnlyList<ArenaSlot> slots, CancellationToken ct)
    {
        IReadOnlyList<BusinessModelOption> options;
        try { options = await ReadModels(ct); }
        catch (Exception) when (!ct.IsCancellationRequested)
        {
            foreach (var slot in slots)
            {
                slot.ModelReferenceStatus = "unknown";
                slot.ModelReferenceReason = "暂时无法确认模型状态，请稍后刷新；原配置已保留。";
            }
            return;
        }
        foreach (var slot in slots)
        {
            var result = BusinessModelReferenceService.Resolve(options, slot.LogicalModelId, slot.PlatformId, slot.ModelId);
            slot.ModelReferenceStatus = result.Status;
            slot.ModelReferenceReason = result.Reason;
        }
    }

    [HttpGet("model-options")]
    public async Task<IActionResult> ModelOptions(CancellationToken ct) =>
        Ok(ApiResponse<object>.Ok(new { items = await ReadModels(ct) }));

    // ─────────────────────────── Groups CRUD ───────────────────────────

    /// <summary>
    /// 获取所有竞技场分组（含关联的 slots），按 SortOrder 排序
    /// </summary>
    [HttpGet("groups")]
    public async Task<IActionResult> ListGroups(CancellationToken ct)
    {
        var groups = await _db.ArenaGroups
            .Find(FilterDefinition<ArenaGroup>.Empty)
            .SortBy(g => g.SortOrder)
            .ToListAsync(ct);

        var slots = await _db.ArenaSlots
            .Find(FilterDefinition<ArenaSlot>.Empty)
            .SortBy(s => s.SortOrder)
            .ToListAsync(ct);

        await AnnotateSlots(slots, ct);
        var slotsByGroup = slots
            .GroupBy(s => s.Group)
            .ToDictionary(g => g.Key, g => g.ToList());

        var items = groups.Select(g => new
        {
            g.Id,
            g.Key,
            g.Name,
            g.Description,
            g.Icon,
            g.SortOrder,
            g.CreatedBy,
            g.CreatedAt,
            g.UpdatedAt,
            Slots = slotsByGroup.TryGetValue(g.Key, out var s) ? s : new List<ArenaSlot>()
        });

        return Ok(ApiResponse<object>.Ok(new { items }));
    }

    /// <summary>
    /// 创建竞技场分组
    /// </summary>
    [HttpPost("groups")]
    public async Task<IActionResult> CreateGroup([FromBody] UpsertArenaGroupRequest request, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(request.Key))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "key 不能为空"));
        if (string.IsNullOrWhiteSpace(request.Name))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "name 不能为空"));

        var key = request.Key.Trim();

        var existing = await _db.ArenaGroups
            .Find(g => g.Key == key)
            .FirstOrDefaultAsync(ct);
        if (existing != null)
            return Conflict(ApiResponse<object>.Fail(ErrorCodes.DUPLICATE, $"分组 key '{key}' 已存在"));

        var group = new ArenaGroup
        {
            Key = key,
            Name = request.Name.Trim(),
            Description = request.Description?.Trim(),
            Icon = request.Icon?.Trim(),
            SortOrder = request.SortOrder,
            CreatedBy = GetUserId(),
            CreatedAt = DateTime.UtcNow,
            UpdatedAt = DateTime.UtcNow
        };

        await _db.ArenaGroups.InsertOneAsync(group, cancellationToken: ct);

        return Ok(ApiResponse<object>.Ok(group));
    }

    /// <summary>
    /// 更新竞技场分组
    /// </summary>
    [HttpPut("groups/{id}")]
    public async Task<IActionResult> UpdateGroup(string id, [FromBody] UpsertArenaGroupRequest request, CancellationToken ct)
    {
        var existing = await _db.ArenaGroups
            .Find(g => g.Id == id)
            .FirstOrDefaultAsync(ct);
        if (existing == null)
            return NotFound(ApiResponse<object>.Fail("GROUP_NOT_FOUND", "分组不存在"));

        // 如果 key 发生变化，需要检查唯一性
        if (!string.IsNullOrWhiteSpace(request.Key) && request.Key.Trim() != existing.Key)
        {
            var duplicate = await _db.ArenaGroups
                .Find(g => g.Key == request.Key.Trim() && g.Id != id)
                .FirstOrDefaultAsync(ct);
            if (duplicate != null)
                return Conflict(ApiResponse<object>.Fail(ErrorCodes.DUPLICATE, $"分组 key '{request.Key.Trim()}' 已存在"));
        }

        var update = Builders<ArenaGroup>.Update
            .Set(g => g.Name, (request.Name ?? existing.Name).Trim())
            .Set(g => g.Description, request.Description?.Trim() ?? existing.Description)
            .Set(g => g.Icon, request.Icon?.Trim() ?? existing.Icon)
            .Set(g => g.SortOrder, request.SortOrder)
            .Set(g => g.UpdatedAt, DateTime.UtcNow);

        if (!string.IsNullOrWhiteSpace(request.Key))
            update = update.Set(g => g.Key, request.Key.Trim());

        await _db.ArenaGroups.UpdateOneAsync(g => g.Id == id, update, cancellationToken: ct);

        var updated = await _db.ArenaGroups.Find(g => g.Id == id).FirstOrDefaultAsync(ct);
        return Ok(ApiResponse<object>.Ok(updated));
    }

    /// <summary>
    /// 删除竞技场分组（级联删除其下所有 slots）
    /// </summary>
    [HttpDelete("groups/{id}")]
    public async Task<IActionResult> DeleteGroup(string id, CancellationToken ct)
    {
        var group = await _db.ArenaGroups
            .Find(g => g.Id == id)
            .FirstOrDefaultAsync(ct);
        if (group == null)
            return NotFound(ApiResponse<object>.Fail("GROUP_NOT_FOUND", "分组不存在"));

        // 级联删除该分组下的所有 slots
        await _db.ArenaSlots.DeleteManyAsync(s => s.Group == group.Key, ct);
        await _db.ArenaGroups.DeleteOneAsync(g => g.Id == id, ct);

        return Ok(ApiResponse<object>.Ok(new { }));
    }

    // ─────────────────────────── Slots CRUD ───────────────────────────

    /// <summary>
    /// 获取竞技场 slots，可选按 group 过滤
    /// </summary>
    [HttpGet("slots")]
    public async Task<IActionResult> ListSlots([FromQuery] string? group, CancellationToken ct)
    {
        var filter = string.IsNullOrWhiteSpace(group)
            ? FilterDefinition<ArenaSlot>.Empty
            : Builders<ArenaSlot>.Filter.Eq(s => s.Group, group.Trim());

        var slots = await _db.ArenaSlots
            .Find(filter)
            .SortBy(s => s.SortOrder)
            .ToListAsync(ct);

        await AnnotateSlots(slots, ct);
        return Ok(ApiResponse<object>.Ok(new { items = slots }));
    }

    /// <summary>
    /// 创建竞技场 slot
    /// </summary>
    [HttpPost("slots")]
    public async Task<IActionResult> CreateSlot([FromBody] UpsertArenaSlotRequest request, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(request.DisplayName))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "displayName 不能为空"));
        var reference = BusinessModelReferenceService.Resolve(await ReadModels(ct), request.LogicalModelId, request.PlatformId, request.ModelId);
        if (!reference.Success)
            return BadRequest(ApiResponse<object>.Fail("MODEL_REFERENCE_UNAVAILABLE", reference.Reason!));
        if (string.IsNullOrWhiteSpace(request.Group))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "group 不能为空"));

        var slot = new ArenaSlot
        {
            DisplayName = request.DisplayName.Trim(),
            LogicalModelId = reference.LogicalModelId,
            PlatformId = "logical-model",
            ModelId = reference.PublicId,
            Group = request.Group.Trim(),
            SortOrder = request.SortOrder ?? 0,
            Enabled = request.Enabled ?? true,
            AvatarColor = request.AvatarColor?.Trim(),
            Description = request.Description?.Trim(),
            CreatedBy = GetUserId(),
            CreatedAt = DateTime.UtcNow,
            UpdatedAt = DateTime.UtcNow
        };

        await _db.ArenaSlots.InsertOneAsync(slot, cancellationToken: ct);

        return Ok(ApiResponse<object>.Ok(slot));
    }

    /// <summary>
    /// 更新竞技场 slot
    /// </summary>
    [HttpPut("slots/{id}")]
    public async Task<IActionResult> UpdateSlot(string id, [FromBody] UpsertArenaSlotRequest request, CancellationToken ct)
    {
        var existing = await _db.ArenaSlots
            .Find(s => s.Id == id)
            .FirstOrDefaultAsync(ct);
        if (existing == null)
            return NotFound(ApiResponse<object>.Fail("SLOT_NOT_FOUND", "Slot 不存在"));

        var changesModel = request.LogicalModelId is not null || request.PlatformId is not null || request.ModelId is not null;
        BusinessModelReferenceResult? reference = null;
        if (changesModel || (request.Enabled == true && !existing.Enabled))
        {
            reference = BusinessModelReferenceService.Resolve(await ReadModels(ct),
                request.LogicalModelId ?? existing.LogicalModelId,
                request.PlatformId ?? existing.PlatformId, request.ModelId ?? existing.ModelId);
            if (!reference.Success)
                return BadRequest(ApiResponse<object>.Fail("MODEL_REFERENCE_UNAVAILABLE", reference.Reason!));
        }
        var nextVersion = DateTime.UtcNow;
        if (nextVersion <= existing.UpdatedAt.AddMilliseconds(1)) nextVersion = existing.UpdatedAt.AddMilliseconds(1);
        var update = Builders<ArenaSlot>.Update
            .Set(s => s.DisplayName, (request.DisplayName ?? existing.DisplayName).Trim())
            .Set(s => s.Group, (request.Group ?? existing.Group).Trim())
            .Set(s => s.SortOrder, request.SortOrder ?? existing.SortOrder)
            .Set(s => s.Enabled, request.Enabled ?? existing.Enabled)
            .Set(s => s.AvatarColor, request.AvatarColor?.Trim() ?? existing.AvatarColor)
            .Set(s => s.Description, request.Description?.Trim() ?? existing.Description)
            .Set(s => s.UpdatedAt, nextVersion);

        if (reference is not null)
            update = update.Set(s => s.LogicalModelId, reference.LogicalModelId)
                .Set(s => s.PlatformId, "logical-model").Set(s => s.ModelId, reference.PublicId);
        var result = await _db.ArenaSlots.UpdateOneAsync(s => s.Id == id && s.UpdatedAt == existing.UpdatedAt, update, cancellationToken: ct);
        if (result.MatchedCount == 0)
            return Conflict(ApiResponse<object>.Fail("CONFIG_CHANGED", "阵容刚刚被修改，请刷新后重试。"));

        var updated = await _db.ArenaSlots.Find(s => s.Id == id).FirstOrDefaultAsync(ct);
        return Ok(ApiResponse<object>.Ok(updated));
    }

    /// <summary>
    /// 删除竞技场 slot
    /// </summary>
    [HttpDelete("slots/{id}")]
    public async Task<IActionResult> DeleteSlot(string id, CancellationToken ct)
    {
        var result = await _db.ArenaSlots.DeleteOneAsync(s => s.Id == id, ct);
        if (result.DeletedCount == 0)
            return NotFound(ApiResponse<object>.Fail("SLOT_NOT_FOUND", "Slot 不存在"));

        return Ok(ApiResponse<object>.Ok(new { }));
    }

    /// <summary>
    /// 切换 slot 的启用/禁用状态
    /// </summary>
    [HttpPut("slots/{id}/toggle")]
    public async Task<IActionResult> ToggleSlot(string id, CancellationToken ct)
    {
        var slot = await _db.ArenaSlots
            .Find(s => s.Id == id)
            .FirstOrDefaultAsync(ct);
        if (slot == null)
            return NotFound(ApiResponse<object>.Fail("SLOT_NOT_FOUND", "Slot 不存在"));

        var newEnabled = !slot.Enabled;
        if (newEnabled)
        {
            var reference = BusinessModelReferenceService.Resolve(await ReadModels(ct), slot.LogicalModelId, slot.PlatformId, slot.ModelId);
            if (!reference.Success)
                return BadRequest(ApiResponse<object>.Fail("MODEL_REFERENCE_UNAVAILABLE", reference.Reason!));
        }

        var nextVersion = DateTime.UtcNow;
        if (nextVersion <= slot.UpdatedAt.AddMilliseconds(1)) nextVersion = slot.UpdatedAt.AddMilliseconds(1);
        var result = await _db.ArenaSlots.UpdateOneAsync(
            s => s.Id == id && s.UpdatedAt == slot.UpdatedAt,
            Builders<ArenaSlot>.Update
                .Set(s => s.Enabled, newEnabled)
                .Set(s => s.UpdatedAt, nextVersion),
            cancellationToken: ct);

        if (result.MatchedCount == 0)
            return Conflict(ApiResponse<object>.Fail("CONFIG_CHANGED", "阵容刚刚被修改，请刷新后重试。"));
        return Ok(ApiResponse<object>.Ok(new { id, enabled = newEnabled }));
    }

    // ─────────────────────────── User-side ───────────────────────────

    /// <summary>
    /// 获取竞技场阵容（盲模式：不返回 displayName / avatarColor / description）
    /// 仅返回已启用的分组及其已启用的 slots
    /// </summary>
    [HttpGet("lineup")]
    public async Task<IActionResult> GetLineup(CancellationToken ct)
    {
        var groups = await _db.ArenaGroups
            .Find(FilterDefinition<ArenaGroup>.Empty)
            .SortBy(g => g.SortOrder)
            .ToListAsync(ct);

        var enabledSlots = await _db.ArenaSlots
            .Find(s => s.Enabled)
            .SortBy(s => s.SortOrder)
            .ToListAsync(ct);

        await AnnotateSlots(enabledSlots, ct);
        var slotsByGroup = enabledSlots
            .GroupBy(s => s.Group)
            .ToDictionary(g => g.Key, g => g.ToList());

        // 仅返回有启用 slots 的分组
        var items = groups
            .Where(g => slotsByGroup.ContainsKey(g.Key))
            .Select(g => new
            {
                g.Key,
                g.Name,
                Slots = slotsByGroup[g.Key].Select(s => new
                {
                    s.Id,
                    s.PlatformId,
                    s.ModelId,
                    s.LogicalModelId,
                    s.ModelReferenceStatus,
                    s.ModelReferenceReason
                })
            });

        return Ok(ApiResponse<object>.Ok(new { items }));
    }

    /// <summary>
    /// 揭晓 slot 的真实身份信息（displayName、platformName、avatarColor、description）
    /// </summary>
    [HttpPost("reveal")]
    public async Task<IActionResult> Reveal([FromBody] ArenaRevealRequest request, CancellationToken ct)
    {
        if (request.SlotIds == null || request.SlotIds.Count == 0)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "slotIds 不能为空"));

        var ids = request.SlotIds.Where(id => !string.IsNullOrWhiteSpace(id)).Select(id => id.Trim()).Distinct().ToList();

        var slots = await _db.ArenaSlots
            .Find(Builders<ArenaSlot>.Filter.In(s => s.Id, ids))
            .ToListAsync(ct);

        // 获取相关平台信息用于 join platformName
        var platformIds = slots.Select(s => s.PlatformId).Where(p => !string.IsNullOrWhiteSpace(p)).Distinct().ToList();
        var platforms = await _db.LLMPlatforms
            .Find(Builders<LLMPlatform>.Filter.In(p => p.Id, platformIds))
            .ToListAsync(ct);
        var platformNameMap = platforms.ToDictionary(p => p.Id, p => p.Name);

        var items = slots.Select(s => new
        {
            s.Id,
            s.DisplayName,
            PlatformName = s.PlatformId == "logical-model" ? "LLM Gateway" : platformNameMap.TryGetValue(s.PlatformId, out var pn) ? pn : "原上游已移除",
            s.AvatarColor,
            s.Description
        });

        return Ok(ApiResponse<object>.Ok(new { items }));
    }

    // ─────────────────────────── Runs (Run/Worker + afterSeq) ───────────────────────────

    /// <summary>
    /// 创建竞技场 Run：将多模型并行请求交给后台 Worker 执行，前端通过 afterSeq 断线重连。
    /// </summary>
    [HttpPost("runs")]
    public async Task<IActionResult> CreateRun([FromBody] CreateArenaRunRequest request, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(request.Prompt))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "prompt 不能为空"));
        if (request.Slots == null || request.Slots.Count == 0)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "slots 不能为空"));

        // 请求中的模型字段不具备选择权限；以服务端保存的阵容为准，入队前整组校验。
        var ids = request.Slots.Select(s => s.SlotId?.Trim() ?? "").ToList();
        if (ids.Any(string.IsNullOrEmpty) || ids.Distinct().Count() != ids.Count)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "阵容包含重复或缺失的成员，请重新选择阵容。"));
        var storedSlots = await _db.ArenaSlots.Find(Builders<ArenaSlot>.Filter.In(s => s.Id, ids)).ToListAsync(ct);
        var options = await ReadModels(ct);
        var runSlots = new List<object>();
        foreach (var requested in request.Slots)
        {
            var stored = storedSlots.SingleOrDefault(s => s.Id == requested.SlotId?.Trim());
            if (stored is null || !stored.Enabled || stored.Group != request.GroupKey?.Trim())
                return BadRequest(ApiResponse<object>.Fail("MODEL_REFERENCE_UNAVAILABLE", "阵容已变更，请重新选择阵容后重试。"));
            var reference = BusinessModelReferenceService.Resolve(options, stored.LogicalModelId, stored.PlatformId, stored.ModelId);
            if (!reference.Success)
                return BadRequest(ApiResponse<object>.Fail("MODEL_REFERENCE_UNAVAILABLE", reference.Reason!));
            runSlots.Add(new {
                slotId = stored.Id, logicalModelId = reference.LogicalModelId,
                platformId = "logical-model", modelId = reference.PublicId,
                label = (requested.Label ?? "").Trim(), labelIndex = requested.LabelIndex
            });
        }
        var userId = GetUserId();
        var runId = Guid.NewGuid().ToString("N");

        var meta = new RunMeta
        {
            TaskPermitId = TaskExecutionContext.Current?.PermitId,
            RunId = runId,
            Kind = RunKinds.Arena,
            Status = RunStatuses.Queued,
            CreatedByUserId = userId,
            CreatedAt = DateTime.UtcNow,
            LastSeq = 0,
            CancelRequested = false,
            InputJson = JsonSerializer.Serialize(new
            {
                prompt = request.Prompt.Trim(),
                groupKey = (request.GroupKey ?? "").Trim(),
                userId,
                slots = runSlots,
                attachmentIds = request.AttachmentIds?
                    .Where(id => !string.IsNullOrWhiteSpace(id))
                    .Select(id => id.Trim())
                    .Distinct()
                    .ToList() ?? new List<string>()
            }, JsonOptions)
        };

        await _runStore.SetRunAsync(RunKinds.Arena, meta, ttl: TimeSpan.FromHours(24), ct: CancellationToken.None);
        await _runQueue.EnqueueAsync(RunKinds.Arena, runId, CancellationToken.None);

        return Ok(ApiResponse<object>.Ok(new { runId }));
    }

    /// <summary>
    /// 获取 Run 状态
    /// </summary>
    [HttpGet("runs/{runId}")]
    public async Task<IActionResult> GetRun(string runId, CancellationToken ct)
    {
        var rid = (runId ?? "").Trim();
        if (string.IsNullOrWhiteSpace(rid))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "runId 不能为空"));
        var meta = await _runStore.GetRunAsync(RunKinds.Arena, rid, ct);
        if (meta == null)
            return NotFound(ApiResponse<object>.Fail("RUN_NOT_FOUND", "run 不存在或已过期"));
        return Ok(ApiResponse<object>.Ok(meta));
    }

    /// <summary>
    /// 取消 Run
    /// </summary>
    [HttpPost("runs/{runId}/cancel")]
    public async Task<IActionResult> CancelRun(string runId, CancellationToken ct)
    {
        var rid = (runId ?? "").Trim();
        if (string.IsNullOrWhiteSpace(rid))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "runId 不能为空"));
        await _runStore.TryMarkCancelRequestedAsync(RunKinds.Arena, rid, ct);
        return Ok(ApiResponse<object>.Ok(new { runId = rid, cancelRequested = true }));
    }

    /// <summary>
    /// 订阅竞技场 Run（SSE）：支持 afterSeq / Last-Event-ID 断线续传。
    /// </summary>
    [HttpGet("runs/{runId}/stream")]
    [Produces("text/event-stream")]
    public async Task StreamRun(string runId, [FromQuery] long afterSeq = 0, CancellationToken cancellationToken = default)
    {
        Response.ContentType = "text/event-stream";
        Response.Headers.CacheControl = "no-cache";
        Response.Headers.Connection = "keep-alive";

        var rid = (runId ?? "").Trim();
        if (string.IsNullOrWhiteSpace(rid))
        {
            await Response.WriteAsync("event: error\ndata: {\"errorCode\":\"INVALID_FORMAT\",\"errorMessage\":\"runId 不能为空\"}\n\n", cancellationToken);
            return;
        }

        if (afterSeq <= 0)
        {
            var last = (Request.Headers["Last-Event-ID"].FirstOrDefault() ?? "").Trim();
            if (long.TryParse(last, out var parsed) && parsed > 0) afterSeq = parsed;
        }

        // 1) snapshot
        var snap = await _runStore.GetSnapshotAsync(RunKinds.Arena, rid, cancellationToken);
        if (snap != null && snap.Seq > afterSeq)
        {
            await Response.WriteAsync($"id: {snap.Seq}\n", cancellationToken);
            await Response.WriteAsync("event: message\n", cancellationToken);
            await Response.WriteAsync($"data: {snap.SnapshotJson}\n\n", cancellationToken);
            await Response.Body.FlushAsync(cancellationToken);
            afterSeq = snap.Seq;
        }

        // 2) history + tail
        var lastKeepAliveAt = DateTime.UtcNow;
        while (!cancellationToken.IsCancellationRequested)
        {
            if ((DateTime.UtcNow - lastKeepAliveAt).TotalSeconds >= 10)
            {
                await Response.WriteAsync(": keepalive\n\n", cancellationToken);
                await Response.Body.FlushAsync(cancellationToken);
                lastKeepAliveAt = DateTime.UtcNow;
            }

            var batch = await _runStore.GetEventsAsync(RunKinds.Arena, rid, afterSeq, limit: 200, cancellationToken);
            if (batch.Count > 0)
            {
                foreach (var ev in batch)
                {
                    await Response.WriteAsync($"id: {ev.Seq}\n", cancellationToken);
                    await Response.WriteAsync("event: message\n", cancellationToken);
                    await Response.WriteAsync($"data: {ev.PayloadJson}\n\n", cancellationToken);
                    await Response.Body.FlushAsync(cancellationToken);
                    afterSeq = ev.Seq;
                    lastKeepAliveAt = DateTime.UtcNow;
                }
            }
            else
            {
                // Check if run is terminal — if so, stop the loop
                var meta = await _runStore.GetRunAsync(RunKinds.Arena, rid, CancellationToken.None);
                if (meta != null && meta.Status is RunStatuses.Done or RunStatuses.Error or RunStatuses.Cancelled)
                {
                    // Run completed + no more events → close SSE
                    break;
                }
                await Task.Delay(350, cancellationToken);
            }
        }
    }

    // ─────────────────────────── Battles ───────────────────────────

    /// <summary>
    /// 保存一次对战记录
    /// </summary>
    [HttpPost("battles")]
    public async Task<IActionResult> CreateBattle([FromBody] CreateArenaBattleRequest request, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(request.Prompt))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "prompt 不能为空"));
        if (string.IsNullOrWhiteSpace(request.GroupKey))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "groupKey 不能为空"));
        if (request.Responses == null || request.Responses.Count == 0)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "responses 不能为空"));

        var battle = new ArenaBattle
        {
            UserId = GetUserId(),
            Prompt = request.Prompt.Trim(),
            GroupKey = request.GroupKey.Trim(),
            Responses = request.Responses.Select(r => new ArenaBattleResponse
            {
                SlotId = r.SlotId?.Trim() ?? "",
                Label = r.Label?.Trim() ?? "",
                DisplayName = r.DisplayName?.Trim() ?? "",
                PlatformId = r.PlatformId?.Trim() ?? "",
                ModelId = r.ModelId?.Trim() ?? "",
                Content = r.Content?.Trim() ?? "",
                TtftMs = r.TtftMs,
                TotalMs = r.TotalMs,
                Status = r.Status?.Trim() ?? "done",
                ErrorMessage = r.ErrorMessage?.Trim()
            }).ToList(),
            Revealed = request.Revealed,
            CreatedAt = DateTime.UtcNow
        };

        await _db.ArenaBattles.InsertOneAsync(battle, cancellationToken: ct);

        return Ok(ApiResponse<object>.Ok(new { battle.Id }));
    }

    /// <summary>
    /// 获取当前用户的对战历史（分页）
    /// </summary>
    [HttpGet("battles")]
    public async Task<IActionResult> ListBattles([FromQuery] int page = 1, [FromQuery] int pageSize = 20, CancellationToken ct = default)
    {
        var userId = GetUserId();
        page = Math.Max(1, page);
        pageSize = Math.Clamp(pageSize, 1, 100);

        var filter = Builders<ArenaBattle>.Filter.Eq(b => b.UserId, userId);

        var total = await _db.ArenaBattles.CountDocumentsAsync(filter, cancellationToken: ct);

        var battles = await _db.ArenaBattles
            .Find(filter)
            .SortByDescending(b => b.CreatedAt)
            .Skip((page - 1) * pageSize)
            .Limit(pageSize)
            .ToListAsync(ct);

        var items = battles.Select(b => new
        {
            b.Id,
            Prompt = b.Prompt.Length > 50 ? b.Prompt[..50] : b.Prompt,
            b.GroupKey,
            b.Revealed,
            b.CreatedAt,
            ResponseCount = b.Responses.Count,
            HasAttachments = b.Attachments.Count > 0
        });

        return Ok(ApiResponse<object>.Ok(new { items, total, page, pageSize }));
    }

    /// <summary>
    /// 获取对战详情
    /// </summary>
    [HttpGet("battles/{id}")]
    public async Task<IActionResult> GetBattle(string id, CancellationToken ct)
    {
        var userId = GetUserId();

        var battle = await _db.ArenaBattles
            .Find(b => b.Id == id && b.UserId == userId)
            .FirstOrDefaultAsync(ct);

        if (battle == null)
            return NotFound(ApiResponse<object>.Fail("BATTLE_NOT_FOUND", "对战记录不存在"));

        return Ok(ApiResponse<object>.Ok(battle));
    }
}

// ─────────────────────────── Request DTOs ───────────────────────────

public class UpsertArenaGroupRequest
{
    public string? Key { get; set; }
    public string? Name { get; set; }
    public string? Description { get; set; }
    public string? Icon { get; set; }
    public int SortOrder { get; set; }
}

public class UpsertArenaSlotRequest
{
    public string? LogicalModelId { get; set; }
    public string? DisplayName { get; set; }
    public string? PlatformId { get; set; }
    public string? ModelId { get; set; }
    public string? Group { get; set; }
    public int? SortOrder { get; set; }
    public bool? Enabled { get; set; }
    public string? AvatarColor { get; set; }
    public string? Description { get; set; }
}

public class ArenaRevealRequest
{
    public List<string> SlotIds { get; set; } = new();
}

public class CreateArenaBattleRequest
{
    public string? Prompt { get; set; }
    public string? GroupKey { get; set; }
    public List<CreateArenaBattleResponseItem> Responses { get; set; } = new();
    public bool Revealed { get; set; }
    public List<string>? AttachmentIds { get; set; }
}

public class CreateArenaBattleResponseItem
{
    public string? SlotId { get; set; }
    public string? Label { get; set; }
    public string? DisplayName { get; set; }
    public string? PlatformId { get; set; }
    public string? ModelId { get; set; }
    public string? Content { get; set; }
    public int? TtftMs { get; set; }
    public int? TotalMs { get; set; }
    public string? Status { get; set; }
    public string? ErrorMessage { get; set; }
}

public class CreateArenaRunRequest
{
    public string? Prompt { get; set; }
    public string? GroupKey { get; set; }
    public List<CreateArenaRunSlotItem> Slots { get; set; } = new();
    public List<string>? AttachmentIds { get; set; }
}

public class CreateArenaRunSlotItem
{
    public string? SlotId { get; set; }
    public string? PlatformId { get; set; }
    public string? ModelId { get; set; }
    public string? Label { get; set; }
    public int LabelIndex { get; set; }
}
