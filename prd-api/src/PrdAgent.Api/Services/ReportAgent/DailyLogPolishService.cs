using System.Runtime.CompilerServices;
using System.Text;
using System.Text.Json.Nodes;
using PrdAgent.Api.Services.PrReview;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.LlmGateway;

namespace PrdAgent.Api.Services.ReportAgent;

/// <summary>
/// 日常记录条目润色服务（SSE 流式）。
///
/// 用户价值：让用户写完一条原始日志后，一键拿到更简洁/专业的版本。
/// 用户可以在浮层里逐字看到润色结果，自己决定是否替换原文。
///
/// 调用链：ILlmGateway 流式（遵守 llm-gateway + llm-visibility 规则）。
/// AppCallerCode = AppCallerRegistry.ReportAgent.Polish.ItemRefine
///
/// 复用 PrReview 模块的 PrReviewModelInfoHolder + LlmStreamDelta，
/// 与 Controller 的 SSE 心跳/思考/打字逻辑无缝对接。
/// </summary>
public sealed class DailyLogPolishService
{
    private const string AppCallerCode = AppCallerRegistry.ReportAgent.Polish.ItemRefine;
    private const int MaxInputChars = 4000;

    private readonly ILlmGateway _gateway;
    private readonly ILogger<DailyLogPolishService> _logger;

    public DailyLogPolishService(ILlmGateway gateway, ILogger<DailyLogPolishService> logger)
    {
        _gateway = gateway;
        _logger = logger;
    }

    /// <summary>
    /// 流式润色。Controller 用 holder 拿模型信息后推 SSE model 事件。
    /// </summary>
    public async IAsyncEnumerable<LlmStreamDelta> StreamPolishAsync(
        string text,
        string? styleHint,
        PrReviewModelInfoHolder modelInfo,
        [EnumeratorCancellation] CancellationToken ct)
    {
        var trimmed = (text ?? string.Empty).Trim();
        if (trimmed.Length > MaxInputChars)
            trimmed = trimmed[..MaxInputChars];

        var systemPrompt = BuildSystemPrompt();
        var userPrompt = BuildUserPrompt(trimmed, styleHint);

        var gatewayRequest = new GatewayRequest
        {
            AppCallerCode = AppCallerCode,
            ModelType = ModelTypes.Chat,
            Stream = true,
            IncludeThinking = true,
            RequestBody = new JsonObject
            {
                ["messages"] = new JsonArray
                {
                    new JsonObject { ["role"] = "system", ["content"] = systemPrompt },
                    new JsonObject { ["role"] = "user", ["content"] = userPrompt },
                },
                ["temperature"] = 0.4,
                ["max_tokens"] = 1024,
                ["include_reasoning"] = true,
                ["reasoning"] = new JsonObject { ["exclude"] = false },
            },
        };

        // 服务器权威性：客户端断开不取消 LLM
        await foreach (var chunk in _gateway.StreamAsync(gatewayRequest, CancellationToken.None))
        {
            if (chunk.Type == GatewayChunkType.Start && chunk.Resolution != null)
            {
                modelInfo.Model = chunk.Resolution.ActualModel;
                modelInfo.Platform = chunk.Resolution.ActualPlatformName ?? chunk.Resolution.ActualPlatformId;
                modelInfo.ModelGroupName = chunk.Resolution.ModelGroupName;
                modelInfo.Captured = true;
                continue;
            }

            if (chunk.Type == GatewayChunkType.Thinking && !string.IsNullOrEmpty(chunk.Content))
            {
                yield return new LlmStreamDelta(IsThinking: true, Content: chunk.Content!);
            }
            else if (chunk.Type == GatewayChunkType.Text && !string.IsNullOrEmpty(chunk.Content))
            {
                yield return new LlmStreamDelta(IsThinking: false, Content: chunk.Content!);
            }
            else if (chunk.Type == GatewayChunkType.Error)
            {
                var msg = chunk.Error ?? chunk.Content ?? "LLM 网关未知错误";
                _logger.LogWarning("DailyLog polish stream error: {Error}", msg);
                throw new InvalidOperationException(msg);
            }
        }
    }

    private static string BuildSystemPrompt() => """
你是一位职业化的周报助手，任务是润色用户的「日常记录」单条原文。

要求：
1. 让表达更简洁、专业、具体；保留原文的全部信息量。
2. 不要杜撰任何细节，只能基于原文有的事实改写。
3. 不要使用 markdown 标题（# / ##）或列表符号（- / *）。
4. 不要给出多个候选；只输出一条最终结果。
5. 如果原文里有 markdown 图片（![alt](url)）或链接，原样保留。
6. 直接输出润色后的内容，不要加任何解释、前言、引号或"润色后："之类的标签。
7. 长度与原文相当，不要扩写成段。
""";

    private static string BuildUserPrompt(string text, string? styleHint)
    {
        var sb = new StringBuilder();
        sb.AppendLine("【原文】");
        sb.AppendLine(text);
        if (!string.IsNullOrWhiteSpace(styleHint))
        {
            sb.AppendLine();
            sb.AppendLine("【风格偏好】");
            sb.AppendLine(styleHint!.Trim());
        }
        sb.AppendLine();
        sb.AppendLine("请按 system 的要求输出润色后的版本。");
        return sb.ToString();
    }
}
