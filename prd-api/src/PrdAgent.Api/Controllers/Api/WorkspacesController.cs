using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Api.Extensions;
using PrdAgent.Api.Services;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 工作空间 — CLI Agent 持久化交互会话（对话 + 预览 + 多轮迭代）
/// </summary>
[ApiController]
[Route("api/workspaces")]
[Authorize]
[AdminController("workspaces", AdminPermissionCatalog.WorkspacesRead, WritePermission = AdminPermissionCatalog.WorkspacesWrite)]
public class WorkspacesController : ControllerBase
{
    private readonly MongoDbContext _db;
    private readonly IServiceProvider _sp;
    private readonly ILogger<WorkspacesController> _logger;

    private const string AppKey = "page-agent";

    public WorkspacesController(MongoDbContext db, IServiceProvider sp, ILogger<WorkspacesController> logger)
    {
        _db = db;
        _sp = sp;
        _logger = logger;
    }

    private string GetUserId() => this.GetRequiredUserId();

    // ─────────────────────────────────────────────
    // 创建工作空间
    // ─────────────────────────────────────────────

    public record CreateWorkspaceRequest(
        string Name,
        string? ExecutorType = "builtin-llm",
        string? Framework = "html",
        string? Style = "ui-ux-pro-max",
        string? Spec = "none",
        string? DockerImage = null,
        string? ApiEndpoint = null);

    [HttpPost]
    public async Task<IActionResult> Create([FromBody] CreateWorkspaceRequest req)
    {
        var workspace = new Workspace
        {
            UserId = GetUserId(),
            Name = req.Name,
            ExecutorType = req.ExecutorType ?? "builtin-llm",
            Framework = req.Framework ?? "html",
            Style = req.Style ?? "ui-ux-pro-max",
            Spec = req.Spec ?? "none",
            DockerImage = req.DockerImage,
            ApiEndpoint = req.ApiEndpoint,
        };

        await _db.Workspaces.InsertOneAsync(workspace);
        _logger.LogInformation("Workspace created: {Id} by {UserId}, executor={Executor}", workspace.Id, workspace.UserId, workspace.ExecutorType);

        return Ok(new { workspace.Id, workspace.Name, workspace.ExecutorType, workspace.Status });
    }

    // ─────────────────────────────────────────────
    // 查询
    // ─────────────────────────────────────────────

    [HttpGet]
    public async Task<IActionResult> List([FromQuery] int pageSize = 20, [FromQuery] int page = 1)
    {
        var userId = GetUserId();
        var filter = Builders<Workspace>.Filter.Eq(w => w.UserId, userId);
        var total = await _db.Workspaces.CountDocumentsAsync(filter);
        var items = await _db.Workspaces
            .Find(filter)
            .SortByDescending(w => w.LastActiveAt ?? w.CreatedAt)
            .Skip((page - 1) * pageSize)
            .Limit(pageSize)
            .ToListAsync();

        return Ok(new { items, total, page, pageSize });
    }

    [HttpGet("{id}")]
    public async Task<IActionResult> GetById(string id)
    {
        var workspace = await _db.Workspaces.Find(w => w.Id == id && w.UserId == GetUserId()).FirstOrDefaultAsync();
        if (workspace == null) return NotFound(new { error = "工作空间不存在" });
        return Ok(workspace);
    }

    // ─────────────────────────────────────────────
    // 发送指令（核心：多轮对话 + 流式响应）
    // ─────────────────────────────────────────────

    public record ChatRequest(string Message);

    [HttpPost("{id}/chat")]
    public async Task Chat(string id, [FromBody] ChatRequest req)
    {
        var workspace = await _db.Workspaces.Find(w => w.Id == id && w.UserId == GetUserId()).FirstOrDefaultAsync();
        if (workspace == null) { Response.StatusCode = 404; return; }

        // SSE 头
        Response.ContentType = "text/event-stream";
        Response.Headers.Append("Cache-Control", "no-cache");
        Response.Headers.Append("Connection", "keep-alive");

        async Task WriteSse(string eventType, object data)
        {
            var json = System.Text.Json.JsonSerializer.Serialize(data);
            await Response.WriteAsync($"event: {eventType}\ndata: {json}\n\n");
            await Response.Body.FlushAsync();
        }

        try
        {
            // 1. 记录用户消息
            var round = workspace.RoundCount + 1;
            var userMsg = new WorkspaceMessage { Role = "user", Content = req.Message, Round = round };
            var pushUser = Builders<Workspace>.Update
                .Push(w => w.Messages, userMsg)
                .Set(w => w.Status, WorkspaceStatuses.Running)
                .Set(w => w.LastActiveAt, DateTime.UtcNow);
            await _db.Workspaces.UpdateOneAsync(w => w.Id == id, pushUser);

            await WriteSse("phase", new { phase = "thinking", message = "分析指令…" });

            // 2. 构建执行器上下文并调用
            var node = BuildWorkflowNode(workspace);
            var variables = new Dictionary<string, string>
            {
                ["__triggeredBy"] = workspace.UserId,
                ["__executionId"] = $"ws-{workspace.Id}-r{round}",
            };

            var inputArtifacts = new List<ExecutionArtifact>();
            if (!string.IsNullOrWhiteSpace(workspace.LatestHtmlOutput))
                inputArtifacts.Add(new ExecutionArtifact { SlotId = "cli-prev-in", Name = "previousOutput", MimeType = "text/html", InlineContent = workspace.LatestHtmlOutput });
            inputArtifacts.Add(new ExecutionArtifact { SlotId = "cli-feedback-in", Name = "userFeedback", MimeType = "text/plain", InlineContent = req.Message });

            CapsuleExecutor.EmitEventDelegate emitEvent = async (eventName, payload) =>
            {
                await WriteSse(eventName, payload);
            };

            var result = await CapsuleExecutor.ExecuteCliAgentAsync(_sp, node, variables, inputArtifacts, emitEvent);

            // 3. 提取 HTML 产物
            var htmlArtifact = result.Artifacts.FirstOrDefault(a => a.SlotId == "cli-html-out");
            var htmlContent = htmlArtifact?.InlineContent ?? "";

            // 4. 发布到 HostedSite
            string? siteId = null;
            string? previewUrl = null;
            if (!string.IsNullOrWhiteSpace(htmlContent) && htmlContent.Contains("<html", StringComparison.OrdinalIgnoreCase))
            {
                try
                {
                    var siteService = _sp.GetRequiredService<IHostedSiteService>();
                    var site = await siteService.CreateFromContentAsync(
                        userId: workspace.UserId,
                        htmlContent: htmlContent,
                        title: $"{workspace.Name} - 第{round}轮",
                        description: req.Message,
                        sourceType: "workspace",
                        sourceRef: workspace.Id,
                        tags: new List<string> { "workspace", "auto-gen" },
                        folder: "工作空间",
                        ct: CancellationToken.None);
                    siteId = site.Id;
                    previewUrl = site.SiteUrl;
                    await WriteSse("preview", new { siteId, url = previewUrl });
                }
                catch (Exception ex)
                {
                    _logger.LogWarning(ex, "Workspace {Id}: Failed to publish to HostedSite", id);
                }
            }

            // 5. 记录 assistant 消息并更新状态
            var assistantMsg = new WorkspaceMessage
            {
                Role = "assistant",
                Content = $"第{round}轮生成完成",
                Round = round,
                SiteId = siteId,
                PreviewUrl = previewUrl,
                FilesChanged = 1,
            };
            var updateDone = Builders<Workspace>.Update
                .Push(w => w.Messages, assistantMsg)
                .Set(w => w.Status, WorkspaceStatuses.Idle)
                .Set(w => w.RoundCount, round)
                .Set(w => w.LatestSiteId, siteId)
                .Set(w => w.LatestPreviewUrl, previewUrl)
                .Set(w => w.LatestHtmlOutput, htmlContent)
                .Set(w => w.LastActiveAt, DateTime.UtcNow);
            await _db.Workspaces.UpdateOneAsync(w => w.Id == id, updateDone);

            await WriteSse("done", new { round, siteId, previewUrl, filesChanged = 1 });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Workspace {Id} chat failed", id);
            var updateErr = Builders<Workspace>.Update
                .Set(w => w.Status, WorkspaceStatuses.Error)
                .Set(w => w.ErrorMessage, ex.Message);
            await _db.Workspaces.UpdateOneAsync(w => w.Id == id, updateErr);

            await WriteSse("error", new { message = ex.Message });
        }
    }

    // ─────────────────────────────────────────────
    // 删除
    // ─────────────────────────────────────────────

    [HttpDelete("{id}")]
    public async Task<IActionResult> Delete(string id)
    {
        var result = await _db.Workspaces.DeleteOneAsync(w => w.Id == id && w.UserId == GetUserId());
        return result.DeletedCount > 0 ? Ok(new { deleted = true }) : NotFound();
    }

    // ─────────────────────────────────────────────
    // 工具方法
    // ─────────────────────────────────────────────

    /// <summary>将 Workspace 配置转为 WorkflowNode，复用 CapsuleExecutor</summary>
    private static WorkflowNode BuildWorkflowNode(Workspace ws)
    {
        return new WorkflowNode
        {
            NodeId = $"ws-{ws.Id}",
            Name = ws.Name,
            NodeType = CapsuleTypes.CliAgentExecutor,
            Config = new Dictionary<string, object?>
            {
                ["executorType"] = ws.ExecutorType,
                ["spec"] = ws.Spec,
                ["framework"] = ws.Framework,
                ["style"] = ws.Style,
                ["image"] = ws.DockerImage,
                ["apiEndpoint"] = ws.ApiEndpoint,
                ["prompt"] = "", // prompt 通过 userFeedback 输入槽传入
            },
            InputSlots = CapsuleTypeRegistry.CliAgentExecutor.DefaultInputSlots.ToList(),
            OutputSlots = CapsuleTypeRegistry.CliAgentExecutor.DefaultOutputSlots.ToList(),
        };
    }
}
