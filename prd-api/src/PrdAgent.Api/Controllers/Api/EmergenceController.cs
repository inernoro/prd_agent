using System.Text.Json;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Extensions;
using PrdAgent.Api.Services;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 涌现探索器 — 可视化功能涌现与创意探索
/// </summary>
[ApiController]
[Route("api/emergence")]
[Authorize]
[AdminController("emergence", AdminPermissionCatalog.EmergenceRead,
    WritePermission = AdminPermissionCatalog.EmergenceWrite)]
public class EmergenceController : ControllerBase
{
    private readonly MongoDbContext _db;
    private readonly EmergenceService _emergenceService;
    private readonly ILogger<EmergenceController> _logger;

    public EmergenceController(
        MongoDbContext db,
        EmergenceService emergenceService,
        ILogger<EmergenceController> logger)
    {
        _db = db;
        _emergenceService = emergenceService;
        _logger = logger;
    }

    private string GetUserId() => this.GetRequiredUserId();

    // ─────────────────────────────────────────────
    // 涌现树 CRUD
    // ─────────────────────────────────────────────

    /// <summary>创建涌现树（从种子内容出发）</summary>
    [HttpPost("trees")]
    public async Task<IActionResult> CreateTree([FromBody] CreateEmergenceTreeRequest request)
    {
        if (string.IsNullOrWhiteSpace(request.SeedContent))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "种子内容不能为空"));

        var userId = GetUserId();

        var tree = new EmergenceTree
        {
            Title = request.Title?.Trim() ?? request.SeedContent.Trim()[..Math.Min(50, request.SeedContent.Trim().Length)],
            Description = request.Description?.Trim(),
            SeedContent = request.SeedContent.Trim(),
            SeedSourceType = request.SeedSourceType ?? EmergenceSeedSourceType.Text,
            SeedSourceId = request.SeedSourceId,
            OwnerId = userId,
            InjectSystemCapabilities = request.InjectSystemCapabilities,
            NodeCount = 1,
            MaxDepth = 0,
        };

        await _db.EmergenceTrees.InsertOneAsync(tree);

        // 创建种子节点
        var seedNode = new EmergenceNode
        {
            TreeId = tree.Id,
            Title = tree.Title,
            Description = request.SeedContent.Trim(),
            GroundingContent = request.SeedContent.Trim(),
            GroundingType = request.SeedSourceType == EmergenceSeedSourceType.Document
                ? EmergenceGroundingType.Document
                : EmergenceGroundingType.UserInput,
            GroundingRef = request.SeedSourceId,
            Dimension = 1,
            NodeType = EmergenceNodeType.Seed,
            ValueScore = 5,
            DifficultyScore = 1,
            Status = EmergenceNodeStatus.Done,
        };

        await _db.EmergenceNodes.InsertOneAsync(seedNode);

        _logger.LogInformation("[emergence] Tree created: {TreeId} '{Title}' by {UserId}",
            tree.Id, tree.Title, userId);

        return Ok(ApiResponse<object>.Ok(new { tree, seedNode }));
    }

    /// <summary>获取涌现树列表</summary>
    [HttpGet("trees")]
    public async Task<IActionResult> ListTrees([FromQuery] int page = 1, [FromQuery] int pageSize = 20)
    {
        var userId = GetUserId();
        pageSize = Math.Clamp(pageSize, 1, 100);
        page = Math.Max(1, page);

        var filter = Builders<EmergenceTree>.Filter.Eq(t => t.OwnerId, userId);
        var total = await _db.EmergenceTrees.CountDocumentsAsync(filter);
        var items = await _db.EmergenceTrees.Find(filter)
            .SortByDescending(t => t.UpdatedAt)
            .Skip((page - 1) * pageSize)
            .Limit(pageSize)
            .ToListAsync();

        return Ok(ApiResponse<object>.Ok(new { items, total, page, pageSize }));
    }

    /// <summary>获取涌现树详情（含所有节点）</summary>
    [HttpGet("trees/{treeId}")]
    public async Task<IActionResult> GetTree(string treeId)
    {
        var userId = GetUserId();

        var tree = await _db.EmergenceTrees
            .Find(t => t.Id == treeId && (t.OwnerId == userId || t.IsPublic))
            .FirstOrDefaultAsync();

        if (tree == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "涌现树不存在"));

        var nodes = await _db.EmergenceNodes
            .Find(n => n.TreeId == treeId)
            .SortBy(n => n.CreatedAt)
            .ToListAsync();

        return Ok(ApiResponse<object>.Ok(new { tree, nodes }));
    }

    /// <summary>删除涌现树（级联删除所有节点）</summary>
    [HttpDelete("trees/{treeId}")]
    public async Task<IActionResult> DeleteTree(string treeId)
    {
        var userId = GetUserId();

        var result = await _db.EmergenceTrees.DeleteOneAsync(
            t => t.Id == treeId && t.OwnerId == userId);

        if (result.DeletedCount == 0)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "涌现树不存在"));

        await _db.EmergenceNodes.DeleteManyAsync(n => n.TreeId == treeId);

        _logger.LogInformation("[emergence] Tree deleted: {TreeId} by {UserId}", treeId, userId);

        return Ok(ApiResponse<object>.Ok(new { deleted = true }));
    }

    /// <summary>取消公开（将涌现树从公开状态撤回为私有）</summary>
    [HttpPost("trees/{treeId}/unpublish")]
    public async Task<IActionResult> UnpublishTree(string treeId, CancellationToken ct)
    {
        var userId = GetUserId();
        var tree = await _db.EmergenceTrees.Find(t => t.Id == treeId).FirstOrDefaultAsync(ct);
        if (tree == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "涌现树不存在"));
        if (tree.OwnerId != userId)
            return StatusCode(StatusCodes.Status403Forbidden, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "无权限"));

        var update = Builders<EmergenceTree>.Update
            .Set(t => t.IsPublic, false)
            .Set(t => t.UpdatedAt, DateTime.UtcNow);
        await _db.EmergenceTrees.UpdateOneAsync(t => t.Id == treeId, update, cancellationToken: ct);

        _logger.LogInformation("[emergence] Tree unpublished: {TreeId} by {UserId}", treeId, userId);
        return Ok(ApiResponse<object>.Ok(new { id = treeId, isPublic = false }));
    }

    // ─────────────────────────────────────────────
    // 节点操作
    // ─────────────────────────────────────────────

    /// <summary>更新节点（编辑/移动/标记状态）</summary>
    [HttpPut("nodes/{nodeId}")]
    public async Task<IActionResult> UpdateNode(string nodeId, [FromBody] UpdateEmergenceNodeRequest request)
    {
        var userId = GetUserId();

        var node = await _db.EmergenceNodes
            .Find(n => n.Id == nodeId)
            .FirstOrDefaultAsync();

        if (node == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "节点不存在"));

        // 验证树归属
        var tree = await _db.EmergenceTrees
            .Find(t => t.Id == node.TreeId && t.OwnerId == userId)
            .FirstOrDefaultAsync();

        if (tree == null)
            return Forbid();

        var update = Builders<EmergenceNode>.Update.Combine();
        if (request.Title != null)
            update = update.Set(n => n.Title, request.Title.Trim());
        if (request.Description != null)
            update = update.Set(n => n.Description, request.Description.Trim());
        if (request.Status != null)
            update = update.Set(n => n.Status, request.Status);
        if (request.PositionX.HasValue)
            update = update.Set(n => n.PositionX, request.PositionX.Value);
        if (request.PositionY.HasValue)
            update = update.Set(n => n.PositionY, request.PositionY.Value);
        if (request.Tags != null)
            update = update.Set(n => n.Tags, request.Tags);

        await _db.EmergenceNodes.UpdateOneAsync(n => n.Id == nodeId, update);

        return Ok(ApiResponse<object>.Ok(new { updated = true }));
    }

    /// <summary>删除节点（级联删除子树）</summary>
    [HttpDelete("nodes/{nodeId}")]
    public async Task<IActionResult> DeleteNode(string nodeId)
    {
        var userId = GetUserId();

        var node = await _db.EmergenceNodes.Find(n => n.Id == nodeId).FirstOrDefaultAsync();
        if (node == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "节点不存在"));

        // 种子节点不可删除
        if (node.NodeType == EmergenceNodeType.Seed)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "种子节点不可删除"));

        var tree = await _db.EmergenceTrees
            .Find(t => t.Id == node.TreeId && t.OwnerId == userId)
            .FirstOrDefaultAsync();
        if (tree == null) return Forbid();

        // 收集需要删除的所有子节点 ID（BFS）
        var toDelete = new List<string> { nodeId };
        var queue = new Queue<string>();
        queue.Enqueue(nodeId);

        while (queue.Count > 0)
        {
            var parentId = queue.Dequeue();
            var children = await _db.EmergenceNodes
                .Find(n => n.TreeId == node.TreeId && n.ParentId == parentId)
                .Project(n => n.Id)
                .ToListAsync();
            foreach (var childId in children)
            {
                toDelete.Add(childId);
                queue.Enqueue(childId);
            }
        }

        var deleteResult = await _db.EmergenceNodes.DeleteManyAsync(
            n => toDelete.Contains(n.Id));

        await _db.EmergenceTrees.UpdateOneAsync(
            t => t.Id == node.TreeId,
            Builders<EmergenceTree>.Update
                .Inc(t => t.NodeCount, -(int)deleteResult.DeletedCount)
                .Set(t => t.UpdatedAt, DateTime.UtcNow));

        return Ok(ApiResponse<object>.Ok(new { deletedCount = deleteResult.DeletedCount }));
    }

    // ─────────────────────────────────────────────
    // 探索与涌现（SSE 流式）
    // ─────────────────────────────────────────────

    /// <summary>探索节点（一维，SSE 流式返回新生长的子节点）</summary>
    [HttpPost("nodes/{nodeId}/explore")]
    [Produces("text/event-stream")]
    public async Task ExploreNode(string nodeId)
    {
        var userId = GetUserId();

        var node = await _db.EmergenceNodes.Find(n => n.Id == nodeId).FirstOrDefaultAsync();
        if (node == null)
        {
            Response.StatusCode = 404;
            return;
        }

        var tree = await _db.EmergenceTrees
            .Find(t => t.Id == node.TreeId && t.OwnerId == userId)
            .FirstOrDefaultAsync();
        if (tree == null)
        {
            Response.StatusCode = 403;
            return;
        }

        Response.ContentType = "text/event-stream; charset=utf-8";
        Response.Headers.CacheControl = "no-cache";

        // 阶段提示：开始探索
        await WriteSseEvent("stage", new { stage = "exploring", message = "正在基于现实锚点探索子能力…" });

        string? llmError = null;
        var count = 0;
        await foreach (var newNode in _emergenceService.ExploreAsync(
            node.TreeId, nodeId, userId,
            onError: err => llmError = err))
        {
            count++;
            await WriteSseEvent("node", newNode);
            await WriteSseEvent("stage", new { stage = "growing", message = $"已生长 {count} 个节点…" });
        }

        if (llmError != null)
        {
            await WriteSseEvent("error", new { message = llmError });
        }
        await WriteSseEvent("done", new { totalNew = count, error = llmError });
    }

    /// <summary>涌现（二维+三维，SSE 流式返回新组合的节点）</summary>
    [HttpPost("trees/{treeId}/emerge")]
    [Produces("text/event-stream")]
    public async Task EmergeTree(string treeId, [FromQuery] bool fantasy = false)
    {
        var userId = GetUserId();

        var tree = await _db.EmergenceTrees
            .Find(t => t.Id == treeId && t.OwnerId == userId)
            .FirstOrDefaultAsync();
        if (tree == null)
        {
            Response.StatusCode = 404;
            return;
        }

        Response.ContentType = "text/event-stream; charset=utf-8";
        Response.Headers.CacheControl = "no-cache";

        var dimensionLabel = fantasy ? "三维幻想" : "二维跨系统";
        await WriteSseEvent("stage", new { stage = "emerging", message = $"正在进行{dimensionLabel}涌现…" });

        string? llmError = null;
        var count = 0;
        await foreach (var newNode in _emergenceService.EmergeAsync(
            treeId, fantasy, userId,
            onError: err => llmError = err))
        {
            count++;
            await WriteSseEvent("node", newNode);
            await WriteSseEvent("stage", new { stage = "combining", message = $"已涌现 {count} 个组合节点…" });
        }

        if (llmError != null)
        {
            await WriteSseEvent("error", new { message = llmError });
        }
        await WriteSseEvent("done", new { totalNew = count, dimension = fantasy ? 3 : 2, error = llmError });
    }

    /// <summary>导出涌现树为 Markdown</summary>
    [HttpGet("trees/{treeId}/export")]
    public async Task<IActionResult> ExportTree(string treeId)
    {
        var userId = GetUserId();

        var tree = await _db.EmergenceTrees
            .Find(t => t.Id == treeId && (t.OwnerId == userId || t.IsPublic))
            .FirstOrDefaultAsync();

        if (tree == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "涌现树不存在"));

        var nodes = await _db.EmergenceNodes
            .Find(n => n.TreeId == treeId)
            .SortBy(n => n.CreatedAt)
            .ToListAsync();

        var md = ExportToMarkdown(tree, nodes);
        return Ok(ApiResponse<object>.Ok(new { markdown = md }));
    }

    // ── SSE 工具 ──

    private async Task WriteSseEvent(string eventName, object data)
    {
        try
        {
            var json = JsonSerializer.Serialize(data, new JsonSerializerOptions
            {
                PropertyNamingPolicy = JsonNamingPolicy.CamelCase
            });
            await Response.WriteAsync($"event: {eventName}\ndata: {json}\n\n");
            await Response.Body.FlushAsync();
        }
        catch (ObjectDisposedException) { }
        catch (OperationCanceledException) { }
    }

    // ── Markdown 导出 ──

    private static string ExportToMarkdown(EmergenceTree tree, List<EmergenceNode> nodes)
    {
        var sb = new System.Text.StringBuilder();
        sb.AppendLine($"# {tree.Title}");
        sb.AppendLine();
        if (!string.IsNullOrEmpty(tree.Description))
            sb.AppendLine($"> {tree.Description}");
        sb.AppendLine();
        sb.AppendLine($"节点数：{nodes.Count} | 创建于：{tree.CreatedAt:yyyy-MM-dd}");
        sb.AppendLine();

        var dimensionLabels = new Dictionary<int, string> { [1] = "一维·系统内", [2] = "二维·跨系统", [3] = "三维·幻想" };

        foreach (var group in nodes.GroupBy(n => n.Dimension).OrderBy(g => g.Key))
        {
            var label = dimensionLabels.GetValueOrDefault(group.Key, $"维度 {group.Key}");
            sb.AppendLine($"## {label}");
            sb.AppendLine();

            foreach (var node in group)
            {
                var statusIcon = node.Status switch
                {
                    EmergenceNodeStatus.Done => "[x]",
                    EmergenceNodeStatus.Building => "[-]",
                    EmergenceNodeStatus.Planned => "[ ]",
                    _ => "[ ]"
                };
                sb.AppendLine($"- {statusIcon} **{node.Title}** (价值:{node.ValueScore} 难度:{node.DifficultyScore})");
                sb.AppendLine($"  - {node.Description}");
                if (!string.IsNullOrEmpty(node.GroundingContent))
                    sb.AppendLine($"  - 锚点：{node.GroundingContent}");
                if (node.BridgeAssumptions.Count > 0)
                    sb.AppendLine($"  - 假设：{string.Join("；", node.BridgeAssumptions)}");
                sb.AppendLine();
            }
        }

        return sb.ToString();
    }
}

// ── 请求模型 ──

public class CreateEmergenceTreeRequest
{
    public string? Title { get; set; }
    public string? Description { get; set; }
    public string SeedContent { get; set; } = string.Empty;
    public string? SeedSourceType { get; set; }
    public string? SeedSourceId { get; set; }
    /// <summary>是否注入本系统能力（分析本系统时开启，分析外部系统时关闭）</summary>
    public bool InjectSystemCapabilities { get; set; }
}

public class UpdateEmergenceNodeRequest
{
    public string? Title { get; set; }
    public string? Description { get; set; }
    public string? Status { get; set; }
    public double? PositionX { get; set; }
    public double? PositionY { get; set; }
    public List<string>? Tags { get; set; }
}
