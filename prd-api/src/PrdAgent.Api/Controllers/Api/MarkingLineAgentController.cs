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
    private readonly MarkingLineDiagramImageService _diagramImageService;
    private readonly ILLMRequestContextAccessor _llmRequestContext;
    private readonly ILogger<MarkingLineAgentController> _logger;

    public MarkingLineAgentController(
        MarkingLineDiagramService diagramService,
        MarkingLineDiagramImageService diagramImageService,
        ILLMRequestContextAccessor llmRequestContext,
        ILogger<MarkingLineAgentController> logger)
    {
        _diagramService = diagramService;
        _diagramImageService = diagramImageService;
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

    /// <summary>
    /// 根据简述生成产线示意图位图（PNG 等，由上游模型决定）。先 Chat 整理英文提示词，再文生图；返回 url 或 base64。
    /// </summary>
    [HttpPost("diagram/image")]
    [Produces("application/json")]
    public async Task<IActionResult> RenderDiagramImage([FromBody] MarkingLineDiagramImageHttpRequest? request)
    {
        try
        {
            var userId = this.GetRequiredUserId();
            var format = string.IsNullOrWhiteSpace(request?.ResponseFormat) ? "url" : request!.ResponseFormat!.Trim();

            var result = await _diagramImageService.TryGenerateAsync(
                userId,
                request?.Brief ?? string.Empty,
                format,
                CancellationToken.None).ConfigureAwait(false);

            if (!result.Success)
            {
                var code = result.ErrorCode ?? ErrorCodes.LLM_ERROR;
                var message = result.ErrorMessage ?? "图片生成失败";
                if (string.Equals(code, ErrorCodes.CONTENT_EMPTY, StringComparison.Ordinal))
                {
                    return BadRequest(ApiResponse<MarkingLineDiagramImageHttpDto>.Fail(code, message));
                }

                if (string.Equals(code, ErrorCodes.INVALID_FORMAT, StringComparison.Ordinal))
                {
                    return BadRequest(ApiResponse<MarkingLineDiagramImageHttpDto>.Fail(code, message));
                }

                return StatusCode(502, ApiResponse<MarkingLineDiagramImageHttpDto>.Fail(code, message));
            }

            var dto = new MarkingLineDiagramImageHttpDto
            {
                ImageUrl = result.ImageUrl,
                ImageBase64 = result.ImageBase64,
                MimeType = result.MimeType,
                ImagePromptUsed = result.ImagePromptUsed,
                RevisedPrompt = result.RevisedPrompt,
                PromptComposerModel = result.PromptComposerModel,
                PromptComposerPlatform = result.PromptComposerPlatform,
            };

            return Ok(ApiResponse<MarkingLineDiagramImageHttpDto>.Ok(dto));
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "MarkingLine diagram image endpoint failed");
            return StatusCode(
                500,
                ApiResponse<MarkingLineDiagramImageHttpDto>.Fail(
                    ErrorCodes.LLM_ERROR,
                    $"生图请求处理异常：{ex.Message}"));
        }
    }
}

public sealed class MarkingLineDiagramStreamRequest
{
    /// <summary>用户对产线、工位、采集点等的文字描述。</summary>
    public string? Brief { get; set; }
}

public sealed class MarkingLineDiagramImageHttpRequest
{
    /// <summary>用户对产线、工位、采集点等的文字描述。</summary>
    public string? Brief { get; set; }

    /// <summary>上游生图返回格式：<c>url</c>（默认）或 <c>b64_json</c>。</summary>
    public string? ResponseFormat { get; set; }
}

public sealed class MarkingLineDiagramImageHttpDto
{
    public string? ImageUrl { get; set; }
    public string? ImageBase64 { get; set; }
    public string? MimeType { get; set; }
    public string? ImagePromptUsed { get; set; }
    public string? RevisedPrompt { get; set; }
    public string? PromptComposerModel { get; set; }
    public string? PromptComposerPlatform { get; set; }
}
