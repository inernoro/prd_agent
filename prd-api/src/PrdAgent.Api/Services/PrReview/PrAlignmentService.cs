using System.Runtime.CompilerServices;
using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.LlmGateway;

namespace PrdAgent.Api.Services.PrReview;

/// <summary>
/// PR Review 档 3 —— 对齐度检查（PR Alignment Check）。
///
/// 用户价值：回答两个审查者最常问的问题：
///   1. "作者描述里说要做的，代码里都做了吗？"
///   2. "代码里做了的事，描述里都提了吗？有没有偷偷夹带的改动？"
///
/// 输入（均来自 PrReviewItem.Snapshot，来自 GitHub API）：
///   - PR 标题 + body（作者描述）
///   - 关联 issue 的 title + body（若 body 里有 Closes #N）
///   - 变更文件列表（filename / status / +/- / patch 片段）
///
/// 输出：一份 Markdown 报告 + 抽取出的对齐度分数（0-100）。
/// Markdown 约定的结构（Prompt 强约束，前端按这个结构渲染）：
///   ## 对齐度 {N}%
///   ## 总结
///   ...一句话...
///   ## ✅ 已落实
///   - ...
///   ## ⚠️ 描述里没提但动了
///   - ...
///   ## ❌ 描述里提了但没见到
///   - ...
///
/// 调用链：走 ILlmGateway 流式（遵守 llm-gateway + llm-visibility 规则）。
/// AppCallerCode = "pr-review.alignment::chat"
/// </summary>
public sealed class PrAlignmentService
{
    private const string AppCallerCode = "pr-review.alignment::chat";
    private const int MaxContextChars = 60_000; // 粗粒度上限，避免单次调用爆上下文

    private readonly ILlmGateway _gateway;
    private readonly ILogger<PrAlignmentService> _logger;

    public PrAlignmentService(ILlmGateway gateway, ILogger<PrAlignmentService> logger)
    {
        _gateway = gateway;
        _logger = logger;
    }

    /// <summary>
    /// 流式生成对齐度报告。调用方负责持久化最终结果。
    /// 返回 LlmStreamDelta（区分 Thinking 和 Text）：
    /// - Thinking：推理模型的思考过程，累积到折叠面板，不计入最终 markdown
    /// - Text：正式输出，计入 fullMd 作为最终 AlignmentReport.Markdown
    /// modelInfo 是 out 参数，当 Gateway 返回 Start chunk 时立即填充。
    /// 若上游抛 PrReviewException 或 LLM 报错，会以抛异常的方式返回调用方。
    /// </summary>
    public async IAsyncEnumerable<LlmStreamDelta> StreamAlignmentAsync(
        PrReviewItem item,
        PrReviewModelInfoHolder modelInfo,
        [EnumeratorCancellation] CancellationToken ct)
    {
        var snapshot = item.Snapshot
            ?? throw new InvalidOperationException("PrReviewItem has no snapshot yet; refresh from GitHub first.");

        var systemPrompt = BuildSystemPrompt();
        var userPrompt = BuildUserPrompt(item, snapshot);

        var gatewayRequest = new GatewayRequest
        {
            AppCallerCode = AppCallerCode,
            ModelType = "chat",
            Stream = true,
            // 推理模型（qwen-thinking 等）的 reasoning_content 必须透传，
            // 否则 Gateway 会把思考块静默吞掉导致前端"空白等待"几十秒。
            IncludeThinking = true,
            RequestBody = new JsonObject
            {
                ["messages"] = new JsonArray
                {
                    new JsonObject { ["role"] = "system", ["content"] = systemPrompt },
                    new JsonObject { ["role"] = "user", ["content"] = userPrompt },
                },
                ["temperature"] = 0.2,
                ["max_tokens"] = 4096,
            },
        };

        // 服务器权威性：LLM 调用不能被客户端断开中止
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
                _logger.LogWarning("PR alignment stream error: {Error}", msg);
                throw new InvalidOperationException(msg);
            }
        }
    }

    /// <summary>
    /// 从 LLM markdown 输出里抽取对齐度分数 + 一句话总结。
    /// 严格按 prompt 约定的格式解析；不严格成立时返回 (0, null)，不抛异常。
    /// </summary>
    public static (int Score, string? Summary) ParseAlignmentOutput(string markdown)
    {
        if (string.IsNullOrWhiteSpace(markdown)) return (0, null);

        // 分数：找 "对齐度 {N}%" 模式，N 取 0-100
        var scoreMatch = Regex.Match(markdown, @"对齐度\s*(\d{1,3})\s*%");
        var score = 0;
        if (scoreMatch.Success && int.TryParse(scoreMatch.Groups[1].Value, out var s))
        {
            score = Math.Clamp(s, 0, 100);
        }

        // 总结：找 "## 总结" 之后的整行内容。
        // 注意：不能用 [^\n#] 否则 LLM 写 "Fix #123" 会被提前截断。
        var summaryMatch = Regex.Match(
            markdown,
            @"##\s*总结\s*\r?\n+([^\n]+)",
            RegexOptions.Multiline);
        string? summary = null;
        if (summaryMatch.Success)
        {
            var candidate = summaryMatch.Groups[1].Value.Trim();
            // 跳过空行并防御性地拒绝下一个 ## 标题
            if (!candidate.StartsWith("##"))
            {
                summary = candidate.Length > 500 ? candidate[..500] : candidate;
            }
        }

        return (score, summary);
    }

    // ========================================================================
    // Prompt 构造
    // ========================================================================

    private static string BuildSystemPrompt()
    {
        return """
你是一位资深代码审查专家，擅长对比 Pull Request 作者描述与实际代码变更，回答两个核心问题：
1. 作者说要做的，代码里都做了吗？
2. 代码里做了的事，描述里都提了吗？有没有偷偷夹带的改动？

你的分析必须客观、具体、可验证——每一条结论都应能在给定的材料里找到直接依据。
不要编造不存在的文件名或代码片段。对于二进制文件、大文件、patch 被截断的情况，明确说明"patch 已截断，无法详细分析"。

**输出格式严格约定**（前端会按此结构渲染，不要省略任何章节）：

## 对齐度 {0-100}%

## 总结
一句话概括对齐情况（40 字以内）。

## ✅ 已落实
- {描述里提到，代码里也做了的点。每条包含"描述说什么 → 代码怎么做的（文件路径）"}
- ...

## ⚠️ 描述里没提但动了
- {代码里有变更但 PR 描述没提到的改动。每条包含"哪个文件/模块被改了 → 为什么可能需要审查"}
- ...若没有则写 "无"

## ❌ 描述里提了但没见到
- {PR 描述里承诺要做但代码里找不到对应改动的点。每条包含"描述说什么 → 为什么没找到"}
- ...若没有则写 "无"

## 关联 Issue 对齐
{如果材料里有关联 issue，评估代码是否真的解决了 issue 描述的问题；没有关联 issue 则写 "未关联 issue"}

## 架构师关注点
- {最值得人工复核的 2-3 个点，按重要性排序}

打分尺度：
- 90-100：描述与代码几乎完全对齐，无夹带改动
- 75-89：大体对齐，少量文案/注释级的未提及改动
- 60-74：有明显夹带或遗漏，建议审查
- < 60：描述与代码严重不符，可能是 WIP 或误操作
""";
    }

    private static string BuildUserPrompt(PrReviewItem item, PrReviewSnapshot snapshot)
    {
        var sb = new StringBuilder();

        sb.AppendLine($"# 待分析的 PR：{item.Owner}/{item.Repo}#{item.Number}");
        sb.AppendLine();
        sb.AppendLine($"**标题**：{snapshot.Title}");
        sb.AppendLine($"**作者**：{snapshot.AuthorLogin}");
        sb.AppendLine($"**状态**：{snapshot.State}");
        sb.AppendLine($"**规模**：+{snapshot.Additions} / -{snapshot.Deletions}，共 {snapshot.ChangedFiles} 个文件");
        if (snapshot.Labels.Count > 0)
        {
            sb.AppendLine($"**标签**：{string.Join(", ", snapshot.Labels)}");
        }
        sb.AppendLine();

        sb.AppendLine("## 作者的 PR 描述（body）");
        if (string.IsNullOrWhiteSpace(snapshot.Body))
        {
            sb.AppendLine("_（作者未填写 PR 描述）_");
        }
        else
        {
            sb.AppendLine(snapshot.Body);
        }
        sb.AppendLine();

        if (snapshot.LinkedIssueNumber.HasValue)
        {
            sb.AppendLine($"## 关联 Issue #{snapshot.LinkedIssueNumber.Value}：{snapshot.LinkedIssueTitle}");
            sb.AppendLine();
            sb.AppendLine(snapshot.LinkedIssueBody ?? "_（issue 无正文）_");
            sb.AppendLine();
        }

        sb.AppendLine("## 实际代码变更（按文件）");
        if (snapshot.Files.Count == 0)
        {
            sb.AppendLine("_（未拉到任何文件变更——可能是 GitHub API 错误或 token 权限不够）_");
        }
        else
        {
            foreach (var f in snapshot.Files)
            {
                sb.AppendLine();
                sb.AppendLine($"### `{f.Filename}` [{f.Status}] (+{f.Additions} / -{f.Deletions})");
                if (!string.IsNullOrEmpty(f.Patch))
                {
                    sb.AppendLine("```diff");
                    sb.AppendLine(f.Patch);
                    sb.AppendLine("```");
                }
                else
                {
                    sb.AppendLine("_（二进制文件或 patch 未提供）_");
                }

                // 防上下文爆炸的粗粒度保护
                if (sb.Length > MaxContextChars)
                {
                    sb.AppendLine();
                    sb.AppendLine("_[上下文已达上限，剩余文件略]_");
                    break;
                }
            }
        }

        sb.AppendLine();
        sb.AppendLine("---");
        sb.AppendLine("请按 system 中约定的 Markdown 格式输出对齐度分析。");

        return sb.ToString();
    }
}
