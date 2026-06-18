using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.LlmGateway;

namespace PrdAgent.Api.Services;

/// <summary>
/// 营销问策 AI 引擎 — 基于客户全量信息 + 动态跟进 + 问策知识库（全域粉销/4FM），
/// 产出结构化营销评估内容（JSON），由调用方渲染进固定 HTML 模版。
/// 对照 PmAgentService.GenerateBriefingAsync 复用：流式 + 自动重试 + 模型名捕获（规则 ai-model-visibility）。
/// LLM 调用统一走 ILlmGateway + CancellationToken.None（规则 server-authority / llm-gateway）。
/// </summary>
public class MarketingConsultService
{
    private readonly ILlmGateway _gateway;
    private readonly ILogger<MarketingConsultService> _logger;

    public MarketingConsultService(ILlmGateway gateway, ILogger<MarketingConsultService> logger)
    {
        _gateway = gateway;
        _logger = logger;
    }

    /// <summary>
    /// 生成营销问策评估内容（JSON）。customerSummary = 客户硬数据 + 动态跟进 + 用户输入；
    /// knowledgeContext = 问策知识库摘录（可空）。onModel 回传实际调度模型名（落库 + 前端可见）。
    /// </summary>
    public async Task<MarketingConsultAiContent?> GenerateAsync(
        string customerSummary, string? knowledgeContext, string userId,
        Func<string, Task>? onContent, Func<string, Task>? onThinking,
        Action<string>? onError, Action<string>? onModel = null)
    {
        var sb = new StringBuilder();
        sb.AppendLine("以下是该客户的情况（基础档案 + 动态跟进 + 用户补充，数据以此为准，不得编造）：");
        sb.AppendLine(customerSummary);
        if (!string.IsNullOrWhiteSpace(knowledgeContext))
        {
            sb.AppendLine();
            sb.AppendLine("以下是问策知识库参考（全域粉销 / 营销四力 4FM 等方法论，作为评估视角与术语依据，不要原文照搬）：");
            sb.AppendLine(knowledgeContext);
        }

        var request = new GatewayRequest
        {
            AppCallerCode = AppCallerRegistry.Product.MarketingConsult,
            ModelType = ModelTypes.Chat,
            RequestBody = new JsonObject
            {
                ["messages"] = new JsonArray
                {
                    new JsonObject { ["role"] = "system", ["content"] = BuildSystemPrompt() },
                    new JsonObject { ["role"] = "user", ["content"] = sb.ToString() }
                },
                ["temperature"] = 0.4,
                ["include_reasoning"] = true,
                ["reasoning"] = new JsonObject { ["exclude"] = false },
            },
            TimeoutSeconds = 180,
            IncludeThinking = true,
            Context = new GatewayRequestContext { UserId = userId }
        };
        var (full, err) = await StreamAndAccumulateAsync(request, onContent, onThinking, onModel);
        if (err != null) { onError?.Invoke(err); return null; }
        if (string.IsNullOrWhiteSpace(full)) { onError?.Invoke("LLM 返回空内容（模型响应为空）"); return null; }
        var parsed = ParseContent(full);
        if (parsed == null) onError?.Invoke("评估内容解析失败（LLM 未按 JSON 格式输出）");
        return parsed;
    }

    private static string BuildSystemPrompt()
        => "你是资深品牌营销顾问，精通「全域粉销」与「营销四力模型（4FM：产品力 / 渠道力 / 场景力 / 传播力）」，"
         + "正在为一个商户/客户做一份专业的【营销问策评估】。"
         + "基于用户提供的客户真实情况（档案、所在行业/区域、跟进记录、用户补充）与问策知识库方法论，"
         + "做出有依据、可落地的营销诊断与建议。语言专业克制、基于事实，引用真实信息，不空话不夸大。禁止使用任何 emoji 字符。"
         + "输出严格 JSON（只输出 JSON，不要任何额外说明、不要 markdown 代码围栏之外的文字）：\n"
         + "{\n"
         + "  \"summary\": \"总体营销评估摘要，2-4 句，给没时间看细节的决策者\",\n"
         + "  \"verdict\": \"healthy|watch|risk（整体营销健康判定）\",\n"
         + "  \"verdictNote\": \"一句话判定依据\",\n"
         + "  \"forces\": [\n"
         + "    {\"name\": \"产品力\", \"score\": 0-100, \"comment\": \"一句话点评\"},\n"
         + "    {\"name\": \"渠道力\", \"score\": 0-100, \"comment\": \"一句话点评\"},\n"
         + "    {\"name\": \"场景力\", \"score\": 0-100, \"comment\": \"一句话点评\"},\n"
         + "    {\"name\": \"传播力\", \"score\": 0-100, \"comment\": \"一句话点评\"}\n"
         + "  ],\n"
         + "  \"strengths\": [\"核心优势，3-6 条，每条一句话\"],\n"
         + "  \"risks\": [{\"text\": \"风险/问题描述及影响\", \"level\": \"high|medium|low\"}],\n"
         + "  \"suggestions\": [\"营销建议，3-6 条，专业且可落地\"],\n"
         + "  \"nextActions\": [\"下一步行动，2-5 条，具体可验收，可含责任建议\"]\n"
         + "}\n"
         + "forces 必须固定输出上述四个维度（产品力/渠道力/场景力/传播力），score 为 0-100 整数。";

    private static MarketingConsultAiContent? ParseContent(string content)
    {
        try
        {
            var start = content.IndexOf('{');
            var end = content.LastIndexOf('}');
            if (start < 0 || end <= start) return null;
            var obj = JsonSerializer.Deserialize<JsonObject>(content[start..(end + 1)]);
            if (obj == null) return null;
            var result = new MarketingConsultAiContent
            {
                Summary = obj["summary"]?.GetValue<string>() ?? string.Empty,
                Verdict = NormalizeVerdict(obj["verdict"]?.GetValue<string>()),
                VerdictNote = obj["verdictNote"]?.GetValue<string>() ?? string.Empty,
            };
            if (obj["forces"] is JsonArray fs)
                foreach (var f in fs)
                {
                    if (f is not JsonObject fo) continue;
                    var name = fo["name"]?.GetValue<string>();
                    if (string.IsNullOrWhiteSpace(name)) continue;
                    int score = 0;
                    try { score = (int)Math.Round(fo["score"]?.GetValue<double>() ?? 0); } catch { score = 0; }
                    result.Forces.Add(new MarketingForceScore
                    {
                        Name = name,
                        Score = Math.Clamp(score, 0, 100),
                        Comment = fo["comment"]?.GetValue<string>() ?? string.Empty,
                    });
                }
            if (obj["strengths"] is JsonArray ss)
                foreach (var s in ss) { var v = s?.GetValue<string>(); if (!string.IsNullOrWhiteSpace(v)) result.Strengths.Add(v); }
            if (obj["risks"] is JsonArray rs)
                foreach (var r in rs)
                {
                    if (r is not JsonObject ro) continue;
                    var text = ro["text"]?.GetValue<string>();
                    if (string.IsNullOrWhiteSpace(text)) continue;
                    result.Risks.Add(new MarketingConsultRisk { Text = text, Level = NormalizeLevel(ro["level"]?.GetValue<string>()) });
                }
            if (obj["suggestions"] is JsonArray sg)
                foreach (var s in sg) { var v = s?.GetValue<string>(); if (!string.IsNullOrWhiteSpace(v)) result.Suggestions.Add(v); }
            if (obj["nextActions"] is JsonArray na)
                foreach (var n in na) { var v = n?.GetValue<string>(); if (!string.IsNullOrWhiteSpace(v)) result.NextActions.Add(v); }
            return string.IsNullOrWhiteSpace(result.Summary) ? null : result;
        }
        catch
        {
            return null;
        }
    }

    private static string NormalizeVerdict(string? v)
        => v is "healthy" or "watch" or "risk" ? v : "watch";

    private static string NormalizeLevel(string? l)
        => l is "high" or "medium" or "low" ? l : "medium";

    /// <summary>带自动重试的流式调用（同 PmAgentService）：无产出时重试，已有部分产出则不重试避免重复。</summary>
    private async Task<(string content, string? error)> StreamAndAccumulateAsync(
        GatewayRequest request, Func<string, Task>? onContent, Func<string, Task>? onThinking, Action<string>? onModel)
    {
        const int maxAttempts = 3;
        string? lastError = null;
        for (var attempt = 1; attempt <= maxAttempts; attempt++)
        {
            var (content, error) = await StreamOnceAsync(request, onContent, onThinking, onModel);
            if (error == null) return (content, null);
            lastError = error;
            if (content.Length > 0) return (content, error);
            if (attempt < maxAttempts)
            {
                _logger.LogWarning("[marketing-consult] LLM 流式失败（第 {Attempt}/{Max} 次）：{Error}，800ms 后重试",
                    attempt, maxAttempts, error);
                await Task.Delay(TimeSpan.FromMilliseconds(800));
            }
        }
        return (string.Empty, lastError);
    }

    private async Task<(string content, string? error)> StreamOnceAsync(
        GatewayRequest request, Func<string, Task>? onContent, Func<string, Task>? onThinking, Action<string>? onModel)
    {
        var buffer = new StringBuilder();
        try
        {
            await foreach (var chunk in _gateway.StreamAsync(request, CancellationToken.None))
            {
                if (chunk.Type == GatewayChunkType.Error)
                    return (buffer.ToString(), $"LLM 流式失败: {chunk.Error ?? "未知错误"}");

                if (chunk.Type == GatewayChunkType.Start && chunk.Resolution != null && !string.IsNullOrEmpty(chunk.Resolution.ActualModel))
                {
                    try { onModel?.Invoke(chunk.Resolution.ActualModel); }
                    catch (Exception cbEx) { _logger.LogDebug(cbEx, "[marketing-consult] onModel callback ignored"); }
                    continue;
                }
                if (chunk.Type == GatewayChunkType.Thinking && !string.IsNullOrEmpty(chunk.Content))
                {
                    if (onThinking != null)
                    {
                        try { await onThinking(chunk.Content); }
                        catch (Exception cbEx) { _logger.LogDebug(cbEx, "[marketing-consult] onThinking callback ignored"); }
                    }
                    continue;
                }
                if (chunk.Type == GatewayChunkType.Text && !string.IsNullOrEmpty(chunk.Content))
                {
                    buffer.Append(chunk.Content);
                    if (onContent != null)
                    {
                        try { await onContent(chunk.Content); }
                        catch (Exception cbEx) { _logger.LogDebug(cbEx, "[marketing-consult] onContent callback ignored"); }
                    }
                }
            }
            return (buffer.ToString(), null);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[marketing-consult] LLM stream failed: {Error}", ex.Message);
            return (buffer.ToString(), $"LLM 调用异常: {ex.Message}");
        }
    }
}
