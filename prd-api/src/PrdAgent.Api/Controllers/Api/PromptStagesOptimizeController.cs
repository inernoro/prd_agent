using System.Text.Json;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using PrdAgent.Api.Json;
using PrdAgent.Api.Models.Requests;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 管理后台 - 提示词：一键优化（SSE）
/// </summary>
[ApiController]
[Route("api/prompts/optimize")]
[Authorize]
[AdminController("prompts", AdminPermissionCatalog.PromptsRead, WritePermission = AdminPermissionCatalog.PromptsWrite)]
public class PromptsOptimizeController : ControllerBase
{
    private readonly ISmartModelScheduler _modelScheduler;
    private readonly ILLMRequestContextAccessor _llmRequestContext;
    private readonly ILogger<PromptsOptimizeController> _logger;

    public PromptsOptimizeController(
        ISmartModelScheduler modelScheduler,
        ILLMRequestContextAccessor llmRequestContext,
        ILogger<PromptsOptimizeController> logger)
    {
        _modelScheduler = modelScheduler;
        _llmRequestContext = llmRequestContext;
        _logger = logger;
    }

    [HttpPost("stream")]
    [Produces("text/event-stream")]
    public async Task OptimizeStream([FromBody] PromptOptimizeStreamRequest request, CancellationToken cancellationToken)
    {
        var (ok, err) = request.Validate();
        Response.ContentType = "text/event-stream";
        Response.Headers.CacheControl = "no-cache";
        Response.Headers.Connection = "keep-alive";

        if (!ok)
        {
            var errorEvent = new PromptOptimizeStreamEvent
            {
                Type = "error",
                ErrorCode = ErrorCodes.INVALID_FORMAT,
                ErrorMessage = err ?? "参数错误"
            };
            var errorData = JsonSerializer.Serialize(errorEvent, AppJsonContext.Default.PromptOptimizeStreamEvent);
            await Response.WriteAsync($"event: optimize\n", cancellationToken);
            await Response.WriteAsync($"data: {errorData}\n\n", cancellationToken);
            await Response.Body.FlushAsync(cancellationToken);
            return;
        }

        var mode = (request.Mode ?? "strict").Trim().ToLowerInvariant();
        var promptKey = (request.PromptKey ?? string.Empty).Trim();
        var title = (request.Title ?? string.Empty).Trim();
        var order = request.Order;

        // system prompt：要求仅输出“优化后的提示词正文”
        var systemPrompt =
            "你是世界一流的提示词工程师，擅长把含糊的提示词改写成清晰、可执行、可复用的模板。\n" +
            "你的任务：将用户提供的提示词（promptTemplate）优化为更标准的版本，用于 PRD 解读助手。\n\n" +
            "强制要求：\n" +
            "1) 输出必须是中文。\n" +
            "2) 只能输出“优化后的 promptTemplate 纯文本”，不要输出解释、不要输出分析、不要加标题、不要包裹 ```。\n" +
            "3) 不得引入新的业务需求或虚构信息；不确定处必须要求用户/PRD 补充，并用“PRD 未覆盖/需补充”表述。\n" +
            "4) 必须保留原文中的占位符/变量（例如 {xxx}、{{xxx}}、<xxx>、[xxx] 等），不得删除、不得改名、不得改含义。\n" +
            "5) 若原文已包含输出结构/格式要求，必须保留并进一步清晰化。\n\n" +
            "优化目标：\n" +
            "- 更清楚：明确关注点、输入与输出、验收标准/风险提示。\n" +
            "- 更稳健：强调缺失信息的处理方式（标注 PRD 未覆盖），避免编造。\n" +
            "- 更可复用：避免写死与用户问题无关的固定口号，减少无关冗余。\n\n" +
            $"优化模式：{mode}（strict=更保守更完整；concise=更简洁但不丢关键约束）。\n";

        var roleText = request.Role.ToString();
        var ctx =
            $"上下文：role={roleText}" +
            (order.HasValue ? $", order={order.Value}" : "") +
            (!string.IsNullOrWhiteSpace(promptKey) ? $", promptKey={promptKey}" : "") +
            (!string.IsNullOrWhiteSpace(title) ? $", title={title}" : "") +
            "\n";

        var userPrompt =
            ctx +
            "原始 promptTemplate：\n" +
            "<<<\n" +
            (request.PromptTemplate ?? string.Empty).Trim() +
            "\n>>>\n\n" +
            "请输出优化后的 promptTemplate：\n";

        var messages = new List<LLMMessage> { new() { Role = "user", Content = userPrompt } };

        try
        {
            var appCallerCode = "admin.prompts.optimize";
            var scheduledResult = await _modelScheduler.GetClientWithGroupInfoAsync(appCallerCode, "chat", cancellationToken);
            using var _ = _llmRequestContext.BeginScope(new LlmRequestContext(
                RequestId: Guid.NewGuid().ToString("N"),
                GroupId: null,
                SessionId: null,
                UserId: null,
                ViewRole: "ADMIN",
                DocumentChars: null,
                DocumentHash: null,
                SystemPromptRedacted: "[PROMPTS_OPTIMIZE]",
                RequestType: "reasoning",
                RequestPurpose: appCallerCode,
                ModelResolutionType: scheduledResult.ResolutionType,
                ModelGroupId: scheduledResult.ModelGroupId,
                ModelGroupName: scheduledResult.ModelGroupName));
            // start
            var startData = JsonSerializer.Serialize(
                new PromptOptimizeStreamEvent { Type = "start" },
                AppJsonContext.Default.PromptOptimizeStreamEvent);
            await Response.WriteAsync($"event: optimize\n", cancellationToken);
            await Response.WriteAsync($"data: {startData}\n\n", cancellationToken);
            await Response.Body.FlushAsync(cancellationToken);

            await foreach (var chunk in scheduledResult.Client.StreamGenerateAsync(systemPrompt, messages, cancellationToken))
            {
                if (chunk.Type == "delta" && !string.IsNullOrEmpty(chunk.Content))
                {
                    var data = JsonSerializer.Serialize(
                        new PromptOptimizeStreamEvent { Type = "delta", Content = chunk.Content },
                        AppJsonContext.Default.PromptOptimizeStreamEvent);
                    await Response.WriteAsync($"event: optimize\n", cancellationToken);
                    await Response.WriteAsync($"data: {data}\n\n", cancellationToken);
                    await Response.Body.FlushAsync(cancellationToken);
                }
                else if (chunk.Type == "error")
                {
                    var data = JsonSerializer.Serialize(
                        new PromptOptimizeStreamEvent
                        {
                            Type = "error",
                            ErrorCode = ErrorCodes.LLM_ERROR,
                            ErrorMessage = chunk.ErrorMessage ?? "LLM 调用失败"
                        },
                        AppJsonContext.Default.PromptOptimizeStreamEvent);
                    await Response.WriteAsync($"event: optimize\n", cancellationToken);
                    await Response.WriteAsync($"data: {data}\n\n", cancellationToken);
                    await Response.Body.FlushAsync(cancellationToken);
                    return;
                }
            }

            var doneData = JsonSerializer.Serialize(
                new PromptOptimizeStreamEvent { Type = "done" },
                AppJsonContext.Default.PromptOptimizeStreamEvent);
            await Response.WriteAsync($"event: optimize\n", cancellationToken);
            await Response.WriteAsync($"data: {doneData}\n\n", cancellationToken);
            await Response.Body.FlushAsync(cancellationToken);
        }
        catch (OperationCanceledException)
        {
            // 客户端取消：不视为异常
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error in prompt optimize SSE stream");
            try
            {
                var data = JsonSerializer.Serialize(
                    new PromptOptimizeStreamEvent
                    {
                        Type = "error",
                        ErrorCode = ErrorCodes.LLM_ERROR,
                        ErrorMessage = "服务异常，请稍后重试"
                    },
                    AppJsonContext.Default.PromptOptimizeStreamEvent);
                await Response.WriteAsync($"event: optimize\n", cancellationToken);
                await Response.WriteAsync($"data: {data}\n\n", cancellationToken);
                await Response.Body.FlushAsync(cancellationToken);
            }
            catch
            {
                // ignore
            }
        }
    }
}


