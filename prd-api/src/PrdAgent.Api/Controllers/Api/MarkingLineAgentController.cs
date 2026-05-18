using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using PrdAgent.Api.Extensions;
using PrdAgent.Api.Services.MarkingLineAgent;
using PrdAgent.Api.Services.Streaming;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 赋码产线 Agent：采集关联与产线示意（独立 appKey = marking-line-agent）。
/// </summary>
[ApiController]
[Route("api/marking-line-agent")]
[Authorize]
[AdminController("marking-line-agent", AdminPermissionCatalog.MarkingLineAgentUse)]
public sealed class MarkingLineAgentController : ControllerBase
{
    private readonly MarkingLineDiagramService _diagramService;
    private readonly ILLMRequestContextAccessor _llmRequestContext;
    private readonly ILogger<MarkingLineAgentController> _logger;

    public MarkingLineAgentController(
        MarkingLineDiagramService diagramService,
        ILLMRequestContextAccessor llmRequestContext,
        ILogger<MarkingLineAgentController> logger)
    {
        _diagramService = diagramService;
        _llmRequestContext = llmRequestContext;
        _logger = logger;
    }

    /// <summary>
    /// 根据简述流式生成产线/采集关联示意图说明（SSE：phase / model / thinking / typing / done / error）。
    /// </summary>
    [HttpPost("diagram/stream")]
    [Produces("text/event-stream")]
    public async Task StreamDiagram([FromBody] MarkingLineDiagramStreamRequest? request)
    {
        using var _ = _llmRequestContext.BeginScope(new LlmRequestContext(
            RequestId: Guid.NewGuid().ToString("N"),
            GroupId: null,
            SessionId: null,
            UserId: this.GetRequiredUserId(),
            ViewRole: null,
            DocumentChars: null,
            DocumentHash: null,
            SystemPromptRedacted: null,
            RequestType: "chat",
            AppCallerCode: AppCallerRegistry.MarkingLineAgent.Diagram.Stream,
            ModelResolutionType: null));

        await AiStreamingHelpers.WriteSseStreamAsync(
            Response,
            label: "产线示意图",
            streamFactory: holder => _diagramService.StreamDiagramAsync(
                request?.Brief ?? string.Empty,
                holder),
            logger: _logger);
    }
}

public sealed class MarkingLineDiagramStreamRequest
{
    /// <summary>用户对产线、工位、采集点等的文字描述。</summary>
    public string? Brief { get; set; }
}
