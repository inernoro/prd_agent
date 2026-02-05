using System.Text;
using System.Text.RegularExpressions;
using Microsoft.Extensions.Logging;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models.MultiImage;

namespace PrdAgent.Infrastructure.Services;

/// <summary>
/// 多图处理领域服务实现
///
/// 核心职责：
/// 1. 解析 prompt 中的 @imgN 引用
/// 2. 分析用户意图，输出生图模型可用的 prompt
/// 3. 保留用户原始意图，不过度干预
/// </summary>
public class MultiImageDomainService : IMultiImageDomainService
{
    private readonly ILogger<MultiImageDomainService> _logger;

    // 匹配 @imgN 格式（N 为 1-6 位数字，支持 @img1 到 @img999999）
    private static readonly Regex ImageRefPattern = new(@"@img(\d{1,6})", RegexOptions.Compiled | RegexOptions.IgnoreCase);

    public MultiImageDomainService(ILogger<MultiImageDomainService> logger)
    {
        _logger = logger;
    }

    /// <inheritdoc />
    public MultiImageParseResult ParsePromptRefs(string prompt, IReadOnlyList<ImageRefInput>? imageRefs)
    {
        var result = new MultiImageParseResult
        {
            OriginalPrompt = prompt ?? string.Empty,
            IsValid = true
        };

        if (string.IsNullOrWhiteSpace(prompt))
        {
            result.IsValid = false;
            result.Errors.Add("prompt 不能为空");
            return result;
        }

        // 构建 refId -> ImageRefInput 的映射
        var refMap = new Dictionary<int, ImageRefInput>();
        if (imageRefs != null)
        {
            foreach (var r in imageRefs)
            {
                if (r.RefId > 0 && !refMap.ContainsKey(r.RefId))
                {
                    refMap[r.RefId] = r;
                }
            }
        }

        // 解析 prompt 中的 @imgN 引用
        var matches = ImageRefPattern.Matches(prompt);
        var seenRefIds = new HashSet<int>();
        var order = 0;

        foreach (Match match in matches)
        {
            if (!int.TryParse(match.Groups[1].Value, out var refId) || refId <= 0)
            {
                continue;
            }

            result.MentionedRefIds.Add(refId);

            // 去重：同一个 refId 只添加一次到 ResolvedRefs
            if (seenRefIds.Contains(refId))
            {
                continue;
            }
            seenRefIds.Add(refId);

            if (refMap.TryGetValue(refId, out var input))
            {
                result.ResolvedRefs.Add(new ResolvedImageRef
                {
                    RefId = refId,
                    AssetSha256 = input.AssetSha256,
                    Url = input.Url,
                    Label = input.Label,
                    Role = input.Role,
                    OccurrenceOrder = order++
                });
            }
            else
            {
                // 引用的图片不存在
                result.Warnings.Add($"@img{refId} 引用的图片不存在");
            }
        }

        // 如果有警告但无错误，仍然有效（非阻塞性警告）
        if (result.Errors.Count > 0)
        {
            result.IsValid = false;
        }

        _logger.LogDebug(
            "[MultiImage] 解析完成: prompt=\"{Prompt}\", mentionedRefs={MentionedCount}, resolvedRefs={ResolvedCount}, warnings={WarningCount}",
            prompt.Length > 50 ? prompt[..50] + "..." : prompt,
            result.MentionedRefIds.Count,
            result.ResolvedRefs.Count,
            result.Warnings.Count);

        return result;
    }

    /// <inheritdoc />
    public ImageIntentResult? TryMatchByRules(string prompt, IReadOnlyList<ResolvedImageRef> refs)
    {
        if (refs.Count == 0)
        {
            // 纯文本，直接返回原始 prompt
            return new ImageIntentResult
            {
                Success = true,
                EnhancedPrompt = prompt,
                OriginalPrompt = prompt,
                ImageRefCount = 0,
                Confidence = 1.0
            };
        }

        if (refs.Count == 1)
        {
            // 单图场景：将 @imgN 替换为简洁的描述
            var r = refs[0];
            var labelDesc = string.IsNullOrWhiteSpace(r.Label) ? "这张图" : $"这张图（{r.Label}）";
            var enhanced = ImageRefPattern.Replace(prompt, labelDesc);

            return new ImageIntentResult
            {
                Success = true,
                EnhancedPrompt = enhanced,
                OriginalPrompt = prompt,
                ImageRefCount = 1,
                Confidence = 0.95
            };
        }

        // 多图场景：使用 Transformer 将 @imgN 替换为顺序号
        var refIdToOrder = refs.ToDictionary(r => r.RefId, r => r.OccurrenceOrder + 1);
        var cleanPrompt = MultiImagePromptTransformer.Transform(prompt, refIdToOrder);

        return new ImageIntentResult
        {
            Success = true,
            EnhancedPrompt = cleanPrompt,
            OriginalPrompt = prompt,
            ImageRefCount = refs.Count,
            Confidence = 1.0
        };
    }

    /// <inheritdoc />
    public async Task<ImageIntentResult> AnalyzeIntentAsync(
        string prompt,
        IReadOnlyList<ResolvedImageRef> refs,
        CancellationToken ct = default)
    {
        // 先尝试规则匹配（快速路径）
        var ruleResult = TryMatchByRules(prompt, refs);
        if (ruleResult != null && ruleResult.Confidence >= 0.8)
        {
            _logger.LogDebug("[MultiImage] 使用规则匹配: confidence={Confidence}", ruleResult.Confidence);
            return ruleResult;
        }

        // TODO: 对于复杂多图场景，可以调用 LLM Agent 进行意图分析
        // 当前版本使用规则匹配结果

        return ruleResult ?? new ImageIntentResult
        {
            Success = false,
            ErrorMessage = "无法分析意图",
            OriginalPrompt = prompt,
            ImageRefCount = refs.Count,
            Confidence = 0
        };
    }

    /// <inheritdoc />
    public async Task<string> BuildFinalPromptAsync(
        string prompt,
        IReadOnlyList<ResolvedImageRef> refs,
        CancellationToken ct = default)
    {
        if (refs.Count == 0)
        {
            // 纯文本场景
            return prompt;
        }

        if (refs.Count == 1)
        {
            // 单图场景：可以直接使用原始 prompt
            // 生图模型会结合图片理解用户意图
            return prompt;
        }

        // 多图场景：调用意图分析
        var intent = await AnalyzeIntentAsync(prompt, refs, ct);
        if (intent.Success)
        {
            return intent.EnhancedPrompt;
        }

        // 降级：返回原始 prompt
        _logger.LogWarning("[MultiImage] 意图分析失败，使用原始 prompt: {Error}", intent.ErrorMessage);
        return prompt;
    }
}
