using System.Text.Json;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;

namespace PrdAgent.Core.Services;

/// <summary>
/// AI缺口检测器
/// </summary>
public class AIGapDetector
{
    private readonly ILLMClient _llmClient;
    private readonly IPromptManager _promptManager;

    public AIGapDetector(ILLMClient llmClient, IPromptManager promptManager)
    {
        _llmClient = llmClient;
        _promptManager = promptManager;
    }

    /// <summary>
    /// 分析问题是否揭示了PRD中的内容缺口
    /// </summary>
    public async Task<GapAnalysisResult?> AnalyzeQuestionAsync(
        string prdContent,
        string question,
        string aiResponse,
        CancellationToken cancellationToken = default)
    {
        var prompt = BuildAnalysisPrompt(prdContent, question, aiResponse);
        
        var messages = new List<LLMMessage>
        {
            new() { Role = "user", Content = prompt }
        };

        var responseBuilder = new System.Text.StringBuilder();
        
        await foreach (var chunk in _llmClient.StreamGenerateAsync(
            "你是一个专业的PRD分析助手，帮助识别文档中的内容缺口。",
            messages,
            cancellationToken))
        {
            if (chunk.Type == "delta" && !string.IsNullOrEmpty(chunk.Content))
            {
                responseBuilder.Append(chunk.Content);
            }
        }

        return ParseAnalysisResult(responseBuilder.ToString());
    }

    /// <summary>
    /// 生成缺口汇总报告
    /// </summary>
    public async Task<string> GenerateSummaryReportAsync(
        string prdContent,
        List<ContentGap> gaps,
        CancellationToken cancellationToken = default)
    {
        var gapsSummary = string.Join("\n", gaps.Select((g, i) => 
            $"{i + 1}. [{g.GapType}] {g.Question}\n   建议: {g.Suggestion ?? "无"}"));

        var prompt = $@"请基于以下PRD文档和已识别的内容缺口，生成一份结构化的缺口汇总报告。

# PRD文档
{prdContent}

# 已识别的内容缺口
{gapsSummary}

# 报告要求
请生成包含以下内容的报告：
1. 缺口概述（总数、按类型分布）
2. 高优先级缺口（影响开发/测试的关键缺失）
3. 建议补充内容（按优先级排序）
4. 风险评估（如果不补充可能带来的问题）

请用Markdown格式输出报告。";

        var messages = new List<LLMMessage>
        {
            new() { Role = "user", Content = prompt }
        };

        var reportBuilder = new System.Text.StringBuilder();
        
        await foreach (var chunk in _llmClient.StreamGenerateAsync(
            "你是一个专业的产品文档分析师。",
            messages,
            cancellationToken))
        {
            if (chunk.Type == "delta" && !string.IsNullOrEmpty(chunk.Content))
            {
                reportBuilder.Append(chunk.Content);
            }
        }

        return reportBuilder.ToString();
    }

    private string BuildAnalysisPrompt(string prdContent, string question, string aiResponse)
    {
        return $@"请分析以下对话是否揭示了PRD文档中的内容缺口。

# PRD文档摘要
{(prdContent.Length > 2000 ? prdContent[..2000] + "..." : prdContent)}

# 用户问题
{question}

# AI回答
{aiResponse}

# 分析任务
判断AI的回答是否表明PRD文档中存在内容缺口。如果存在缺口，请识别：
1. 缺口类型（UNCLEAR=定义不明确, MISSING=内容缺失, CONFLICT=信息冲突, OTHER=其他）
2. 缺口严重程度（HIGH=高, MEDIUM=中, LOW=低）
3. 建议补充的内容

请严格按以下JSON格式返回：
{{
  ""hasGap"": true或false,
  ""gapType"": ""UNCLEAR"" 或 ""MISSING"" 或 ""CONFLICT"" 或 ""OTHER"",
  ""severity"": ""HIGH"" 或 ""MEDIUM"" 或 ""LOW"",
  ""suggestion"": ""具体的补充建议""
}}

只返回JSON，不要其他内容。";
    }

    private GapAnalysisResult? ParseAnalysisResult(string response)
    {
        try
        {
            // 尝试提取JSON
            var jsonStart = response.IndexOf('{');
            var jsonEnd = response.LastIndexOf('}');
            
            if (jsonStart >= 0 && jsonEnd > jsonStart)
            {
                var json = response[jsonStart..(jsonEnd + 1)];
                return JsonSerializer.Deserialize<GapAnalysisResult>(json, new JsonSerializerOptions
                {
                    PropertyNameCaseInsensitive = true
                });
            }
        }
        catch
        {
            // 解析失败，返回null
        }

        return null;
    }
}

/// <summary>
/// 缺口分析结果
/// </summary>
public class GapAnalysisResult
{
    public bool HasGap { get; set; }
    public string? GapType { get; set; }
    public string? Severity { get; set; }
    public string? Suggestion { get; set; }
}


