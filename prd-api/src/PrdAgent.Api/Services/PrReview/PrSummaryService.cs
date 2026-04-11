using System.Runtime.CompilerServices;
using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.LlmGateway;

namespace PrdAgent.Api.Services.PrReview;

/// <summary>
/// PR Review 档 1 —— 变更摘要（Change Summary）。
///
/// 用户价值：让审查者在 30 秒内了解一个 PR 在做什么。
///   - 一句话：PR 的核心意图
///   - 关键改动：按重要性排序的要点列表（最多 6 条）
///   - 主要影响：影响哪些模块/层次
///   - 审查建议：告诉审查者该把精力放在哪里
///
/// 与档 3 对齐度检查的关系：
///   - 档 1 回答"这个 PR 是什么"（快速浏览）
///   - 档 3 回答"说和做一致吗"（深度对比）
///   - 两者共享同一批数据（body + files + linked issue），但 prompt 与输出形态不同
///
/// 调用链：走 ILlmGateway 流式（遵守 llm-gateway + llm-visibility 规则）。
/// AppCallerCode = "pr-review.summary::chat"
/// </summary>
public sealed class PrSummaryService
{
    private const string AppCallerCode = "pr-review.summary::chat";
    private const int MaxContextChars = 60_000;

    private readonly ILlmGateway _gateway;
    private readonly ILogger<PrSummaryService> _logger;

    public PrSummaryService(ILlmGateway gateway, ILogger<PrSummaryService> logger)
    {
        _gateway = gateway;
        _logger = logger;
    }

    /// <summary>
    /// 流式生成变更摘要。调用方负责持久化最终结果。
    /// </summary>
    public async IAsyncEnumerable<string> StreamSummaryAsync(
        PrReviewItem item,
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
            RequestBody = new JsonObject
            {
                ["messages"] = new JsonArray
                {
                    new JsonObject { ["role"] = "system", ["content"] = systemPrompt },
                    new JsonObject { ["role"] = "user", ["content"] = userPrompt },
                },
                // 摘要任务要求相对稳定、不发散，温度略低
                ["temperature"] = 0.15,
                ["max_tokens"] = 2048,
            },
        };

        // 服务器权威性：LLM 调用不能被客户端断开中止
        await foreach (var chunk in _gateway.StreamAsync(gatewayRequest, CancellationToken.None))
        {
            if (chunk.Type == GatewayChunkType.Text && !string.IsNullOrEmpty(chunk.Content))
            {
                yield return chunk.Content!;
            }
            else if (chunk.Type == GatewayChunkType.Error)
            {
                var msg = chunk.Error ?? chunk.Content ?? "LLM 网关未知错误";
                _logger.LogWarning("PR summary stream error: {Error}", msg);
                throw new InvalidOperationException(msg);
            }
        }
    }

    /// <summary>
    /// 从 LLM markdown 输出里抽取"一句话"用于列表页展示。
    /// 严格按 prompt 约定的章节头解析；解析失败返回 null。
    /// </summary>
    public static string? ParseHeadline(string markdown)
    {
        if (string.IsNullOrWhiteSpace(markdown)) return null;
        var match = Regex.Match(
            markdown,
            @"##\s*一句话\s*\n+([^\n#]+)",
            RegexOptions.Multiline);
        if (!match.Success) return null;
        var headline = match.Groups[1].Value.Trim();
        return headline.Length > 200 ? headline[..200] : headline;
    }

    // ========================================================================
    // Prompt 构造
    // ========================================================================

    private static string BuildSystemPrompt()
    {
        return """
你是一位资深代码审查者，任务是为审查者提供 PR 的快速浏览摘要——让他们在 30 秒内看懂 PR 在做什么。

输出要简洁、客观、可验证。每一条结论都应能在给定的材料里找到直接依据。
不要编造不存在的文件名或代码片段。对于二进制文件、patch 被截断等情况，明确说明。
摘要只描述"做了什么"，不评判质量（评判留给其他档次）。

**输出格式严格约定**（前端会按此结构渲染，不要省略任何章节）：

## 一句话
{40 字以内，用一句话概括 PR 的核心意图}

## 关键改动
- {要点 1：做了什么（相关文件）}
- {要点 2}
- ...最多 6 条，按重要性排序

## 主要影响
{1-2 句话，说明影响的模块/层次/功能，例如"前端 3 个组件 + 后端 1 个 service"}

## 审查建议
{1-2 句话给审查者的建议，例如 "重点看 XX 文件的锁处理" 或 "本 PR 是机械重构，重点验证测试覆盖" 或 "变更范围小，快速过一遍即可"}
""";
    }

    private static string BuildUserPrompt(PrReviewItem item, PrReviewSnapshot snapshot)
    {
        var sb = new StringBuilder();

        sb.AppendLine($"# 待总结的 PR：{item.Owner}/{item.Repo}#{item.Number}");
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
        sb.AppendLine("请按 system 中约定的 Markdown 格式输出变更摘要。");

        return sb.ToString();
    }
}
