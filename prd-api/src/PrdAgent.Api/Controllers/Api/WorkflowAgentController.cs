using System.Security.Claims;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Core.Interfaces;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.LlmGateway;
using PrdAgent.Api.Services;

namespace PrdAgent.Api.Controllers.Api;

[ApiController]
[Route("api/workflow-agent")]
[Authorize]
[AdminController("workflow-agent", AdminPermissionCatalog.WorkflowAgentUse, WritePermission = AdminPermissionCatalog.WorkflowAgentManage)]
public class WorkflowAgentController : ControllerBase
{
    private const string AppKey = "workflow-agent";

    private readonly MongoDbContext _db;
    private readonly IRunQueue _runQueue;
    private readonly IRunEventStore _eventStore;
    private readonly ILlmGateway _gateway;
    private readonly ILogger<WorkflowAgentController> _logger;

    public WorkflowAgentController(
        MongoDbContext db,
        IRunQueue runQueue,
        IRunEventStore eventStore,
        ILlmGateway gateway,
        ILogger<WorkflowAgentController> logger)
    {
        _db = db;
        _runQueue = runQueue;
        _eventStore = eventStore;
        _gateway = gateway;
        _logger = logger;
    }

    // ─────────────────────────────────────────────────────────
    // 舱类型注册表
    // ─────────────────────────────────────────────────────────

    /// <summary>获取所有可用的舱类型（含元数据、配置 Schema、默认插槽）</summary>
    [HttpGet("capsule-types")]
    public IActionResult ListCapsuleTypes([FromQuery] string? category)
    {
        IEnumerable<CapsuleTypeMeta> types = CapsuleTypeRegistry.All;

        if (!string.IsNullOrWhiteSpace(category))
            types = types.Where(t => t.Category == category);

        return Ok(ApiResponse<object>.Ok(new
        {
            items = types,
            categories = new[]
            {
                new { key = CapsuleCategory.Trigger, label = "触发", description = "流水线的起点，负责产生触发信号" },
                new { key = CapsuleCategory.Processor, label = "处理", description = "数据采集、分析、转换" },
                new { key = CapsuleCategory.Control, label = "流程控制", description = "延时、条件分支等流程控制" },
                new { key = CapsuleCategory.Output, label = "输出", description = "结果输出、通知、导出" },
            }
        }));
    }

    /// <summary>获取单个舱类型详情</summary>
    [HttpGet("capsule-types/{typeKey}")]
    public IActionResult GetCapsuleType(string typeKey)
    {
        var meta = CapsuleTypeRegistry.Get(typeKey);
        if (meta == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, $"未知的舱类型: {typeKey}"));

        return Ok(ApiResponse<object>.Ok(new { capsuleType = meta }));
    }

    /// <summary>
    /// 单舱测试运行：传入舱类型 + 配置，直接执行舱逻辑，返回实际运行结果。
    /// 不做必填校验——填了什么就用什么，让执行引擎自然报错。
    /// </summary>
    [HttpPost("capsules/test-run")]
    public async Task<IActionResult> TestRunCapsule(
        [FromBody] CapsuleTestRunRequest request,
        CancellationToken ct = default)
    {
        var meta = CapsuleTypeRegistry.Get(request.TypeKey);
        if (meta == null)
            return BadRequest(ApiResponse<object>.Fail("UNKNOWN_CAPSULE_TYPE", $"未知的舱类型: {request.TypeKey}"));

        if (!meta.Testable)
            return BadRequest(ApiResponse<object>.Fail("NOT_TESTABLE", $"舱类型 '{meta.Name}' 不支持单独测试运行"));

        var startedAt = DateTime.UtcNow;

        // 构造临时 WorkflowNode，用于执行
        var testNode = new WorkflowNode
        {
            NodeId = "test-" + Guid.NewGuid().ToString("N")[..8],
            Name = $"[测试] {meta.Name}",
            NodeType = request.TypeKey,
            Config = new Dictionary<string, object?>(),
            OutputSlots = meta.DefaultOutputSlots?.Select(s => new ArtifactSlot
            {
                SlotId = s.SlotId,
                Name = s.Name,
                DataType = s.DataType,
            }).ToList() ?? new List<ArtifactSlot>(),
        };

        // 将请求配置填入节点
        if (request.Config != null)
        {
            foreach (var (k, v) in request.Config)
                testNode.Config[k] = v;
        }

        // 构造模拟输入产物（如果前端提供了 mockInput）
        var mockInputArtifacts = new List<ExecutionArtifact>();
        if (request.MockInput != null)
        {
            var inputJson = request.MockInput is string s ? s : System.Text.Json.JsonSerializer.Serialize(request.MockInput);
            mockInputArtifacts.Add(new ExecutionArtifact
            {
                Name = "测试输入",
                MimeType = "application/json",
                SlotId = "mock-input",
                InlineContent = inputJson,
                SizeBytes = System.Text.Encoding.UTF8.GetByteCount(inputJson),
            });
        }

        _logger.LogInformation("[{AppKey}] Capsule test-run: type={TypeKey} by {UserId}",
            AppKey, request.TypeKey, GetUserId());

        // 直接执行舱逻辑
        CapsuleTestRunResult testResult;
        try
        {
            var execResult = await CapsuleExecutor.ExecuteAsync(
                HttpContext.RequestServices, _logger, testNode,
                new Dictionary<string, string>(), mockInputArtifacts);

            var completedAt = DateTime.UtcNow;
            testResult = new CapsuleTestRunResult
            {
                TypeKey = request.TypeKey,
                TypeName = meta.Name,
                Status = "completed",
                StartedAt = startedAt,
                CompletedAt = completedAt,
                DurationMs = (long)(completedAt - startedAt).TotalMilliseconds,
                Logs = execResult.Logs,
                Artifacts = execResult.Artifacts.Select(a => new TestRunArtifact
                {
                    Name = a.Name,
                    MimeType = a.MimeType,
                    SizeBytes = a.SizeBytes,
                    InlineContent = a.InlineContent?.Length > 50_000
                        ? a.InlineContent[..50_000] + "\n...[truncated]"
                        : a.InlineContent,
                }).ToList(),
            };
        }
        catch (Exception ex)
        {
            var completedAt = DateTime.UtcNow;
            testResult = new CapsuleTestRunResult
            {
                TypeKey = request.TypeKey,
                TypeName = meta.Name,
                Status = "failed",
                StartedAt = startedAt,
                CompletedAt = completedAt,
                DurationMs = (long)(completedAt - startedAt).TotalMilliseconds,
                ErrorMessage = ex.Message,
                Logs = $"[ERROR] {ex.Message}",
            };
        }

        return Ok(ApiResponse<object>.Ok(new { result = testResult }));
    }

    // ─────────────────────────────────────────────────────────
    // TAPD Cookie 校验
    // ─────────────────────────────────────────────────────────

    /// <summary>
    /// 校验 TAPD Cookie 是否有效，并返回工作空间信息和基础统计。
    /// </summary>
    [HttpPost("tapd/validate-cookie")]
    public async Task<IActionResult> ValidateTapdCookie(
        [FromBody] ValidateTapdCookieRequest request,
        CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(request.Cookie))
            return BadRequest(ApiResponse<object>.Fail("MISSING_COOKIE", "Cookie 不能为空"));

        var factory = HttpContext.RequestServices.GetRequiredService<IHttpClientFactory>();
        using var client = factory.CreateClient();
        client.Timeout = TimeSpan.FromSeconds(15);

        var cookieStr = request.Cookie.Trim();

        // 提取 dsc-token
        var dscToken = "";
        var dscMatch = System.Text.RegularExpressions.Regex.Match(cookieStr, @"dsc-token=([^;\s]+)");
        if (dscMatch.Success) dscToken = dscMatch.Groups[1].Value;

        // 收集调试信息：每个 API 调用的 URL、方法、状态、响应摘要
        var apiResults = new List<object>();
        var debugCurls = new List<object>();

        // 构造完整 Chrome 请求头（匹配真实浏览器，避免 TAPD 反爬）
        void AddChromeHeaders(HttpRequestMessage req, string referer = "https://www.tapd.cn/")
        {
            req.Headers.Add("Cookie", cookieStr);
            req.Headers.Add("Accept", "application/json, text/plain, */*");
            req.Headers.Add("Accept-Language", "zh-CN,zh;q=0.9");
            req.Headers.Add("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36");
            req.Headers.Add("sec-ch-ua", "\"Not:A-Brand\";v=\"99\", \"Google Chrome\";v=\"145\", \"Chromium\";v=\"145\"");
            req.Headers.Add("sec-ch-ua-mobile", "?0");
            req.Headers.Add("sec-ch-ua-platform", "\"Windows\"");
            req.Headers.Add("Sec-Fetch-Dest", "empty");
            req.Headers.Add("Sec-Fetch-Mode", "cors");
            req.Headers.Add("Sec-Fetch-Site", "same-origin");
            req.Headers.Add("DNT", "1");
            req.Headers.Add("Referer", referer);
        }

        string Snippet(string body, int maxLen = 300) =>
            body.Length <= maxLen ? body : body[..maxLen] + "...(truncated)";

        // ── 1. 获取用户信息 ──────────────────────────────────
        string? userName = null;
        string? userId = null;
        string? userInfoError = null;
        {
            var url = "https://www.tapd.cn/api/basic/info/get_user_info";
            try
            {
                var req = new HttpRequestMessage(HttpMethod.Get, url);
                AddChromeHeaders(req);
                debugCurls.Add(new { name = "获取用户信息", curl = BuildCurl("GET", url, cookieStr, null) });

                var resp = await client.SendAsync(req, ct);
                var body = await resp.Content.ReadAsStringAsync(ct);

                apiResults.Add(new { api = url, method = "GET", status = (int)resp.StatusCode, response = Snippet(body) });

                if (resp.IsSuccessStatusCode && IsJson(body))
                {
                    using var doc = JsonDocument.Parse(body);
                    if (doc.RootElement.TryGetProperty("data", out var d) && d.ValueKind == JsonValueKind.Object)
                    {
                        if (d.TryGetProperty("nick", out var nick)) userName = nick.GetString();
                        if (d.TryGetProperty("user_id", out var uid)) userId = uid.GetString();
                    }
                    else
                    {
                        userInfoError = $"data={d.ValueKind}";
                    }
                }
                else
                {
                    userInfoError = $"HTTP {(int)resp.StatusCode}";
                }
            }
            catch (Exception ex)
            {
                userInfoError = ex.Message;
                apiResults.Add(new { api = url, method = "GET", status = 0, response = ex.Message });
            }
        }

        // ── 2. 获取工作空间列表 ──────────────────────────────
        var workspaces = new List<object>();
        string? workspaceError = null;
        {
            var url = "https://www.tapd.cn/api/aggregation/workspaces";
            try
            {
                var req = new HttpRequestMessage(HttpMethod.Get, url);
                AddChromeHeaders(req);
                debugCurls.Add(new { name = "获取工作空间列表", curl = BuildCurl("GET", url, cookieStr, null) });

                var resp = await client.SendAsync(req, ct);
                var body = await resp.Content.ReadAsStringAsync(ct);

                apiResults.Add(new { api = url, method = "GET", status = (int)resp.StatusCode, response = Snippet(body) });

                if (resp.IsSuccessStatusCode && IsJson(body))
                {
                    using var doc = JsonDocument.Parse(body);
                    if (doc.RootElement.TryGetProperty("data", out var wsData) && wsData.ValueKind == JsonValueKind.Array)
                    {
                        foreach (var ws in wsData.EnumerateArray())
                        {
                            var wsId = ws.TryGetProperty("workspace_id", out var wid) ? wid.GetString() : null;
                            var wsName = ws.TryGetProperty("name", out var wn) ? wn.GetString() : null;
                            if (wsId != null) workspaces.Add(new { id = wsId, name = wsName ?? wsId });
                        }
                    }
                }
                else
                {
                    workspaceError = $"HTTP {(int)resp.StatusCode}";
                }
            }
            catch (Exception ex)
            {
                workspaceError = ex.Message;
                apiResults.Add(new { api = url, method = "GET", status = 0, response = ex.Message });
            }
        }

        // ── 3. 搜索缺陷（如果指定了 workspaceId）──────────────
        int? bugCount = null;
        var searchApiOk = false;
        if (!string.IsNullOrWhiteSpace(request.WorkspaceId))
        {
            var url = "https://www.tapd.cn/api/search_filter/search_filter/search";
            try
            {
                var searchData = new JsonObject
                {
                    ["workspace_ids"] = request.WorkspaceId,
                    ["search_data"] = System.Text.Json.JsonSerializer.Serialize(new { data = new object[0], optionType = "AND", needInit = "1" }),
                    ["obj_type"] = "bug",
                    ["search_type"] = "advanced",
                    ["page"] = 1,
                    ["perpage"] = "1",
                    ["block_size"] = 50,
                    ["parallel_token"] = "",
                    ["order_field"] = "created",
                    ["order_value"] = "desc",
                    ["show_fields"] = new JsonArray(),
                    ["extra_fields"] = new JsonArray(),
                    ["display_mode"] = "list",
                    ["version"] = "1.1.0",
                    ["only_gen_token"] = 0,
                    ["exclude_workspace_configs"] = new JsonArray(),
                    ["from_pro_dashboard"] = 1,
                };
                if (!string.IsNullOrWhiteSpace(dscToken))
                    searchData["dsc_token"] = dscToken;

                var postBody = searchData.ToJsonString();

                var req = new HttpRequestMessage(HttpMethod.Post, url);
                AddChromeHeaders(req, $"https://www.tapd.cn/tapd_fe/{request.WorkspaceId}/bug/list");
                req.Headers.Add("Origin", "https://www.tapd.cn");
                req.Content = new StringContent(postBody, System.Text.Encoding.UTF8, "application/json");

                debugCurls.Add(new { name = "搜索缺陷（统计总数）", curl = BuildCurl("POST", url, cookieStr, postBody, request.WorkspaceId) });

                var resp = await client.SendAsync(req, ct);
                var body = await resp.Content.ReadAsStringAsync(ct);

                apiResults.Add(new { api = url, method = "POST", status = (int)resp.StatusCode, response = Snippet(body) });

                if (resp.IsSuccessStatusCode && IsJson(body))
                {
                    using var doc = JsonDocument.Parse(body);
                    if (doc.RootElement.TryGetProperty("data", out var d) &&
                        d.ValueKind == JsonValueKind.Object)
                    {
                        // data 是 Object 说明 API 调用成功（Cookie 有效）
                        searchApiOk = true;

                        if (d.TryGetProperty("total_count", out var tc))
                        {
                            if (tc.ValueKind == JsonValueKind.Number)
                                bugCount = tc.GetInt32();
                            else if (tc.ValueKind == JsonValueKind.String && int.TryParse(tc.GetString(), out var n))
                                bugCount = n;
                        }
                    }
                }
            }
            catch (Exception ex)
            {
                apiResults.Add(new { api = url, method = "POST", status = 0, response = ex.Message });
            }
        }

        // 判断有效性：用户信息 或 工作空间列表 或 搜索 API 任一成功即有效
        var isValid = userName != null || workspaces.Count > 0 || searchApiOk;
        if (!isValid)
        {
            return Ok(ApiResponse<object>.Ok(new
            {
                valid = false,
                error = $"Cookie 验证失败：用户信息（{userInfoError ?? "无数据"}），工作空间（{workspaceError ?? "无数据"}），搜索API（{(bugCount.HasValue ? $"{bugCount}条" : "未调用或失败")}）",
                apiResults,
                debugCurls,
            }));
        }

        return Ok(ApiResponse<object>.Ok(new
        {
            valid = true,
            userName,
            userId,
            hasDscToken = !string.IsNullOrWhiteSpace(dscToken),
            workspaces,
            bugCount,
            apiResults,
            debugCurls,
        }));

        // ── 工具方法 ──────────────────────────────────────────
        static bool IsJson(string s) { var t = s.TrimStart(); return t.Length > 0 && (t[0] == '{' || t[0] == '['); }

        static string BuildCurl(string method, string url, string cookie, string? body, string? wsId = null)
        {
            var parts = new System.Text.StringBuilder();
            parts.Append($"curl -s");
            if (method == "POST") parts.Append(" -X POST");
            parts.Append($" '{url}'");
            parts.Append($" \\\n  -H 'Accept: application/json, text/plain, */*'");
            parts.Append($" \\\n  -H 'Accept-Language: zh-CN,zh;q=0.9'");
            parts.Append($" \\\n  -H 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36'");
            parts.Append($" \\\n  -H 'sec-ch-ua: \"Not:A-Brand\";v=\"99\", \"Google Chrome\";v=\"145\", \"Chromium\";v=\"145\"'");
            parts.Append($" \\\n  -H 'sec-ch-ua-mobile: ?0'");
            parts.Append($" \\\n  -H 'sec-ch-ua-platform: \"Windows\"'");
            parts.Append($" \\\n  -H 'Sec-Fetch-Dest: empty'");
            parts.Append($" \\\n  -H 'Sec-Fetch-Mode: cors'");
            parts.Append($" \\\n  -H 'Sec-Fetch-Site: same-origin'");
            parts.Append($" \\\n  -H 'DNT: 1'");
            if (method == "POST")
            {
                parts.Append($" \\\n  -H 'Origin: https://www.tapd.cn'");
                parts.Append($" \\\n  -H 'Content-Type: application/json'");
                parts.Append($" \\\n  -H 'Referer: https://www.tapd.cn/tapd_fe/{wsId}/bug/list'");
            }
            parts.Append($" \\\n  -H 'Cookie: {cookie}'");
            if (body != null)
                parts.Append($" \\\n  -d '{body}'");
            return parts.ToString();
        }
    }

    public class ValidateTapdCookieRequest
    {
        public string Cookie { get; set; } = string.Empty;
        public string? WorkspaceId { get; set; }
    }

    // ─────────────────────────────────────────────────────────
    // Workflow CRUD
    // ─────────────────────────────────────────────────────────

    /// <summary>列出当前用户的工作流</summary>
    [HttpGet("workflows")]
    public async Task<IActionResult> ListWorkflows(
        [FromQuery] string? tag,
        [FromQuery] int page = 1,
        [FromQuery] int pageSize = 20,
        CancellationToken ct = default)
    {
        var userId = GetUserId();
        var filter = Builders<Workflow>.Filter.Eq(w => w.CreatedBy, userId);

        if (!string.IsNullOrWhiteSpace(tag))
            filter &= Builders<Workflow>.Filter.AnyEq(w => w.Tags, tag);

        var total = await _db.Workflows.CountDocumentsAsync(filter, cancellationToken: ct);
        var items = await _db.Workflows
            .Find(filter)
            .SortByDescending(w => w.UpdatedAt)
            .Skip((page - 1) * pageSize)
            .Limit(pageSize)
            .ToListAsync(ct);

        return Ok(ApiResponse<object>.Ok(new { items, total }));
    }

    /// <summary>创建工作流</summary>
    [HttpPost("workflows")]
    public async Task<IActionResult> CreateWorkflow(
        [FromBody] CreateWorkflowRequest request,
        CancellationToken ct = default)
    {
        var userId = GetUserId();
        var userName = GetUsername();

        var workflow = new Workflow
        {
            Name = request.Name?.Trim() ?? "未命名工作流",
            Description = request.Description,
            Icon = request.Icon,
            Tags = request.Tags ?? new(),
            Nodes = request.Nodes ?? new(),
            Edges = request.Edges ?? new(),
            Variables = request.Variables ?? new(),
            Triggers = request.Triggers ?? new(),
            CreatedBy = userId,
            CreatedByName = userName,
            OwnerUserId = userId,
        };

        // 校验舱类型（兼容旧 NodeType 和新 CapsuleType）
        foreach (var node in workflow.Nodes)
        {
            if (!CapsuleTypes.All.Contains(node.NodeType) && !WorkflowNodeTypes.All.Contains(node.NodeType))
                return BadRequest(ApiResponse<object>.Fail("INVALID_NODE_TYPE", $"不支持的舱类型: {node.NodeType}"));
        }

        // 校验边的引用合法性
        var nodeIds = workflow.Nodes.Select(n => n.NodeId).ToHashSet();
        foreach (var edge in workflow.Edges)
        {
            if (!nodeIds.Contains(edge.SourceNodeId) || !nodeIds.Contains(edge.TargetNodeId))
                return BadRequest(ApiResponse<object>.Fail("INVALID_EDGE", "边引用了不存在的节点"));
        }

        // JsonElement → 原生类型（防止 MongoDB BSON 序列化失败）
        SanitizeNodeConfigs(workflow.Nodes);

        await _db.Workflows.InsertOneAsync(workflow, cancellationToken: ct);

        _logger.LogInformation("[{AppKey}] Workflow created: {WorkflowId} by {UserId}", AppKey, workflow.Id, userId);

        return Ok(ApiResponse<object>.Ok(new { workflow }));
    }

    /// <summary>获取工作流详情</summary>
    [HttpGet("workflows/{id}")]
    public async Task<IActionResult> GetWorkflow(string id, CancellationToken ct = default)
    {
        var workflow = await _db.Workflows.Find(w => w.Id == id).FirstOrDefaultAsync(ct);
        if (workflow == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "工作流不存在"));

        // 非管理员只能看自己的
        if (workflow.CreatedBy != GetUserId() && !HasManagePermission())
            return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "无权限"));

        return Ok(ApiResponse<object>.Ok(new { workflow }));
    }

    /// <summary>更新工作流定义</summary>
    [HttpPut("workflows/{id}")]
    public async Task<IActionResult> UpdateWorkflow(
        string id,
        [FromBody] UpdateWorkflowRequest request,
        CancellationToken ct = default)
    {
        var workflow = await _db.Workflows.Find(w => w.Id == id).FirstOrDefaultAsync(ct);
        if (workflow == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "工作流不存在"));

        if (workflow.CreatedBy != GetUserId() && !HasManagePermission())
            return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "无权限"));

        // 校验舱类型（与 Create 保持一致）
        if (request.Nodes != null)
        {
            foreach (var node in request.Nodes)
            {
                if (!CapsuleTypes.All.Contains(node.NodeType) && !WorkflowNodeTypes.All.Contains(node.NodeType))
                    return BadRequest(ApiResponse<object>.Fail("INVALID_NODE_TYPE", $"不支持的舱类型: {node.NodeType}"));
            }

            // 校验边引用合法性
            var nodeIds = request.Nodes.Select(n => n.NodeId).ToHashSet();
            var edgesToCheck = request.Edges ?? workflow.Edges;
            foreach (var edge in edgesToCheck)
            {
                if (!nodeIds.Contains(edge.SourceNodeId) || !nodeIds.Contains(edge.TargetNodeId))
                    return BadRequest(ApiResponse<object>.Fail("INVALID_EDGE", "边引用了不存在的节点"));
            }
        }
        else if (request.Edges != null)
        {
            var nodeIds = workflow.Nodes.Select(n => n.NodeId).ToHashSet();
            foreach (var edge in request.Edges)
            {
                if (!nodeIds.Contains(edge.SourceNodeId) || !nodeIds.Contains(edge.TargetNodeId))
                    return BadRequest(ApiResponse<object>.Fail("INVALID_EDGE", "边引用了不存在的节点"));
            }
        }

        if (request.Name != null) workflow.Name = request.Name.Trim();
        if (request.Description != null) workflow.Description = request.Description;
        if (request.Icon != null) workflow.Icon = request.Icon;
        if (request.Tags != null) workflow.Tags = request.Tags;
        if (request.Nodes != null) workflow.Nodes = request.Nodes;
        if (request.Edges != null) workflow.Edges = request.Edges;
        if (request.Variables != null) workflow.Variables = request.Variables;
        if (request.Triggers != null) workflow.Triggers = request.Triggers;
        if (request.IsEnabled.HasValue) workflow.IsEnabled = request.IsEnabled.Value;
        workflow.UpdatedAt = DateTime.UtcNow;

        // JsonElement → 原生类型（防止 MongoDB BSON 序列化失败）
        SanitizeNodeConfigs(workflow.Nodes);

        await _db.Workflows.ReplaceOneAsync(w => w.Id == id, workflow, cancellationToken: ct);

        _logger.LogInformation("[{AppKey}] Workflow updated: {WorkflowId}", AppKey, id);

        return Ok(ApiResponse<object>.Ok(new { workflow }));
    }

    /// <summary>删除工作流</summary>
    [HttpDelete("workflows/{id}")]
    public async Task<IActionResult> DeleteWorkflow(string id, CancellationToken ct = default)
    {
        var workflow = await _db.Workflows.Find(w => w.Id == id).FirstOrDefaultAsync(ct);
        if (workflow == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "工作流不存在"));

        if (workflow.CreatedBy != GetUserId() && !HasManagePermission())
            return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "无权限"));

        await _db.Workflows.DeleteOneAsync(w => w.Id == id, ct);

        _logger.LogInformation("[{AppKey}] Workflow deleted: {WorkflowId}", AppKey, id);

        return Ok(ApiResponse<object>.Ok(new { deleted = true }));
    }

    // ─────────────────────────────────────────────────────────
    // Execution 执行管理
    // ─────────────────────────────────────────────────────────

    /// <summary>手动触发执行</summary>
    [HttpPost("workflows/{id}/execute")]
    public async Task<IActionResult> ExecuteWorkflow(
        string id,
        [FromBody] ExecuteWorkflowRequest? request,
        CancellationToken ct = default)
    {
        var userId = GetUserId();
        var workflow = await _db.Workflows.Find(w => w.Id == id).FirstOrDefaultAsync(ct);
        if (workflow == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "工作流不存在"));

        if (workflow.Nodes.Count == 0)
            return BadRequest(ApiResponse<object>.Fail("EMPTY_WORKFLOW", "工作流没有节点，无法执行"));

        // 构建运行时变量
        var variables = new Dictionary<string, string>();
        foreach (var v in workflow.Variables)
        {
            // 优先使用请求中的值，否则使用默认值
            if (request?.Variables?.TryGetValue(v.Key, out var val) == true)
                variables[v.Key] = val;
            else if (v.DefaultValue != null)
                variables[v.Key] = ResolveDefaultValue(v.DefaultValue);
            else if (v.Required)
                return BadRequest(ApiResponse<object>.Fail("MISSING_VARIABLE", $"缺少必填变量: {v.Label} ({v.Key})"));
        }

        // 创建执行实例
        var execution = new WorkflowExecution
        {
            WorkflowId = workflow.Id,
            WorkflowName = workflow.Name,
            TriggerType = WorkflowTriggerTypes.Manual,
            TriggeredBy = userId,
            TriggeredByName = GetUsername(),
            Variables = variables,
            NodeSnapshot = workflow.Nodes,
            EdgeSnapshot = workflow.Edges,
            NodeExecutions = workflow.Nodes.Select(n => new NodeExecution
            {
                NodeId = n.NodeId,
                NodeName = n.Name,
                NodeType = n.NodeType,
                Status = NodeExecutionStatus.Pending
            }).ToList(),
            Status = WorkflowExecutionStatus.Queued,
        };

        await _db.WorkflowExecutions.InsertOneAsync(execution, cancellationToken: ct);

        // 更新工作流统计
        await _db.Workflows.UpdateOneAsync(
            w => w.Id == id,
            Builders<Workflow>.Update
                .Set(w => w.LastExecutedAt, DateTime.UtcNow)
                .Inc(w => w.ExecutionCount, 1),
            cancellationToken: ct);

        // 入队（WorkflowRunWorker 会消费）
        await _runQueue.EnqueueAsync("workflow", execution.Id, ct);

        _logger.LogInformation("[{AppKey}] Workflow execution queued: {ExecutionId} for {WorkflowId} by {UserId}",
            AppKey, execution.Id, id, userId);

        return Ok(ApiResponse<object>.Ok(new { execution }));
    }

    /// <summary>从指定节点重跑</summary>
    [HttpPost("executions/{executionId}/resume-from/{nodeId}")]
    public async Task<IActionResult> ResumeFromNode(
        string executionId,
        string nodeId,
        CancellationToken ct = default)
    {
        var original = await _db.WorkflowExecutions.Find(e => e.Id == executionId).FirstOrDefaultAsync(ct);
        if (original == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "执行记录不存在"));

        if (original.TriggeredBy != GetUserId() && !HasManagePermission())
            return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "无权限操作此执行记录"));

        // 验证节点存在
        if (original.NodeSnapshot.All(n => n.NodeId != nodeId))
            return BadRequest(ApiResponse<object>.Fail("INVALID_NODE", "节点不存在"));

        // 创建新执行实例，保留目标节点之前的产物
        var newExecution = new WorkflowExecution
        {
            WorkflowId = original.WorkflowId,
            WorkflowName = original.WorkflowName,
            TriggerType = "resume",
            TriggeredBy = GetUserId(),
            TriggeredByName = GetUsername(),
            Variables = original.Variables,
            NodeSnapshot = original.NodeSnapshot,
            EdgeSnapshot = original.EdgeSnapshot,
            Status = WorkflowExecutionStatus.Queued,
        };

        // 标记节点状态：目标节点之前保持 completed，之后重置为 pending
        var targetFound = false;
        foreach (var node in original.NodeSnapshot)
        {
            if (node.NodeId == nodeId) targetFound = true;

            var originalNodeExec = original.NodeExecutions.FirstOrDefault(n => n.NodeId == node.NodeId);

            if (!targetFound && originalNodeExec?.Status == NodeExecutionStatus.Completed)
            {
                // 保留已完成节点
                newExecution.NodeExecutions.Add(new NodeExecution
                {
                    NodeId = node.NodeId,
                    NodeName = node.Name,
                    NodeType = node.NodeType,
                    Status = NodeExecutionStatus.Completed,
                    OutputArtifacts = originalNodeExec.OutputArtifacts,
                    StartedAt = originalNodeExec.StartedAt,
                    CompletedAt = originalNodeExec.CompletedAt,
                    DurationMs = originalNodeExec.DurationMs,
                });
            }
            else
            {
                // 重置为 pending
                newExecution.NodeExecutions.Add(new NodeExecution
                {
                    NodeId = node.NodeId,
                    NodeName = node.Name,
                    NodeType = node.NodeType,
                    Status = NodeExecutionStatus.Pending,
                });
            }
        }

        await _db.WorkflowExecutions.InsertOneAsync(newExecution, cancellationToken: ct);

        // 入队
        await _runQueue.EnqueueAsync("workflow", newExecution.Id, ct);

        _logger.LogInformation("[{AppKey}] Execution resumed from node {NodeId}: new={NewExecId} original={OriginalExecId}",
            AppKey, nodeId, newExecution.Id, executionId);

        return Ok(ApiResponse<object>.Ok(new { execution = newExecution }));
    }

    /// <summary>取消执行</summary>
    [HttpPost("executions/{executionId}/cancel")]
    public async Task<IActionResult> CancelExecution(string executionId, CancellationToken ct = default)
    {
        var execution = await _db.WorkflowExecutions.Find(e => e.Id == executionId).FirstOrDefaultAsync(ct);
        if (execution == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "执行记录不存在"));

        if (execution.TriggeredBy != GetUserId() && !HasManagePermission())
            return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "无权限取消此执行"));

        if (execution.Status is WorkflowExecutionStatus.Completed or WorkflowExecutionStatus.Failed or WorkflowExecutionStatus.Cancelled)
            return BadRequest(ApiResponse<object>.Fail("ALREADY_TERMINAL", "执行已结束，无法取消"));

        await _db.WorkflowExecutions.UpdateOneAsync(
            e => e.Id == executionId,
            Builders<WorkflowExecution>.Update
                .Set(e => e.Status, WorkflowExecutionStatus.Cancelled)
                .Set(e => e.CompletedAt, DateTime.UtcNow),
            cancellationToken: ct);

        _logger.LogInformation("[{AppKey}] Execution cancelled: {ExecutionId}", AppKey, executionId);

        return Ok(ApiResponse<object>.Ok(new { cancelled = true }));
    }

    /// <summary>查询执行历史</summary>
    [HttpGet("executions")]
    public async Task<IActionResult> ListExecutions(
        [FromQuery] string? workflowId,
        [FromQuery] string? status,
        [FromQuery] int page = 1,
        [FromQuery] int pageSize = 20,
        CancellationToken ct = default)
    {
        var userId = GetUserId();
        var filter = HasManagePermission()
            ? Builders<WorkflowExecution>.Filter.Empty
            : Builders<WorkflowExecution>.Filter.Eq(e => e.TriggeredBy, userId);

        if (!string.IsNullOrWhiteSpace(workflowId))
            filter &= Builders<WorkflowExecution>.Filter.Eq(e => e.WorkflowId, workflowId);
        if (!string.IsNullOrWhiteSpace(status))
            filter &= Builders<WorkflowExecution>.Filter.Eq(e => e.Status, status);

        var total = await _db.WorkflowExecutions.CountDocumentsAsync(filter, cancellationToken: ct);
        var items = await _db.WorkflowExecutions
            .Find(filter)
            .SortByDescending(e => e.CreatedAt)
            .Skip((page - 1) * pageSize)
            .Limit(pageSize)
            // 列表只返回摘要，不返回 NodeSnapshot/EdgeSnapshot/FinalArtifacts
            .Project(Builders<WorkflowExecution>.Projection
                .Exclude(e => e.NodeSnapshot)
                .Exclude(e => e.EdgeSnapshot)
                .Exclude(e => e.FinalArtifacts))
            .As<WorkflowExecution>()
            .ToListAsync(ct);

        return Ok(ApiResponse<object>.Ok(new { items, total }));
    }

    /// <summary>获取执行详情</summary>
    [HttpGet("executions/{executionId}")]
    public async Task<IActionResult> GetExecution(string executionId, CancellationToken ct = default)
    {
        var execution = await _db.WorkflowExecutions.Find(e => e.Id == executionId).FirstOrDefaultAsync(ct);
        if (execution == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "执行记录不存在"));

        if (execution.TriggeredBy != GetUserId() && !HasManagePermission())
            return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "无权限查看此执行记录"));

        return Ok(ApiResponse<object>.Ok(new { execution }));
    }

    /// <summary>查看节点执行日志</summary>
    [HttpGet("executions/{executionId}/nodes/{nodeId}/logs")]
    public async Task<IActionResult> GetNodeLogs(
        string executionId, string nodeId, CancellationToken ct = default)
    {
        var execution = await _db.WorkflowExecutions.Find(e => e.Id == executionId).FirstOrDefaultAsync(ct);
        if (execution == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "执行记录不存在"));

        if (execution.TriggeredBy != GetUserId() && !HasManagePermission())
            return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "无权限查看此执行日志"));

        var nodeExec = execution.NodeExecutions.FirstOrDefault(n => n.NodeId == nodeId);
        if (nodeExec == null)
            return NotFound(ApiResponse<object>.Fail("NODE_NOT_FOUND", "节点不存在"));

        return Ok(ApiResponse<object>.Ok(new
        {
            nodeId,
            nodeName = nodeExec.NodeName,
            status = nodeExec.Status,
            logs = nodeExec.Logs,
            errorMessage = nodeExec.ErrorMessage,
            artifacts = nodeExec.OutputArtifacts,
        }));
    }

    // ─────────────────────────────────────────────────────────
    // Share 分享
    // ─────────────────────────────────────────────────────────

    /// <summary>创建分享链接</summary>
    [HttpPost("executions/{executionId}/share")]
    public async Task<IActionResult> CreateShareLink(
        string executionId,
        [FromBody] CreateShareRequest request,
        CancellationToken ct = default)
    {
        var execution = await _db.WorkflowExecutions.Find(e => e.Id == executionId).FirstOrDefaultAsync(ct);
        if (execution == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "执行记录不存在"));

        if (execution.TriggeredBy != GetUserId() && !HasManagePermission())
            return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "无权限分享此执行记录"));

        var link = new ShareLink
        {
            ResourceType = "workflow-execution",
            ResourceId = executionId,
            AccessLevel = request.AccessLevel ?? "public",
            Title = execution.WorkflowName,
            Artifacts = execution.FinalArtifacts.Select(a => new ShareArtifactRef
            {
                ArtifactId = a.ArtifactId,
                Name = a.Name,
                MimeType = a.MimeType,
                Url = a.CosUrl,
            }).ToList(),
            CreatedBy = GetUserId(),
            ExpiresAt = request.ExpiresInDays.HasValue
                ? DateTime.UtcNow.AddDays(request.ExpiresInDays.Value)
                : null,
        };

        // 如果有 HTML 产物，作为预览
        var htmlArtifact = execution.FinalArtifacts.FirstOrDefault(a => a.MimeType == "text/html");
        if (htmlArtifact?.InlineContent != null)
            link.PreviewHtml = htmlArtifact.InlineContent;

        await _db.ShareLinks.InsertOneAsync(link, cancellationToken: ct);

        // 记录到执行实例
        await _db.WorkflowExecutions.UpdateOneAsync(
            e => e.Id == executionId,
            Builders<WorkflowExecution>.Update.AddToSet(e => e.ShareLinkIds, link.Id),
            cancellationToken: ct);

        _logger.LogInformation("[{AppKey}] Share link created: {Token} for execution {ExecutionId}",
            AppKey, link.Token, executionId);

        return Ok(ApiResponse<object>.Ok(new
        {
            shareLink = link,
            url = $"/s/{link.Token}"
        }));
    }

    /// <summary>撤销分享</summary>
    [HttpDelete("shares/{shareId}")]
    public async Task<IActionResult> RevokeShare(string shareId, CancellationToken ct = default)
    {
        var link = await _db.ShareLinks.Find(l => l.Id == shareId).FirstOrDefaultAsync(ct);
        if (link == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "分享链接不存在"));

        if (link.CreatedBy != GetUserId() && !HasManagePermission())
            return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "无权限"));

        await _db.ShareLinks.UpdateOneAsync(
            l => l.Id == shareId,
            Builders<ShareLink>.Update.Set(l => l.IsRevoked, true),
            cancellationToken: ct);

        return Ok(ApiResponse<object>.Ok(new { revoked = true }));
    }

    /// <summary>我的分享列表</summary>
    [HttpGet("shares")]
    public async Task<IActionResult> ListShares(CancellationToken ct = default)
    {
        var userId = GetUserId();
        var items = await _db.ShareLinks
            .Find(l => l.CreatedBy == userId && !l.IsRevoked)
            .SortByDescending(l => l.CreatedAt)
            .Limit(100)
            .ToListAsync(ct);

        return Ok(ApiResponse<object>.Ok(new { items }));
    }

    // ─────────────────────────────────────────────────────────
    // Share 公开访问（AllowAnonymous）
    // ─────────────────────────────────────────────────────────

    /// <summary>查看分享内容</summary>
    [HttpGet("/s/{token}")]
    [AllowAnonymous]
    public async Task<IActionResult> ViewShare(string token, CancellationToken ct = default)
    {
        var link = await _db.ShareLinks
            .Find(l => l.Token == token && !l.IsRevoked)
            .FirstOrDefaultAsync(ct);

        if (link == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "链接不存在或已失效"));

        if (link.ExpiresAt.HasValue && link.ExpiresAt < DateTime.UtcNow)
            return StatusCode(410, ApiResponse<object>.Fail("EXPIRED", "链接已过期"));

        // 权限检查
        if (link.AccessLevel == "authenticated")
        {
            var userId = GetUserIdOrNull();
            if (userId == null)
                return Unauthorized(ApiResponse<object>.Fail(ErrorCodes.UNAUTHORIZED, "需要登录后查看"));
        }

        // 更新统计
        await _db.ShareLinks.UpdateOneAsync(
            l => l.Id == link.Id,
            Builders<ShareLink>.Update
                .Inc(l => l.ViewCount, 1)
                .Set(l => l.LastViewedAt, DateTime.UtcNow),
            cancellationToken: ct);

        // HTML 产物直接返回页面
        if (link.PreviewHtml != null)
            return Content(link.PreviewHtml, "text/html");

        return Ok(ApiResponse<object>.Ok(new
        {
            title = link.Title,
            artifacts = link.Artifacts,
        }));
    }

    // ─────────────────────────────────────────────────────────
    // Helpers
    // ─────────────────────────────────────────────────────────

    private string GetUserId()
        => User.FindFirst("sub")?.Value
           ?? User.FindFirst(ClaimTypes.NameIdentifier)?.Value
           ?? "unknown";

    private string? GetUserIdOrNull()
        => User?.FindFirst("sub")?.Value
           ?? User?.FindFirst(ClaimTypes.NameIdentifier)?.Value;

    private string? GetUsername()
        => User.FindFirst("name")?.Value
           ?? User.FindFirst(ClaimTypes.Name)?.Value;

    private bool HasManagePermission()
    {
        var permissions = User.FindAll("permissions").Select(c => c.Value).ToList();
        return permissions.Contains(AdminPermissionCatalog.WorkflowAgentManage)
               || permissions.Contains(AdminPermissionCatalog.Super);
    }

    private static string ResolveDefaultValue(string template)
    {
        var now = DateTime.Now;
        return template
            .Replace("{{now.year}}", now.Year.ToString())
            .Replace("{{now.month}}", now.Month.ToString("D2"))
            .Replace("{{now.date}}", now.ToString("yyyy-MM-dd"));
    }

    /// <summary>
    /// 将节点 Config 中的 JsonElement 值转换为原生 .NET 类型，
    /// 解决 System.Text.Json 反序列化 Dictionary&lt;string, object?&gt; 时
    /// 值类型为 JsonElement 导致 MongoDB BSON 序列化失败的问题。
    /// </summary>
    private static void SanitizeNodeConfigs(IEnumerable<WorkflowNode> nodes)
    {
        foreach (var node in nodes)
        {
            if (node.Config == null) continue;
            var sanitized = new Dictionary<string, object?>();
            foreach (var kv in node.Config)
                sanitized[kv.Key] = ConvertJsonElement(kv.Value);
            node.Config = sanitized;
        }
    }

    private static object? ConvertJsonElement(object? value)
    {
        if (value is not JsonElement je) return value;

        return je.ValueKind switch
        {
            JsonValueKind.String => je.GetString(),
            JsonValueKind.Number => je.TryGetInt64(out var l) ? (object)l : je.GetDouble(),
            JsonValueKind.True => true,
            JsonValueKind.False => false,
            JsonValueKind.Null => null,
            JsonValueKind.Undefined => null,
            JsonValueKind.Array => je.EnumerateArray().Select(e => ConvertJsonElement((object)e)).ToList(),
            JsonValueKind.Object => je.EnumerateObject().ToDictionary(p => p.Name, p => ConvertJsonElement((object)p.Value)),
            _ => je.GetRawText(),
        };
    }

    // ─────────────────────────────────────────────────────────
    // SSE 实时流
    // ─────────────────────────────────────────────────────────

    // ─────────────────────────────────────────────────────────
    // AI 对话助手：自然语言创建/修改工作流
    // ─────────────────────────────────────────────────────────

    private static readonly JsonSerializerOptions SseJsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
    };

    /// <summary>
    /// 工作流对话助手（SSE）：根据用户指令或代码片段创建/修改工作流配置。
    /// 新建场景自动应用，修改场景返回 workflow_generated 事件等用户确认。
    /// </summary>
    [HttpPost("workflows/from-chat")]
    [Produces("text/event-stream")]
    public async Task ChatCreateWorkflow([FromBody] WorkflowChatRequest request)
    {
        Response.ContentType = "text/event-stream";
        Response.Headers.CacheControl = "no-cache";
        Response.Headers.Connection = "keep-alive";

        var userId = GetUserId();
        var userName = GetUsername();

        // 1. 加载已有工作流（如果是修改场景）
        Workflow? existingWorkflow = null;
        if (!string.IsNullOrWhiteSpace(request.WorkflowId))
        {
            existingWorkflow = await _db.Workflows.Find(w => w.Id == request.WorkflowId).FirstOrDefaultAsync(CancellationToken.None);
        }
        var isNew = existingWorkflow == null;

        // 2. 加载对话历史（最近 20 条）
        var history = new List<WorkflowChatMessage>();
        if (!string.IsNullOrWhiteSpace(request.WorkflowId))
        {
            history = await _db.WorkflowChatMessages
                .Find(m => m.WorkflowId == request.WorkflowId && m.UserId == userId)
                .SortByDescending(m => m.Seq)
                .Limit(20)
                .ToListAsync(CancellationToken.None);
            history.Reverse();
        }

        // 3. 保存用户消息
        var maxSeq = history.Count > 0 ? history.Max(m => m.Seq) : 0;
        var userMsg = new WorkflowChatMessage
        {
            WorkflowId = request.WorkflowId,
            Role = "user",
            Content = request.Instruction,
            UserId = userId,
            Seq = maxSeq + 1,
        };
        await _db.WorkflowChatMessages.InsertOneAsync(userMsg, cancellationToken: CancellationToken.None);

        // 4. 构建 LLM Prompt
        var systemPrompt = BuildChatSystemPrompt(existingWorkflow);
        var messages = new JsonArray();

        // 历史消息
        foreach (var msg in history.TakeLast(16))
        {
            messages.Add(new JsonObject
            {
                ["role"] = msg.Role,
                ["content"] = msg.Content,
            });
        }

        // 当前用户消息
        var userContent = request.Instruction;
        if (!string.IsNullOrWhiteSpace(request.CodeSnippet))
            userContent += $"\n\n## 代码片段\n```\n{request.CodeSnippet}\n```";
        if (!string.IsNullOrWhiteSpace(request.CodeUrl))
            userContent += $"\n\n代码仓库地址: {request.CodeUrl}";

        messages.Add(new JsonObject
        {
            ["role"] = "user",
            ["content"] = userContent,
        });

        // 5. 通过 Gateway 流式调用 LLM
        var gatewayRequest = new GatewayRequest
        {
            AppCallerCode = AppCallerRegistry.WorkflowAgent.ChatAssistant.Chat,
            ModelType = "chat",
            Stream = true,
            RequestBody = new JsonObject
            {
                ["messages"] = messages,
                ["temperature"] = 0.3,
                ["stream"] = true,
            },
            Context = new GatewayRequestContext
            {
                UserId = userId,
                SystemPromptText = systemPrompt,
                QuestionText = request.Instruction,
            },
        };

        // 注入 system prompt
        gatewayRequest.RequestBody["messages"] = new JsonArray(
            new JsonObject { ["role"] = "system", ["content"] = systemPrompt }
        );
        foreach (var m in messages.Select(n => n!.DeepClone()))
            ((JsonArray)gatewayRequest.RequestBody["messages"]!).Add(m);

        var fullResponse = new System.Text.StringBuilder();

        _logger.LogInformation("[{AppKey}] Chat workflow: userId={UserId} workflowId={WorkflowId} isNew={IsNew}",
            AppKey, userId, request.WorkflowId ?? "(new)", isNew);

        try
        {
            await foreach (var chunk in _gateway.StreamAsync(gatewayRequest, CancellationToken.None))
            {
                if (string.IsNullOrEmpty(chunk.Content)) continue;
                fullResponse.Append(chunk.Content);

                try
                {
                    var payload = JsonSerializer.Serialize(new { type = "delta", content = chunk.Content }, SseJsonOptions);
                    await Response.WriteAsync($"event: message\ndata: {payload}\n\n");
                    await Response.Body.FlushAsync();
                }
                catch (ObjectDisposedException) { break; }
                catch (OperationCanceledException) { break; }
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[{AppKey}] Chat LLM error", AppKey);
            try
            {
                var errPayload = JsonSerializer.Serialize(new { type = "error", content = $"AI 服务异常: {ex.Message}" }, SseJsonOptions);
                await Response.WriteAsync($"event: message\ndata: {errPayload}\n\n");
                await Response.Body.FlushAsync();
            }
            catch { /* client disconnected */ }
        }

        // 6. 尝试从 LLM 回复中解析工作流 JSON
        var responseText = fullResponse.ToString();
        var generated = TryParseWorkflowFromResponse(responseText);

        if (generated != null)
        {
            generated.IsNew = isNew;

            if (isNew)
            {
                // 新建场景：直接创建工作流
                var workflow = new Workflow
                {
                    Name = generated.Name ?? "AI 生成的工作流",
                    Description = generated.Description,
                    Nodes = generated.Nodes ?? new(),
                    Edges = generated.Edges ?? new(),
                    Variables = generated.Variables ?? new(),
                    CreatedBy = userId,
                    CreatedByName = userName,
                    OwnerUserId = userId,
                };
                SanitizeNodeConfigs(workflow.Nodes);
                await _db.Workflows.InsertOneAsync(workflow, cancellationToken: CancellationToken.None);

                // 更新对话消息关联
                await _db.WorkflowChatMessages.UpdateManyAsync(
                    m => m.WorkflowId == null && m.UserId == userId && m.CreatedAt > DateTime.UtcNow.AddMinutes(-5),
                    Builders<WorkflowChatMessage>.Update.Set(m => m.WorkflowId, workflow.Id),
                    cancellationToken: CancellationToken.None);

                try
                {
                    var autoApplyPayload = JsonSerializer.Serialize(new
                    {
                        type = "workflow_created",
                        workflowId = workflow.Id,
                        workflow = new
                        {
                            workflow.Id, workflow.Name, workflow.Description,
                            workflow.Nodes, workflow.Edges, workflow.Variables,
                        }
                    }, SseJsonOptions);
                    await Response.WriteAsync($"event: message\ndata: {autoApplyPayload}\n\n");
                    await Response.Body.FlushAsync();
                }
                catch { /* client disconnected */ }

                _logger.LogInformation("[{AppKey}] Chat auto-created workflow: {WorkflowId}", AppKey, workflow.Id);
            }
            else
            {
                // 修改场景：返回 generated 供前端确认
                try
                {
                    var confirmPayload = JsonSerializer.Serialize(new
                    {
                        type = "workflow_generated",
                        workflowId = request.WorkflowId,
                        generated = new
                        {
                            generated.Name, generated.Description,
                            generated.Nodes, generated.Edges, generated.Variables,
                        }
                    }, SseJsonOptions);
                    await Response.WriteAsync($"event: message\ndata: {confirmPayload}\n\n");
                    await Response.Body.FlushAsync();
                }
                catch { /* client disconnected */ }
            }
        }

        // 7. 保存 assistant 消息
        var assistantMsg = new WorkflowChatMessage
        {
            WorkflowId = request.WorkflowId ?? (generated != null && isNew ? "auto" : null),
            Role = "assistant",
            Content = responseText,
            Generated = generated,
            UserId = userId,
            Seq = maxSeq + 2,
        };
        await _db.WorkflowChatMessages.InsertOneAsync(assistantMsg, cancellationToken: CancellationToken.None);

        // 8. 结束
        try
        {
            var donePayload = JsonSerializer.Serialize(new { type = "done" }, SseJsonOptions);
            await Response.WriteAsync($"event: message\ndata: {donePayload}\n\n");
            await Response.Body.FlushAsync();
        }
        catch { /* client disconnected */ }
    }

    /// <summary>获取工作流对话历史</summary>
    [HttpGet("workflows/{id}/chat-history")]
    public async Task<IActionResult> GetChatHistory(string id, [FromQuery] long afterSeq = 0, CancellationToken ct = default)
    {
        var userId = GetUserId();
        var filter = Builders<WorkflowChatMessage>.Filter.And(
            Builders<WorkflowChatMessage>.Filter.Eq(m => m.WorkflowId, id),
            Builders<WorkflowChatMessage>.Filter.Eq(m => m.UserId, userId),
            Builders<WorkflowChatMessage>.Filter.Gt(m => m.Seq, afterSeq)
        );

        var messages = await _db.WorkflowChatMessages
            .Find(filter)
            .SortBy(m => m.Seq)
            .Limit(50)
            .ToListAsync(ct);

        return Ok(ApiResponse<object>.Ok(new { messages }));
    }

    /// <summary>
    /// 分析工作流执行失败原因（SSE）：诊断错误并给出修复建议。
    /// </summary>
    [HttpPost("executions/{executionId}/analyze")]
    [Produces("text/event-stream")]
    public async Task AnalyzeExecution(string executionId, [FromBody] AnalyzeExecutionRequest? request)
    {
        Response.ContentType = "text/event-stream";
        Response.Headers.CacheControl = "no-cache";
        Response.Headers.Connection = "keep-alive";

        var userId = GetUserId();

        var execution = await _db.WorkflowExecutions.Find(e => e.Id == executionId).FirstOrDefaultAsync(CancellationToken.None);
        if (execution == null)
        {
            await WriteSseEvent("error", new { type = "error", content = "执行记录不存在" });
            return;
        }

        // 收集失败节点信息
        var failedNodes = execution.NodeExecutions.Where(n => n.Status == NodeExecutionStatus.Failed).ToList();
        var errorContext = new System.Text.StringBuilder();
        errorContext.AppendLine("## 执行概况");
        errorContext.AppendLine($"- 工作流: {execution.WorkflowName}");
        errorContext.AppendLine($"- 状态: {execution.Status}");
        errorContext.AppendLine($"- 错误: {execution.ErrorMessage}");
        errorContext.AppendLine();

        foreach (var node in failedNodes)
        {
            errorContext.AppendLine($"### 失败节点: {node.NodeName} (类型: {node.NodeType})");
            errorContext.AppendLine($"- 错误信息: {node.ErrorMessage}");
            if (!string.IsNullOrWhiteSpace(node.Logs))
                errorContext.AppendLine($"- 日志:\n```\n{node.Logs[..Math.Min(node.Logs.Length, 2000)]}\n```");

            // 添加节点配置
            var nodeSnapshot = execution.NodeSnapshot.FirstOrDefault(n => n.NodeId == node.NodeId);
            if (nodeSnapshot != null)
            {
                var configJson = JsonSerializer.Serialize(nodeSnapshot.Config, new JsonSerializerOptions { WriteIndented = true });
                errorContext.AppendLine($"- 配置:\n```json\n{configJson}\n```");
            }
            errorContext.AppendLine();
        }

        var analyzePrompt = $"""
            你是工作流故障诊断专家。请分析以下工作流执行失败的原因，并给出具体修复建议。

            {errorContext}

            {(request?.Instruction != null ? $"用户补充说明: {request.Instruction}" : "")}

            请按以下格式回答:
            1. **故障原因**: 简明扼要地说明为什么失败
            2. **修复建议**: 具体说明需要修改哪个节点的哪个配置字段，改成什么值
            3. **预防措施**: 如何避免类似问题再次发生
            """;

        var gatewayRequest = new GatewayRequest
        {
            AppCallerCode = AppCallerRegistry.WorkflowAgent.ErrorAnalyzer.Chat,
            ModelType = "chat",
            Stream = true,
            RequestBody = new JsonObject
            {
                ["messages"] = new JsonArray
                {
                    new JsonObject { ["role"] = "user", ["content"] = analyzePrompt }
                },
                ["temperature"] = 0.2,
                ["stream"] = true,
            },
        };

        try
        {
            await foreach (var chunk in _gateway.StreamAsync(gatewayRequest, CancellationToken.None))
            {
                if (string.IsNullOrEmpty(chunk.Content)) continue;
                try
                {
                    await WriteSseEvent("message", new { type = "delta", content = chunk.Content });
                }
                catch { break; }
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[{AppKey}] Analyze execution error", AppKey);
            try { await WriteSseEvent("message", new { type = "error", content = $"分析服务异常: {ex.Message}" }); }
            catch { /* disconnected */ }
        }

        try { await WriteSseEvent("message", new { type = "done" }); }
        catch { /* disconnected */ }
    }

    // ─────────────────────────────────────────────────────────
    // AI 助手 - 内部辅助方法
    // ─────────────────────────────────────────────────────────

    private string BuildChatSystemPrompt(Workflow? existingWorkflow)
    {
        var sb = new System.Text.StringBuilder();
        sb.AppendLine("你是工作流配置助手。你的任务是将用户的自然语言描述或代码片段转换为工作流配置。");
        sb.AppendLine();

        // 注入可用舱类型
        sb.AppendLine("## 可用舱类型");
        sb.AppendLine();
        foreach (var capsule in CapsuleTypeRegistry.All)
        {
            if (capsule.DisabledReason != null) continue;
            sb.AppendLine($"### {capsule.Name} (typeKey: `{capsule.TypeKey}`, 类别: {capsule.Category})");
            sb.AppendLine($"描述: {capsule.Description}");
            if (capsule.ConfigSchema.Count > 0)
            {
                sb.AppendLine("配置字段:");
                foreach (var f in capsule.ConfigSchema)
                {
                    var req = f.Required ? "必填" : "选填";
                    sb.AppendLine($"  - `{f.Key}` ({f.Label}, {f.FieldType}, {req}){(f.HelpTip != null ? $" — {f.HelpTip}" : "")}");
                }
            }
            if (capsule.DefaultInputSlots.Count > 0)
            {
                sb.Append("输入插槽: ");
                sb.AppendLine(string.Join(", ", capsule.DefaultInputSlots.Select(s => $"`{s.SlotId}` ({s.DataType})")));
            }
            if (capsule.DefaultOutputSlots.Count > 0)
            {
                sb.Append("输出插槽: ");
                sb.AppendLine(string.Join(", ", capsule.DefaultOutputSlots.Select(s => $"`{s.SlotId}` ({s.DataType})")));
            }
            sb.AppendLine();
        }

        // 注入当前工作流状态
        if (existingWorkflow != null)
        {
            sb.AppendLine("## 当前工作流");
            sb.AppendLine($"名称: {existingWorkflow.Name}");
            sb.AppendLine($"描述: {existingWorkflow.Description}");
            sb.AppendLine($"节点数: {existingWorkflow.Nodes.Count}");
            if (existingWorkflow.Nodes.Count > 0)
            {
                sb.AppendLine("现有节点:");
                foreach (var node in existingWorkflow.Nodes)
                    sb.AppendLine($"  - `{node.NodeId}` {node.Name} (类型: {node.NodeType})");
            }
            sb.AppendLine();
        }

        sb.AppendLine("""
## 输出格式

当你需要创建或修改工作流时，**必须**在回复中包含一个 JSON 代码块（用 ```json 包裹），格式如下:

```json
{
  "name": "工作流名称",
  "description": "工作流描述",
  "nodes": [
    {
      "nodeId": "node-1",
      "name": "步骤名称",
      "nodeType": "http-request",
      "config": {
        "url": "https://example.com/api",
        "method": "GET"
      },
      "inputSlots": [],
      "outputSlots": [
        { "slotId": "http-out", "name": "response", "dataType": "json", "required": true }
      ]
    }
  ],
  "edges": [
    {
      "edgeId": "e1",
      "sourceNodeId": "node-1",
      "sourceSlotId": "http-out",
      "targetNodeId": "node-2",
      "targetSlotId": "extract-in"
    }
  ],
  "variables": [
    {
      "key": "api_token",
      "label": "API 令牌",
      "type": "string",
      "required": true,
      "isSecret": true
    }
  ]
}
```

## 代码转换规则

将代码中的操作映射到舱类型:
1. `requests.get/post` 或 HTTP 调用 → `http-request` 舱
2. 循环请求 / 分页抓取 → `smart-http` 舱（自动分页）
3. JSON 解析 / 字段提取 → `data-extractor` 舱（JSONPath）
4. Pandas / 数据格式化 → `format-converter` 舱
5. 文件写入 / 导出 → `file-exporter` 舱
6. 条件判断 / if-else → `condition` 舱
7. Cookie / Token / 密钥 → 提取为工作流变量（设置 isSecret: true）
8. AI 分析 / LLM 调用 → `llm-analyzer` 舱
9. TAPD API 调用 → `tapd-collector` 舱（专用，支持 Bug/Story/Task/Iteration）
10. 延时等待 → `delay` 舱

## 注意事项
- nodeId 使用简短的 kebab-case，如 "node-1", "fetch-bugs", "export-csv"
- 每个节点的 outputSlots 和 inputSlots 必须与舱类型的默认插槽匹配
- edges 连接上游的 outputSlot 到下游的 inputSlot
- 变量引用格式为 {{变量key}}，可在节点 config 中使用
- 如果用户只是在聊天不需要配置工作流，正常回复即可，不要输出 JSON
""");

        return sb.ToString();
    }

    /// <summary>从 LLM 回复中提取 JSON 工作流配置</summary>
    private static WorkflowChatGenerated? TryParseWorkflowFromResponse(string responseText)
    {
        // 查找 ```json ... ``` 代码块
        var jsonStart = responseText.IndexOf("```json", StringComparison.OrdinalIgnoreCase);
        if (jsonStart < 0) return null;

        jsonStart = responseText.IndexOf('\n', jsonStart);
        if (jsonStart < 0) return null;
        jsonStart++;

        var jsonEnd = responseText.IndexOf("```", jsonStart, StringComparison.Ordinal);
        if (jsonEnd < 0) return null;

        var jsonStr = responseText[jsonStart..jsonEnd].Trim();
        if (string.IsNullOrWhiteSpace(jsonStr)) return null;

        try
        {
            var options = new JsonSerializerOptions
            {
                PropertyNameCaseInsensitive = true,
                PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
            };
            var generated = JsonSerializer.Deserialize<WorkflowChatGenerated>(jsonStr, options);
            if (generated?.Nodes == null || generated.Nodes.Count == 0) return null;

            // 校验舱类型合法性
            foreach (var node in generated.Nodes)
            {
                if (!CapsuleTypes.All.Contains(node.NodeType) && !WorkflowNodeTypes.All.Contains(node.NodeType))
                    return null;
            }

            return generated;
        }
        catch
        {
            return null;
        }
    }

    private async Task WriteSseEvent(string eventName, object data)
    {
        var json = JsonSerializer.Serialize(data, SseJsonOptions);
        await Response.WriteAsync($"event: {eventName}\ndata: {json}\n\n");
        await Response.Body.FlushAsync();
    }

    /// <summary>
    /// 订阅工作流执行事件流（SSE）：实时推送节点状态变更。
    /// 支持 afterSeq 断线续传。
    /// </summary>
    [HttpGet("executions/{executionId}/stream")]
    [Produces("text/event-stream")]
    public async Task StreamExecution(string executionId, [FromQuery] long afterSeq = 0, CancellationToken cancellationToken = default)
    {
        Response.ContentType = "text/event-stream";
        Response.Headers.CacheControl = "no-cache";
        Response.Headers.Connection = "keep-alive";

        var execution = await _db.WorkflowExecutions.Find(e => e.Id == executionId)
            .Project(e => new { e.Status })
            .FirstOrDefaultAsync(cancellationToken);

        if (execution == null)
        {
            await Response.WriteAsync($"event: error\ndata: {{\"errorCode\":\"NOT_FOUND\",\"errorMessage\":\"执行记录不存在\"}}\n\n", cancellationToken);
            return;
        }

        if (afterSeq <= 0)
        {
            var last = (Request.Headers["Last-Event-ID"].FirstOrDefault() ?? "").Trim();
            if (long.TryParse(last, out var parsed) && parsed > 0) afterSeq = parsed;
        }

        var lastKeepAliveAt = DateTime.UtcNow;
        var isTerminal = false;

        while (!cancellationToken.IsCancellationRequested && !isTerminal)
        {
            // Keepalive
            if ((DateTime.UtcNow - lastKeepAliveAt).TotalSeconds >= 10)
            {
                try
                {
                    await Response.WriteAsync(": keepalive\n\n", cancellationToken);
                    await Response.Body.FlushAsync(cancellationToken);
                }
                catch { break; }
                lastKeepAliveAt = DateTime.UtcNow;
            }

            var batch = await _eventStore.GetEventsAsync("workflow", executionId, afterSeq, limit: 100, cancellationToken);
            if (batch.Count > 0)
            {
                foreach (var ev in batch)
                {
                    try
                    {
                        await Response.WriteAsync($"id: {ev.Seq}\n", cancellationToken);
                        await Response.WriteAsync($"event: {ev.EventName}\n", cancellationToken);
                        await Response.WriteAsync($"data: {ev.PayloadJson}\n\n", cancellationToken);
                        await Response.Body.FlushAsync(cancellationToken);
                    }
                    catch { break; }
                    afterSeq = ev.Seq;
                    lastKeepAliveAt = DateTime.UtcNow;

                    // 执行完成后结束流
                    if (ev.EventName == "execution-completed")
                        isTerminal = true;
                }
            }
            else
            {
                try { await Task.Delay(400, cancellationToken); }
                catch { break; }
            }
        }
    }
}

// ─────────────────────────────────────────────────────────────
// Request DTOs
// ─────────────────────────────────────────────────────────────

#region Request DTOs

public class CreateWorkflowRequest
{
    public string? Name { get; set; }
    public string? Description { get; set; }
    public string? Icon { get; set; }
    public List<string>? Tags { get; set; }
    public List<WorkflowNode>? Nodes { get; set; }
    public List<WorkflowEdge>? Edges { get; set; }
    public List<WorkflowVariable>? Variables { get; set; }
    public List<WorkflowTrigger>? Triggers { get; set; }
}

public class UpdateWorkflowRequest
{
    public string? Name { get; set; }
    public string? Description { get; set; }
    public string? Icon { get; set; }
    public List<string>? Tags { get; set; }
    public List<WorkflowNode>? Nodes { get; set; }
    public List<WorkflowEdge>? Edges { get; set; }
    public List<WorkflowVariable>? Variables { get; set; }
    public List<WorkflowTrigger>? Triggers { get; set; }
    public bool? IsEnabled { get; set; }
}

public class ExecuteWorkflowRequest
{
    public Dictionary<string, string>? Variables { get; set; }
}

public class CreateShareRequest
{
    /// <summary>public | authenticated</summary>
    public string? AccessLevel { get; set; }
    public int? ExpiresInDays { get; set; }
}

// ─────────────────────── 舱测试运行 ───────────────────────

public class CapsuleTestRunRequest
{
    /// <summary>舱类型 Key</summary>
    public string TypeKey { get; set; } = string.Empty;

    /// <summary>舱配置（字段由 ConfigSchema 定义）</summary>
    public Dictionary<string, object?>? Config { get; set; }

    /// <summary>模拟输入数据（用于测试）</summary>
    public object? MockInput { get; set; }
}

public class CapsuleTestRunResult
{
    public string TypeKey { get; set; } = string.Empty;
    public string TypeName { get; set; } = string.Empty;

    /// <summary>completed | failed</summary>
    public string Status { get; set; } = "completed";

    public DateTime StartedAt { get; set; }
    public DateTime CompletedAt { get; set; }
    public long DurationMs { get; set; }

    /// <summary>执行日志</summary>
    public string? Logs { get; set; }

    /// <summary>执行产物</summary>
    public List<TestRunArtifact> Artifacts { get; set; } = new();

    public string? ErrorMessage { get; set; }
}

public class TestRunArtifact
{
    public string Name { get; set; } = string.Empty;
    public string MimeType { get; set; } = string.Empty;
    public long SizeBytes { get; set; }
    public string? InlineContent { get; set; }
}

// ─────────────────────── 对话助手 ───────────────────────

public class WorkflowChatRequest
{
    /// <summary>已有工作流 ID（为空则创建新工作流）</summary>
    public string? WorkflowId { get; set; }

    /// <summary>用户指令</summary>
    public string Instruction { get; set; } = string.Empty;

    /// <summary>代码片段（可选）</summary>
    public string? CodeSnippet { get; set; }

    /// <summary>代码仓库 URL（可选）</summary>
    public string? CodeUrl { get; set; }
}

public class AnalyzeExecutionRequest
{
    /// <summary>用户补充说明（可选）</summary>
    public string? Instruction { get; set; }
}

#endregion
