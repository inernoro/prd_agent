using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Extensions;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.LlmGateway;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 个人任务树 — 分层任务管理 + 对话摘取任务 + 卡点上报。
/// </summary>
[ApiController]
[Route("api/task-tree")]
[Authorize]
[AdminController("task-tree-agent", AdminPermissionCatalog.TaskTreeUse)]
public class TaskTreeController : ControllerBase
{
    private readonly MongoDbContext _db;
    private readonly ILlmGateway _gateway;
    private readonly ILogger<TaskTreeController> _logger;

    public TaskTreeController(MongoDbContext db, ILlmGateway gateway, ILogger<TaskTreeController> logger)
    {
        _db = db;
        _gateway = gateway;
        _logger = logger;
    }

    private string GetUserId() => this.GetRequiredUserId();

    /// <summary>是否具备指定权限（中间件已把有效权限注入 permissions claim）。super 视为全通过。</summary>
    private bool HasPermission(string perm)
    {
        var permissions = User.FindAll("permissions").Select(c => c.Value).ToList();
        return permissions.Contains(perm) || permissions.Contains(AdminPermissionCatalog.Super);
    }

    // ─────────────────────────────────────────────
    // 任务树 CRUD
    // ─────────────────────────────────────────────

    /// <summary>创建任务树（自动建立根节点 = 创世支柱）</summary>
    [HttpPost("trees")]
    public async Task<IActionResult> CreateTree([FromBody] CreateTaskTreeRequest request)
    {
        var title = request.Title?.Trim();
        if (string.IsNullOrWhiteSpace(title))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "树标题不能为空"));

        var userId = GetUserId();
        var tree = new TaskTree
        {
            Title = title.Length > 60 ? title[..60] : title,
            Description = request.Description?.Trim(),
            OwnerId = userId,
            NodeCount = 1,
            MaxDepth = 0,
        };
        await _db.TaskTrees.InsertOneAsync(tree);

        var root = new TaskNode
        {
            TreeId = tree.Id,
            OwnerId = userId,
            ParentId = null,
            Title = tree.Title,
            Status = request.RootStatus is { } rs && TaskNodeStatus.IsValid(rs) ? rs : TaskNodeStatus.Building,
        };
        await _db.TaskNodes.InsertOneAsync(root);

        _logger.LogInformation("[task-tree] Tree created: {TreeId} '{Title}' by {UserId}", tree.Id, tree.Title, userId);
        return Ok(ApiResponse<object>.Ok(new { tree, root }));
    }

    /// <summary>列出当前用户的任务树</summary>
    [HttpGet("trees")]
    public async Task<IActionResult> ListTrees([FromQuery] bool includeArchived = false)
    {
        var userId = GetUserId();
        var fb = Builders<TaskTree>.Filter;
        var filter = fb.Eq(t => t.OwnerId, userId);
        if (!includeArchived)
            filter = fb.And(filter, fb.Eq(t => t.IsArchived, false));

        var items = await _db.TaskTrees.Find(filter).SortByDescending(t => t.UpdatedAt).ToListAsync();
        return Ok(ApiResponse<object>.Ok(new { items, total = items.Count }));
    }

    /// <summary>获取任务树详情（含所有节点）</summary>
    [HttpGet("trees/{treeId}")]
    public async Task<IActionResult> GetTree(string treeId)
    {
        var userId = GetUserId();
        var tree = await _db.TaskTrees.Find(t => t.Id == treeId && t.OwnerId == userId).FirstOrDefaultAsync();
        if (tree == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "任务树不存在"));

        var nodes = await _db.TaskNodes.Find(n => n.TreeId == treeId).SortBy(n => n.CreatedAt).ToListAsync();
        return Ok(ApiResponse<object>.Ok(new { tree, nodes }));
    }

    /// <summary>删除任务树（级联删除所有节点）</summary>
    [HttpDelete("trees/{treeId}")]
    public async Task<IActionResult> DeleteTree(string treeId)
    {
        var userId = GetUserId();
        var tree = await _db.TaskTrees.Find(t => t.Id == treeId && t.OwnerId == userId).FirstOrDefaultAsync();
        if (tree == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "任务树不存在"));

        await _db.TaskNodes.DeleteManyAsync(n => n.TreeId == treeId);
        await _db.TaskTrees.DeleteOneAsync(t => t.Id == treeId);
        return Ok(ApiResponse<object>.Ok(new { deleted = true }));
    }

    // ─────────────────────────────────────────────
    // 节点 CRUD
    // ─────────────────────────────────────────────

    /// <summary>在某棵树下创建任务节点</summary>
    [HttpPost("trees/{treeId}/nodes")]
    public async Task<IActionResult> CreateNode(string treeId, [FromBody] CreateTaskNodeRequest request)
    {
        var userId = GetUserId();
        var tree = await _db.TaskTrees.Find(t => t.Id == treeId && t.OwnerId == userId).FirstOrDefaultAsync();
        if (tree == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "任务树不存在"));

        var title = request.Title?.Trim();
        if (string.IsNullOrWhiteSpace(title))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "任务标题不能为空"));

        // 解析父节点：为空则挂到既有根，避免产生第二个无父根（前端布局只渲染一个根，多出的根会消失）
        string? parentId = string.IsNullOrEmpty(request.ParentId) ? null : request.ParentId;
        if (parentId == null)
        {
            var root = await _db.TaskNodes.Find(n => n.TreeId == treeId && n.ParentId == null).FirstOrDefaultAsync();
            parentId = root?.Id;
        }
        else
        {
            var parent = await _db.TaskNodes.Find(n => n.Id == parentId && n.TreeId == treeId).FirstOrDefaultAsync();
            if (parent == null)
                return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "父节点不存在或不属于该树"));
        }

        var status = TaskNodeStatus.IsValid(request.Status) ? request.Status! : TaskNodeStatus.Idea;
        var node = new TaskNode
        {
            TreeId = treeId,
            OwnerId = userId,
            ParentId = parentId,
            Title = title.Length > 120 ? title[..120] : title,
            Description = request.Description?.Trim(),
            Status = status,
            Blocker = status == TaskNodeStatus.Blocked ? request.Blocker?.Trim() : null,
            BlockedSince = status == TaskNodeStatus.Blocked ? DateTime.UtcNow : null,
            DependsOn = new List<string>(), // 依赖一律经 AddDependency 校验 + 防环添加，创建时不接受裸依赖
            Order = request.Order ?? 0,
        };
        await _db.TaskNodes.InsertOneAsync(node);
        await TouchTreeAsync(treeId, +1);

        return Ok(ApiResponse<object>.Ok(node));
    }

    /// <summary>更新节点（标题/描述/状态/卡点/父节点/排序）</summary>
    [HttpPut("nodes/{nodeId}")]
    public async Task<IActionResult> UpdateNode(string nodeId, [FromBody] UpdateTaskNodeRequest request)
    {
        var userId = GetUserId();
        var node = await _db.TaskNodes.Find(n => n.Id == nodeId && n.OwnerId == userId).FirstOrDefaultAsync();
        if (node == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "节点不存在"));

        var updates = new List<UpdateDefinition<TaskNode>>();
        var u = Builders<TaskNode>.Update;

        if (request.Title != null)
        {
            var t = request.Title.Trim();
            if (t.Length == 0) return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "标题不能为空"));
            updates.Add(u.Set(n => n.Title, t.Length > 120 ? t[..120] : t));
        }
        if (request.Description != null) updates.Add(u.Set(n => n.Description, request.Description.Trim()));
        if (request.Order.HasValue) updates.Add(u.Set(n => n.Order, request.Order.Value));
        if (request.PositionX.HasValue) updates.Add(u.Set(n => n.PositionX, request.PositionX.Value));
        if (request.PositionY.HasValue) updates.Add(u.Set(n => n.PositionY, request.PositionY.Value));

        if (request.ParentId != null)
        {
            var newParent = request.ParentId.Length == 0 ? null : request.ParentId;
            if (newParent == nodeId)
                return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "父节点不能是自己"));
            // 根节点不可改父节点：否则整棵树将失去 ParentId==null 的根，前端布局塌陷
            if (node.ParentId == null && newParent != null)
                return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "根节点（创世支柱）不能改父节点"));
            // 非根节点不可清空父节点：否则会产生第二个根，前端只渲染一个根，多出的节点消失
            if (node.ParentId != null && newParent == null)
                return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "不能把任务变成根节点（请改挂到其它父任务）"));
            if (newParent != null)
            {
                var p = await _db.TaskNodes.Find(n => n.Id == newParent && n.TreeId == node.TreeId).FirstOrDefaultAsync();
                if (p == null) return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "目标父节点不存在"));
                // 防环：新父节点不能是本节点的子孙
                var treeNodes = await _db.TaskNodes.Find(n => n.TreeId == node.TreeId).ToListAsync();
                var descendants = new HashSet<string> { nodeId };
                bool grew = true;
                while (grew)
                {
                    grew = false;
                    foreach (var tn in treeNodes)
                        if (tn.ParentId != null && descendants.Contains(tn.ParentId) && descendants.Add(tn.Id)) grew = true;
                }
                if (descendants.Contains(newParent))
                    return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "不能把节点移动到它自己的子任务之下（会形成环）"));
            }
            updates.Add(u.Set(n => n.ParentId, newParent));
        }

        if (request.Status != null)
        {
            if (!TaskNodeStatus.IsValid(request.Status))
                return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "非法状态值"));
            updates.Add(u.Set(n => n.Status, request.Status));
            if (request.Status == TaskNodeStatus.Blocked)
            {
                // 仅在请求带了 blocker 时才覆盖，避免点"卡点"pill（不带 blocker）把已有卡点描述清空
                if (request.Blocker != null)
                    updates.Add(u.Set(n => n.Blocker, request.Blocker.Trim()));
                // 仅在"刚进入 blocked"时记录起始时间，避免反复更新卡点描述把天数清零
                if (node.Status != TaskNodeStatus.Blocked || node.BlockedSince == null)
                    updates.Add(u.Set(n => n.BlockedSince, DateTime.UtcNow));
            }
            else
            {
                updates.Add(u.Set(n => n.Blocker, (string?)null));
                updates.Add(u.Set(n => n.BlockedSince, (DateTime?)null));
            }
        }
        else if (request.Blocker != null && node.Status == TaskNodeStatus.Blocked)
        {
            // 仅更新卡点描述，不动状态/起始时间
            updates.Add(u.Set(n => n.Blocker, request.Blocker.Trim()));
        }

        updates.Add(u.Set(n => n.UpdatedAt, DateTime.UtcNow));
        await _db.TaskNodes.UpdateOneAsync(n => n.Id == nodeId, u.Combine(updates));
        await TouchTreeAsync(node.TreeId, 0);

        // 重命名根节点（创世支柱）时同步树标题：树下拉/列表/ListTrees 用的是 TaskTree.Title
        if (request.Title != null && node.ParentId == null)
        {
            var rt = request.Title.Trim();
            if (rt.Length > 0)
                await _db.TaskTrees.UpdateOneAsync(t => t.Id == node.TreeId,
                    Builders<TaskTree>.Update.Set(t => t.Title, rt.Length > 60 ? rt[..60] : rt));
        }

        var updated = await _db.TaskNodes.Find(n => n.Id == nodeId).FirstOrDefaultAsync();
        return Ok(ApiResponse<object>.Ok(updated));
    }

    /// <summary>删除节点（级联删除其所有子孙节点）</summary>
    [HttpDelete("nodes/{nodeId}")]
    public async Task<IActionResult> DeleteNode(string nodeId)
    {
        var userId = GetUserId();
        var node = await _db.TaskNodes.Find(n => n.Id == nodeId && n.OwnerId == userId).FirstOrDefaultAsync();
        if (node == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "节点不存在"));
        if (node.ParentId == null)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "根节点不可删除，请删除整棵树"));

        // 收集子孙
        var all = await _db.TaskNodes.Find(n => n.TreeId == node.TreeId).ToListAsync();
        var toDelete = new HashSet<string> { nodeId };
        bool changed = true;
        while (changed)
        {
            changed = false;
            foreach (var n in all)
            {
                if (n.ParentId != null && toDelete.Contains(n.ParentId) && !toDelete.Contains(n.Id))
                {
                    toDelete.Add(n.Id);
                    changed = true;
                }
            }
        }
        await _db.TaskNodes.DeleteManyAsync(n => toDelete.Contains(n.Id));
        // 清理指向被删节点的依赖引用
        await _db.TaskNodes.UpdateManyAsync(
            n => n.OwnerId == userId,
            Builders<TaskNode>.Update.PullAll(n => n.DependsOn, toDelete));
        await TouchTreeAsync(node.TreeId, -toDelete.Count);

        return Ok(ApiResponse<object>.Ok(new { deleted = toDelete.Count }));
    }

    // ─────────────────────────────────────────────
    // 依赖关系（DAG）
    // ─────────────────────────────────────────────

    /// <summary>为节点添加一条前置依赖</summary>
    [HttpPost("nodes/{nodeId}/dependencies")]
    public async Task<IActionResult> AddDependency(string nodeId, [FromBody] DependencyRequest request)
    {
        var userId = GetUserId();
        var depId = request.DependsOnId?.Trim();
        if (string.IsNullOrEmpty(depId))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "依赖节点 ID 不能为空"));
        if (depId == nodeId)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "不能依赖自己"));

        var node = await _db.TaskNodes.Find(n => n.Id == nodeId && n.OwnerId == userId).FirstOrDefaultAsync();
        if (node == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "节点不存在"));
        var dep = await _db.TaskNodes.Find(n => n.Id == depId && n.OwnerId == userId).FirstOrDefaultAsync();
        if (dep == null)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "依赖的节点不存在"));

        // 防环：DependsOn 是 DAG。若 depId 已（直接或间接）依赖 nodeId，再加 node→depId 会成环。
        var ownerNodes = await _db.TaskNodes.Find(n => n.OwnerId == userId).ToListAsync();
        var depMap = ownerNodes.ToDictionary(n => n.Id, n => n.DependsOn ?? new List<string>());
        var seen = new HashSet<string>();
        var stack = new Stack<string>();
        stack.Push(depId);
        while (stack.Count > 0)
        {
            var cur = stack.Pop();
            if (!seen.Add(cur)) continue;
            if (cur == nodeId)
                return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "该依赖会形成循环依赖"));
            if (depMap.TryGetValue(cur, out var ds))
                foreach (var d in ds) stack.Push(d);
        }

        await _db.TaskNodes.UpdateOneAsync(n => n.Id == nodeId,
            Builders<TaskNode>.Update.AddToSet(n => n.DependsOn, depId).Set(n => n.UpdatedAt, DateTime.UtcNow));
        return Ok(ApiResponse<object>.Ok(new { added = true }));
    }

    /// <summary>移除一条前置依赖</summary>
    [HttpDelete("nodes/{nodeId}/dependencies/{dependsOnId}")]
    public async Task<IActionResult> RemoveDependency(string nodeId, string dependsOnId)
    {
        var userId = GetUserId();
        var node = await _db.TaskNodes.Find(n => n.Id == nodeId && n.OwnerId == userId).FirstOrDefaultAsync();
        if (node == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "节点不存在"));

        await _db.TaskNodes.UpdateOneAsync(n => n.Id == nodeId,
            Builders<TaskNode>.Update.Pull(n => n.DependsOn, dependsOnId).Set(n => n.UpdatedAt, DateTime.UtcNow));
        return Ok(ApiResponse<object>.Ok(new { removed = true }));
    }

    // ─────────────────────────────────────────────
    // 卡点上报（卡点墙）
    // ─────────────────────────────────────────────

    /// <summary>
    /// 卡点清单，按卡住时长降序（卡最久的在前）。
    /// scope=mine（默认）只看本人；scope=all 聚合所有人的卡点（需 task-tree.view-all 权限，给上级看）。
    /// </summary>
    [HttpGet("blockers")]
    public async Task<IActionResult> ListBlockers([FromQuery] string scope = "mine")
    {
        var userId = GetUserId();
        var canViewAll = HasPermission(AdminPermissionCatalog.TaskTreeViewAll);
        var allScope = scope == "all" && canViewAll;

        var nodeFilter = allScope
            ? Builders<TaskNode>.Filter.Empty
            : Builders<TaskNode>.Filter.Eq(n => n.OwnerId, userId);

        var blockedFilter = Builders<TaskNode>.Filter.And(
            nodeFilter,
            Builders<TaskNode>.Filter.Eq(n => n.Status, TaskNodeStatus.Blocked));
        var blocked = await _db.TaskNodes.Find(blockedFilter).ToListAsync();

        // 下游引用 + 树标题 + 负责人：按 scope 取相应范围
        var scopedNodes = await _db.TaskNodes.Find(nodeFilter).ToListAsync();
        var treeIds = blocked.Select(n => n.TreeId).Distinct().ToList();
        var trees = await _db.TaskTrees.Find(t => treeIds.Contains(t.Id)).ToListAsync();
        var treeTitles = trees.ToDictionary(t => t.Id, t => t.Title);

        var ownerIds = blocked.Select(n => n.OwnerId).Distinct().ToList();
        var owners = await _db.Users.Find(u => ownerIds.Contains(u.UserId)).ToListAsync();
        var ownerNames = owners.ToDictionary(u => u.UserId, u => string.IsNullOrEmpty(u.DisplayName) ? u.Username : u.DisplayName);

        var now = DateTime.UtcNow;
        var items = blocked
            .Select(n => new
            {
                node = n,
                ownerName = ownerNames.TryGetValue(n.OwnerId, out var on) ? on : "",
                treeTitle = treeTitles.TryGetValue(n.TreeId, out var tt) ? tt : "",
                stuckDays = n.BlockedSince.HasValue ? (int)Math.Floor((now - n.BlockedSince.Value).TotalDays) : 0,
                blocks = scopedNodes.Where(x => x.DependsOn != null && x.DependsOn.Contains(n.Id)).Select(x => x.Title).ToList(),
            })
            .OrderByDescending(x => x.stuckDays)
            .ToList();

        return Ok(ApiResponse<object>.Ok(new { items, total = items.Count, canViewAll, scope = allScope ? "all" : "mine" }));
    }

    // ─────────────────────────────────────────────
    // 对话摘取任务（SSE 流式）
    // ─────────────────────────────────────────────

    /// <summary>把一段自然语言描述用 LLM 解析成任务节点，SSE 流式返回过程与结果</summary>
    [HttpPost("trees/{treeId}/extract")]
    [Produces("text/event-stream")]
    public async Task ExtractNode(string treeId, [FromBody] ExtractTaskRequest request)
    {
        var userId = GetUserId();
        var tree = await _db.TaskTrees.Find(t => t.Id == treeId && t.OwnerId == userId).FirstOrDefaultAsync();
        if (tree == null)
        {
            Response.StatusCode = 404;
            return;
        }

        Response.ContentType = "text/event-stream; charset=utf-8";
        Response.Headers.CacheControl = "no-cache";

        var text = request.Text?.Trim() ?? "";
        if (text.Length == 0)
        {
            await WriteSseEvent("error", new { message = "描述不能为空" });
            await WriteSseEvent("done", new { });
            return;
        }

        // 校验挂载父节点
        TaskNode? parent = null;
        if (!string.IsNullOrEmpty(request.ParentId))
            parent = await _db.TaskNodes.Find(n => n.Id == request.ParentId && n.TreeId == treeId).FirstOrDefaultAsync();
        parent ??= await _db.TaskNodes.Find(n => n.TreeId == treeId && n.ParentId == null).FirstOrDefaultAsync();

        await WriteSseEvent("stage", new { stage = "analyzing", message = "正在分析你的描述…" });

        var systemPrompt =
            "你是个人任务管理助手。把用户的一句话拆解成一个任务节点，只输出严格 JSON，" +
            "字段：title(string, 不超过16字的精炼任务名)、status(idea/planned/building/done/blocked 之一)、" +
            "blocker(string, 仅当 status=blocked 时填写卡点原因，否则空字符串)。" +
            "判断规则：含'卡/阻塞/等待/审批/配额'类词→blocked；'完成/上线/搞定'→done；" +
            "'在做/进行中'→building；'计划/准备/下周/打算'→planned；否则 idea。不要输出 JSON 以外的任何内容。";
        var userMessage = $"挂载到任务「{parent?.Title ?? tree.Title}」之下。用户描述：{text}";

        var gReq = new GatewayRequest
        {
            AppCallerCode = AppCallerRegistry.TaskTreeAgent.Extract.Chat,
            ModelType = ModelTypes.Chat,
            RequestBody = new JsonObject
            {
                ["messages"] = new JsonArray
                {
                    new JsonObject { ["role"] = "system", ["content"] = systemPrompt },
                    new JsonObject { ["role"] = "user", ["content"] = userMessage },
                },
                ["temperature"] = 0.3,
                ["include_reasoning"] = true,
                ["reasoning"] = new JsonObject { ["exclude"] = false },
            },
            TimeoutSeconds = 60,
            IncludeThinking = true,
            Context = new GatewayRequestContext { UserId = userId },
        };

        var buffer = new StringBuilder();
        string? llmError = null;
        try
        {
            await foreach (var chunk in _gateway.StreamAsync(gReq, CancellationToken.None))
            {
                if (chunk.Type == GatewayChunkType.Error)
                {
                    llmError = chunk.Error ?? "LLM 调用失败";
                    break;
                }
                if (chunk.Type == GatewayChunkType.Thinking && !string.IsNullOrEmpty(chunk.Content))
                {
                    await WriteSseEvent("thinking", new { text = chunk.Content });
                    continue;
                }
                if (chunk.Type == GatewayChunkType.Text && !string.IsNullOrEmpty(chunk.Content))
                {
                    buffer.Append(chunk.Content);
                    await WriteSseEvent("typing", new { text = chunk.Content });
                }
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[task-tree] extract LLM stream failed");
            llmError = "LLM 调用异常: " + ex.Message;
        }

        if (llmError != null)
        {
            await WriteSseEvent("error", new { message = llmError });
            await WriteSseEvent("done", new { });
            return;
        }

        var parsed = ParseExtraction(buffer.ToString());
        var status = TaskNodeStatus.IsValid(parsed.Status) ? parsed.Status! : TaskNodeStatus.Idea;
        var title = string.IsNullOrWhiteSpace(parsed.Title)
            ? (text.Length > 16 ? text[..16] : text)
            : parsed.Title!.Trim();

        var node = new TaskNode
        {
            TreeId = treeId,
            OwnerId = userId,
            ParentId = parent?.Id,
            Title = title.Length > 120 ? title[..120] : title,
            Status = status,
            Blocker = status == TaskNodeStatus.Blocked
                ? (string.IsNullOrWhiteSpace(parsed.Blocker) ? text : parsed.Blocker!.Trim())
                : null,
            BlockedSince = status == TaskNodeStatus.Blocked ? DateTime.UtcNow : null,
        };
        await _db.TaskNodes.InsertOneAsync(node);
        await TouchTreeAsync(treeId, +1);

        await WriteSseEvent("node", node);
        await WriteSseEvent("done", new { nodeId = node.Id });
    }

    // ─────────────────────────────────────────────
    // 辅助
    // ─────────────────────────────────────────────

    private async Task TouchTreeAsync(string treeId, int nodeCountDelta)
    {
        var u = Builders<TaskTree>.Update.Set(t => t.UpdatedAt, DateTime.UtcNow);
        if (nodeCountDelta != 0) u = u.Inc(t => t.NodeCount, nodeCountDelta);
        await _db.TaskTrees.UpdateOneAsync(t => t.Id == treeId, u);
    }

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

    private static ExtractionResult ParseExtraction(string raw)
    {
        var s = raw.Trim();
        // 去掉可能的 ```json 代码围栏
        if (s.StartsWith("```"))
        {
            var nl = s.IndexOf('\n');
            if (nl >= 0) s = s[(nl + 1)..];
            if (s.EndsWith("```")) s = s[..^3];
        }
        var start = s.IndexOf('{');
        var end = s.LastIndexOf('}');
        if (start >= 0 && end > start) s = s[start..(end + 1)];

        try
        {
            using var doc = JsonDocument.Parse(s);
            var root = doc.RootElement;
            return new ExtractionResult
            {
                Title = root.TryGetProperty("title", out var t) ? t.GetString() : null,
                Status = root.TryGetProperty("status", out var st) ? st.GetString() : null,
                Blocker = root.TryGetProperty("blocker", out var b) ? b.GetString() : null,
            };
        }
        catch
        {
            return new ExtractionResult();
        }
    }

    private class ExtractionResult
    {
        public string? Title { get; set; }
        public string? Status { get; set; }
        public string? Blocker { get; set; }
    }
}

// ─────────────────────────────────────────────
// 请求模型
// ─────────────────────────────────────────────

public class CreateTaskTreeRequest
{
    public string? Title { get; set; }
    public string? Description { get; set; }
    public string? RootStatus { get; set; }
}

public class CreateTaskNodeRequest
{
    public string? ParentId { get; set; }
    public string? Title { get; set; }
    public string? Description { get; set; }
    public string? Status { get; set; }
    public string? Blocker { get; set; }
    public List<string>? DependsOn { get; set; }
    public int? Order { get; set; }
}

public class UpdateTaskNodeRequest
{
    public string? Title { get; set; }
    public string? Description { get; set; }
    public string? Status { get; set; }
    public string? Blocker { get; set; }
    public string? ParentId { get; set; }
    public int? Order { get; set; }
    public double? PositionX { get; set; }
    public double? PositionY { get; set; }
}

public class DependencyRequest
{
    public string? DependsOnId { get; set; }
}

public class ExtractTaskRequest
{
    public string? Text { get; set; }
    public string? ParentId { get; set; }
}
