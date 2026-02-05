using System.Text.RegularExpressions;
using Microsoft.Extensions.Logging;
using PrdAgent.Core.Models;

namespace PrdAgent.Infrastructure.Services.Channels;

/// <summary>
/// 意图识别服务
/// </summary>
public class IntentDetectorService
{
    private readonly ILogger<IntentDetectorService> _logger;

    // 前缀标签映射表
    private static readonly Dictionary<string[], (string Intent, string Agent)> PrefixMappings = new()
    {
        { new[] { "生图", "画图", "图片", "画画", "生成图片" }, (ChannelTaskIntent.ImageGen, "visual-agent") },
        { new[] { "缺陷", "BUG", "bug", "问题", "故障" }, (ChannelTaskIntent.DefectCreate, "defect-agent") },
        { new[] { "查缺陷", "缺陷列表", "我的缺陷" }, (ChannelTaskIntent.DefectQuery, "defect-agent") },
        { new[] { "PRD", "prd", "需求", "文档" }, (ChannelTaskIntent.PrdQuery, "prd-agent") },
        { new[] { "取消", "停止", "cancel" }, (ChannelTaskIntent.Cancel, null!) },
        { new[] { "帮助", "help", "?" }, (ChannelTaskIntent.Help, null!) },
    };

    // 前缀标签正则（匹配 [xxx] 或 【xxx】 格式）
    private static readonly Regex PrefixTagRegex = new(@"^\s*[\[【]([^\]】]+)[\]】]\s*", RegexOptions.Compiled);

    public IntentDetectorService(ILogger<IntentDetectorService> logger)
    {
        _logger = logger;
    }

    /// <summary>
    /// 意图识别结果
    /// </summary>
    public class DetectResult
    {
        /// <summary>识别的意图</summary>
        public string Intent { get; set; } = ChannelTaskIntent.Unknown;

        /// <summary>目标 Agent</summary>
        public string? TargetAgent { get; set; }

        /// <summary>原始前缀标签</summary>
        public string? PrefixTag { get; set; }

        /// <summary>去除前缀后的内容</summary>
        public string CleanContent { get; set; } = string.Empty;

        /// <summary>提取的参数</summary>
        public Dictionary<string, object> Parameters { get; set; } = new();

        /// <summary>置信度（0-1）</summary>
        public double Confidence { get; set; } = 1.0;
    }

    /// <summary>
    /// 从内容中检测意图
    /// </summary>
    /// <param name="subject">邮件主题（可选）</param>
    /// <param name="content">正文内容</param>
    /// <returns>识别结果</returns>
    public DetectResult Detect(string? subject, string content)
    {
        var result = new DetectResult();

        // 优先从主题中提取前缀标签
        var textToAnalyze = !string.IsNullOrWhiteSpace(subject) ? subject : content;
        var prefixMatch = PrefixTagRegex.Match(textToAnalyze);

        if (prefixMatch.Success)
        {
            var tag = prefixMatch.Groups[1].Value.Trim();
            result.PrefixTag = tag;

            // 根据标签匹配意图
            foreach (var (keywords, mapping) in PrefixMappings)
            {
                if (keywords.Any(k => tag.Contains(k, StringComparison.OrdinalIgnoreCase)))
                {
                    result.Intent = mapping.Intent;
                    result.TargetAgent = mapping.Agent;
                    result.Confidence = 1.0;
                    break;
                }
            }

            // 清理内容（去除前缀标签）
            if (!string.IsNullOrWhiteSpace(subject))
            {
                result.CleanContent = PrefixTagRegex.Replace(subject, "").Trim();
                if (string.IsNullOrWhiteSpace(result.CleanContent))
                {
                    result.CleanContent = content.Trim();
                }
                else if (!string.IsNullOrWhiteSpace(content))
                {
                    // 如果主题有内容，正文也有内容，合并
                    result.CleanContent = result.CleanContent + "\n\n" + content.Trim();
                }
            }
            else
            {
                result.CleanContent = PrefixTagRegex.Replace(content, "").Trim();
            }
        }
        else
        {
            // 没有前缀标签，尝试从内容关键词推断
            result.CleanContent = (!string.IsNullOrWhiteSpace(subject) ? subject + "\n\n" : "") + content.Trim();
            DetectFromKeywords(result);
        }

        // 提取特定参数
        ExtractParameters(result);

        _logger.LogDebug("Intent detected: {Intent} (confidence: {Confidence}) for content: {Preview}",
            result.Intent, result.Confidence, result.CleanContent.Length > 50 ? result.CleanContent[..50] + "..." : result.CleanContent);

        return result;
    }

    /// <summary>
    /// 从内容关键词推断意图
    /// </summary>
    private void DetectFromKeywords(DetectResult result)
    {
        var lowerContent = result.CleanContent.ToLowerInvariant();

        // 图片生成关键词
        if (ContainsAny(lowerContent, "生成一张", "画一张", "帮我画", "请画", "生成图片", "图片生成"))
        {
            result.Intent = ChannelTaskIntent.ImageGen;
            result.TargetAgent = "visual-agent";
            result.Confidence = 0.8;
            return;
        }

        // 缺陷相关关键词
        if (ContainsAny(lowerContent, "提交缺陷", "报告bug", "发现问题", "出现故障", "报个bug"))
        {
            result.Intent = ChannelTaskIntent.DefectCreate;
            result.TargetAgent = "defect-agent";
            result.Confidence = 0.8;
            return;
        }

        // PRD 查询关键词
        if (ContainsAny(lowerContent, "需求是什么", "prd", "文档说", "产品需求"))
        {
            result.Intent = ChannelTaskIntent.PrdQuery;
            result.TargetAgent = "prd-agent";
            result.Confidence = 0.7;
            return;
        }

        // 未能识别
        result.Intent = ChannelTaskIntent.Unknown;
        result.Confidence = 0.0;
    }

    /// <summary>
    /// 提取参数
    /// </summary>
    private void ExtractParameters(DetectResult result)
    {
        var content = result.CleanContent;

        switch (result.Intent)
        {
            case ChannelTaskIntent.ImageGen:
                // 提取图片生成参数
                ExtractImageGenParams(result, content);
                break;

            case ChannelTaskIntent.Cancel:
                // 提取任务ID
                var taskIdMatch = Regex.Match(content, @"TASK-\d{8}-[A-Z0-9]+", RegexOptions.IgnoreCase);
                if (taskIdMatch.Success)
                {
                    result.Parameters["taskId"] = taskIdMatch.Value.ToUpper();
                }
                break;
        }
    }

    /// <summary>
    /// 提取图片生成参数
    /// </summary>
    private void ExtractImageGenParams(DetectResult result, string content)
    {
        // 提取 prompt（主要内容）
        result.Parameters["prompt"] = result.CleanContent;

        // 提取风格
        var styleMatch = Regex.Match(content, @"风格[：:]\s*(\S+)", RegexOptions.IgnoreCase);
        if (styleMatch.Success)
        {
            result.Parameters["style"] = styleMatch.Groups[1].Value;
        }

        // 提取尺寸/比例
        var sizeMatch = Regex.Match(content, @"(?:尺寸|比例|大小)[：:]\s*([\d:x×]+)", RegexOptions.IgnoreCase);
        if (sizeMatch.Success)
        {
            result.Parameters["aspectRatio"] = sizeMatch.Groups[1].Value;
        }

        // 提取数量
        var countMatch = Regex.Match(content, @"(?:数量|张数)[：:]\s*(\d+)", RegexOptions.IgnoreCase);
        if (countMatch.Success)
        {
            result.Parameters["count"] = int.Parse(countMatch.Groups[1].Value);
        }
    }

    private static bool ContainsAny(string text, params string[] keywords)
    {
        return keywords.Any(k => text.Contains(k, StringComparison.OrdinalIgnoreCase));
    }
}
