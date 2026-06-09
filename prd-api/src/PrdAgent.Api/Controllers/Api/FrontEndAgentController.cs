using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using PrdAgent.Api.Extensions;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.LlmGateway;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 前端搭档智能体：面向后端同事的前端代码生成、API 接入和问题诊断助手。
/// </summary>
[ApiController]
[Route("api/front-end-agent")]
[Authorize]
[AdminController("front-end-agent", AdminPermissionCatalog.FrontEndAgentUse)]
public class FrontEndAgentController : ControllerBase
{
    private const string AppKey = "front-end-agent";
    private readonly ILlmGateway _gateway;
    private readonly ILLMRequestContextAccessor _llmRequestContext;
    private readonly ILogger<FrontEndAgentController> _logger;

    public FrontEndAgentController(
        ILlmGateway gateway,
        ILLMRequestContextAccessor llmRequestContext,
        ILogger<FrontEndAgentController> logger)
    {
        _gateway = gateway;
        _llmRequestContext = llmRequestContext;
        _logger = logger;
    }

    public sealed class FrontEndAgentStreamRequest
    {
        public string TaskType { get; set; } = "api-adapter";
        public string Requirement { get; set; } = string.Empty;
        public string? ApiSpec { get; set; }
        public string? ExistingCode { get; set; }
        public string? ErrorLog { get; set; }
        public string? ScreenshotNotes { get; set; }
        public string? TargetFramework { get; set; }
        public string? StyleGuidance { get; set; }
    }

    [HttpPost("assist/stream")]
    [Produces("text/event-stream")]
    public async Task AssistStream([FromBody] FrontEndAgentStreamRequest req)
    {
        Response.ContentType = "text/event-stream";
        Response.Headers.CacheControl = "no-cache";
        Response.Headers.Connection = "keep-alive";

        var userId = this.GetRequiredUserId();
        if (req == null || string.IsNullOrWhiteSpace(req.Requirement))
        {
            await WriteSseAsync("error", new { message = "请填写需求、报错或要接入的接口说明" });
            return;
        }

        var taskType = NormalizeTaskType(req.TaskType);
        var userPrompt = BuildUserPrompt(req, taskType);
        var appCallerCode = AppCallerRegistry.FrontEndAgent.Assistant.Chat;
        var gatewayRequest = new GatewayRequest
        {
            AppCallerCode = appCallerCode,
            ModelType = ModelTypes.Chat,
            Stream = true,
            IncludeThinking = true,
            RequestBody = new JsonObject
            {
                ["messages"] = new JsonArray
                {
                    new JsonObject { ["role"] = "system", ["content"] = BuildSystemPrompt(taskType) },
                    new JsonObject { ["role"] = "user", ["content"] = userPrompt },
                },
                ["temperature"] = 0.25,
                ["max_tokens"] = 8192,
                ["include_reasoning"] = true,
                ["reasoning"] = new JsonObject { ["exclude"] = false },
            },
        };

        using var _ = _llmRequestContext.BeginScope(new LlmRequestContext(
            RequestId: Guid.NewGuid().ToString("N"),
            GroupId: null,
            SessionId: null,
            UserId: userId,
            ViewRole: null,
            DocumentChars: userPrompt.Length,
            DocumentHash: null,
            SystemPromptRedacted: $"[{AppKey}:{taskType}]",
            RequestType: "chat",
            AppCallerCode: appCallerCode));

        await WriteSseAsync("phase", new { phase = "preparing", message = GetPreparingMessage(taskType) });

        var startedAt = DateTime.UtcNow;
        var sentModel = false;
        try
        {
            await foreach (var chunk in _gateway.StreamAsync(gatewayRequest, CancellationToken.None))
            {
                if (chunk.Type == GatewayChunkType.Start && !sentModel && chunk.Resolution != null)
                {
                    sentModel = true;
                    await WriteSseAsync("model", new
                    {
                        model = chunk.Resolution.ActualModel,
                        platform = chunk.Resolution.ActualPlatformName,
                    });
                    await WriteSseAsync("phase", new { phase = "working", message = GetWorkingMessage(taskType) });
                }
                else if (chunk.Type == GatewayChunkType.Thinking && !string.IsNullOrEmpty(chunk.Content))
                {
                    try { await WriteSseAsync("thinking", new { text = chunk.Content }); }
                    catch (ObjectDisposedException) { break; }
                }
                else if (chunk.Type == GatewayChunkType.Text && !string.IsNullOrEmpty(chunk.Content))
                {
                    try { await WriteSseAsync("typing", new { text = chunk.Content }); }
                    catch (ObjectDisposedException) { break; }
                }
                else if (chunk.Type == GatewayChunkType.Error)
                {
                    var err = chunk.Error ?? chunk.Content ?? "网关返回未知错误";
                    _logger.LogError("FrontEndAgent gateway error user={UserId} task={TaskType}: {Error}", userId, taskType, err);
                    try { await WriteSseAsync("error", new { message = $"LLM 网关错误: {err}" }); }
                    catch { }
                    return;
                }
            }

            try
            {
                await WriteSseAsync("done", new
                {
                    taskType,
                    elapsedMs = (int)(DateTime.UtcNow - startedAt).TotalMilliseconds,
                });
            }
            catch { }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "FrontEndAgent assist failed user={UserId} task={TaskType}", userId, taskType);
            try { await WriteSseAsync("error", new { message = "前端智能体生成失败：" + ex.Message }); } catch { }
        }
    }

    private static string NormalizeTaskType(string? taskType)
    {
        return taskType?.Trim() switch
        {
            "component" => "component",
            "debug" => "debug",
            "visual-diagnosis" => "visual-diagnosis",
            _ => "api-adapter",
        };
    }

    private static string GetPreparingMessage(string taskType) => taskType switch
    {
        "component" => "正在梳理组件职责、状态边界和可复用结构...",
        "debug" => "正在解析报错、堆栈和可能的前端故障点...",
        "visual-diagnosis" => "正在整理视觉现象、布局约束和 CSS 修复方向...",
        _ => "正在分析接口契约、字段类型和前端调用边界...",
    };

    private static string GetWorkingMessage(string taskType) => taskType switch
    {
        "component" => "AI 正在生成组件代码和接入步骤...",
        "debug" => "AI 正在给出定位路径和最小修复方案...",
        "visual-diagnosis" => "AI 正在输出视觉诊断报告和 CSS 建议...",
        _ => "AI 正在生成类型、service 和页面调用示例...",
    };

    private static string BuildSystemPrompt(string taskType)
    {
        var profile = taskType switch
        {
            "component" => "当前任务：生成可落地的前端组件或页面片段。",
            "debug" => "当前任务：定位前端报错、构建失败、接口调用失败或白屏问题。",
            "visual-diagnosis" => "当前任务：根据用户提供的截图现象、设计稿说明或视觉差异描述，输出样式诊断和修复建议。",
            _ => "当前任务：把后端 API 契约转换为前端类型、请求方法和调用示例。",
        };

        return $$"""
        你是「前端搭档智能体」，服务对象是需要独立完成前端交付的后端同事。

        {{profile}}

        # 工作原则
        - 不要输出空泛解释，默认给可复制代码、文件路径建议和验证命令。
        - 优先 React + TypeScript + Vite + Tailwind 风格；如果用户指定 Vue / 其他技术栈，按用户指定来。
        - 不能假装已经扫描了用户项目；除非用户提供了现有代码，否则只能基于输入材料推断，并明确标注假设。
        - API 调用层要提醒：请求 body 传原始对象，避免重复 JSON.stringify；返回结构要先判断 success。
        - 生成 UI 时必须考虑 loading、empty、error、disabled、可访问性和移动端基本适配。
        - 修复报错时必须按「现象 → 根因候选 → 定位步骤 → 最小修复 → 回归验证」输出。
        - 视觉诊断时必须按「问题区域 → CSS/布局原因 → 修复代码 → 验收标准」输出。
        - 禁止使用任何 emoji 字符；状态用 [P0]、[P1]、[注意]、[可选] 等文本标签。

        # 固定输出结构
        1. 结论摘要：用 3-5 条说明最应该做什么。
        2. 交付文件：列出建议新增或修改的文件路径。
        3. 可复制代码：给出 TypeScript/TSX/CSS 等代码块。
        4. 接入步骤：后端同事照做即可。
        5. 自测清单：列出需要运行的命令和界面验收点。
        6. 风险与假设：明确哪些信息不足、哪些需要用户补充。

        # 代码要求
        - 变量名清晰，避免过度抽象。
        - 不要引入新依赖，除非用户明确要求。
        - 示例代码要能独立阅读，不要只给伪代码。
        """;
    }

    private static string BuildUserPrompt(FrontEndAgentStreamRequest req, string taskType)
    {
        var sb = new StringBuilder();
        sb.AppendLine("# 任务类型");
        sb.AppendLine(taskType);
        AppendBlock(sb, "目标技术栈", req.TargetFramework);
        AppendBlock(sb, "样式/组件约束", req.StyleGuidance);
        AppendBlock(sb, "用户需求", req.Requirement);
        AppendBlock(sb, "API 契约 / Controller / JSON 示例", req.ApiSpec);
        AppendBlock(sb, "现有前端代码", req.ExistingCode);
        AppendBlock(sb, "报错日志 / 构建输出 / 控制台信息", req.ErrorLog);
        AppendBlock(sb, "截图现象 / 设计稿差异描述", req.ScreenshotNotes);
        sb.AppendLine();
        sb.AppendLine("# 请输出");
        sb.AppendLine("请按系统提示词的固定结构输出，让后端同事可以直接复制代码并完成验证。");
        return sb.ToString();
    }

    private static void AppendBlock(StringBuilder sb, string title, string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return;
        sb.AppendLine();
        sb.AppendLine($"# {title}");
        sb.AppendLine(value.Trim());
    }

    private async Task WriteSseAsync(string eventType, object data)
    {
        try
        {
            var json = JsonSerializer.Serialize(data, new JsonSerializerOptions
            {
                PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
            });
            await Response.WriteAsync($"event: {eventType}\ndata: {json}\n\n");
            await Response.Body.FlushAsync();
        }
        catch (ObjectDisposedException) { }
        catch (OperationCanceledException) { }
    }
}
