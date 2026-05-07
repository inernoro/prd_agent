using System.Text.Json;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Options;
using PrdAgent.Core.Interfaces;
using PrdAgent.Infrastructure.Services.ClaudeSidecar;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// claude-sdk Sidecar 反向调用主服务工具的入口。
///
/// 调用源：Python sidecar 的 ToolBridge（`claude-sdk-sidecar/app/tool_bridge.py`）
/// 鉴权方式：X-Sidecar-Token header，明文比对任一已配置 sidecar 的 Token。
///   双向同 token 是有意为之 —— "调用方"和"被调用方"用同一对称凭据，免去额外的
///   AgentApiKey 签发/吊销心智负担，对运维更"无脑"。
/// 这个端点不对外（不在 OpenAPI 文档中宣传），属于内部基础设施层。
/// </summary>
[ApiController]
[Route("api/agent-tools")]
public class AgentToolsController : ControllerBase
{
    private readonly IAgentToolRegistry _registry;
    private readonly IOptionsMonitor<ClaudeSidecarOptions> _options;
    private readonly ILogger<AgentToolsController> _logger;

    public AgentToolsController(
        IAgentToolRegistry registry,
        IOptionsMonitor<ClaudeSidecarOptions> options,
        ILogger<AgentToolsController> logger)
    {
        _registry = registry;
        _options = options;
        _logger = logger;
    }

    [HttpGet("list")]
    public IActionResult List()
    {
        if (!ValidateToken(out var why))
        {
            _logger.LogWarning("[AgentTools] /list 401 reason={Reason}", why);
            return Unauthorized(new { error = why });
        }

        var tools = _registry.ListAll().Select(t => new
        {
            name = t.Name,
            description = t.Description,
            inputSchema = JsonSerializer.Deserialize<JsonElement>(t.InputSchemaJson),
        });
        return Ok(new { tools });
    }

    [HttpPost("invoke")]
    public async Task<IActionResult> Invoke(
        [FromBody] InvokeRequest req,
        CancellationToken ct)
    {
        if (!ValidateToken(out var why))
        {
            _logger.LogWarning("[AgentTools] /invoke 401 reason={Reason}", why);
            return Unauthorized(new { error = why });
        }

        if (req == null || string.IsNullOrWhiteSpace(req.ToolName))
            return BadRequest(new { error = "toolName required" });

        var inputElement = req.Input ?? JsonDocument.Parse("{}").RootElement;
        var ctx = new AgentToolInvocationContext
        {
            RunId = req.RunId ?? string.Empty,
            AppCallerCode = req.AppCallerCode,
            SidecarName = Request.Headers["X-Sidecar-Name"].FirstOrDefault(),
        };

        var result = await _registry.InvokeAsync(req.ToolName, inputElement, ctx, ct);
        return Ok(new
        {
            success = result.Success,
            content = result.Content,
            errorCode = result.ErrorCode,
            message = result.Message,
        });
    }

    private bool ValidateToken(out string reason)
    {
        var presented = Request.Headers["X-Sidecar-Token"].FirstOrDefault();
        if (string.IsNullOrWhiteSpace(presented))
        {
            reason = "missing X-Sidecar-Token";
            return false;
        }

        var configured = _options.CurrentValue.Sidecars
            .Select(s =>
                !string.IsNullOrWhiteSpace(s.Token)
                    ? s.Token
                    : (!string.IsNullOrWhiteSpace(s.TokenEnvVar)
                        ? Environment.GetEnvironmentVariable(s.TokenEnvVar)
                        : null))
            .Where(t => !string.IsNullOrWhiteSpace(t))
            .Cast<string>()
            .ToList();

        // 兜底：环境变量 CLAUDE_SIDECAR_TOKEN 也作为合法凭据（与 PostConfigure 自动注入对齐）
        var envToken = Environment.GetEnvironmentVariable("CLAUDE_SIDECAR_TOKEN");
        if (!string.IsNullOrWhiteSpace(envToken)) configured.Add(envToken);

        if (configured.Count == 0)
        {
            reason = "no sidecar token configured";
            return false;
        }

        if (configured.Any(t => string.Equals(t, presented, StringComparison.Ordinal)))
        {
            reason = "ok";
            return true;
        }

        reason = "token mismatch";
        return false;
    }

    public sealed class InvokeRequest
    {
        public string? ToolName { get; set; }
        public JsonElement? Input { get; set; }
        public string? RunId { get; set; }
        public string? AppCallerCode { get; set; }
    }
}
