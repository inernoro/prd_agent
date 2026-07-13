namespace PrdAgent.Core.Models;

/// <summary>
/// 录音转笔记的纯文本处理函数（无 IO / 无 LLM），供 SubtitleGenerationProcessor 调用、
/// PrdAgent.Tests 单测覆盖：静音/拒答判定、摘要节替换、转录全文反解、风格化摘要提示词组装。
/// </summary>
public static class TranscribeNoteText
{
    /// <summary>笔记 markdown 中转录全文小节的固定标题（SubtitleFormatter.FormatTranscriptNote 产出）。</summary>
    public const string TranscriptMarker = "## 转录全文";

    private const string SummaryMarker = "## 摘要";

    /// <summary>
    /// 静音/拒答判定：极短转录文本且命中「转写模型把指令当聊天回答」「明确表示没听到内容」的模式。
    /// 只在极短文本上启用，避免误伤真实的一句话录音。
    /// 历史事故（2026-07-12）：静音录音产出"好的，请播放音频，我会逐字转写"并被存成笔记。
    /// </summary>
    public static bool LooksLikeNoSpeech(string transcript)
    {
        var t = transcript.Trim();
        if (t.Contains("NO_SPEECH", StringComparison.OrdinalIgnoreCase)) return true;
        if (t.Length > 40) return false;
        string[] patterns =
        {
            "请播放", "请提供", "请上传", "请发送", "我会逐字", "我将逐字", "无法转写", "没有检测到",
            "没有听到", "未能识别", "无法识别", "没有可识别", "音频为空", "没有音频", "谢谢观看",
        };
        return patterns.Any(p => t.Contains(p, StringComparison.Ordinal));
    }

    /// <summary>把笔记 markdown 的「## 摘要」小节替换为新摘要；「## 转录全文」及其后内容原样保留。</summary>
    public static string ReplaceSummarySection(string noteMd, string newSummary)
    {
        var fullIdx = noteMd.IndexOf(TranscriptMarker, StringComparison.Ordinal);
        if (fullIdx < 0)
        {
            // 结构外的笔记（被用户改过）：摘要前置，原文整体保留
            return SummaryMarker + "\n\n" + newSummary.Trim() + "\n\n" + noteMd;
        }
        var head = noteMd[..fullIdx];
        var summaryIdx = head.IndexOf(SummaryMarker, StringComparison.Ordinal);
        var prefix = summaryIdx >= 0 ? head[..summaryIdx] : head;
        var trimmedPrefix = prefix.TrimEnd();
        var glue = trimmedPrefix.Length > 0 ? "\n\n" : "";
        return trimmedPrefix + glue + SummaryMarker + "\n\n" + newSummary.Trim() + "\n\n" + noteMd[fullIdx..];
    }

    /// <summary>从笔记 markdown 反解「## 转录全文」节正文（老 run 没存 TranscriptText 时的兜底）。</summary>
    public static string? ExtractTranscriptFromNote(string noteMd)
    {
        var idx = noteMd.IndexOf(TranscriptMarker, StringComparison.Ordinal);
        if (idx < 0) return null;
        var body = noteMd[(idx + TranscriptMarker.Length)..].Trim();
        return string.IsNullOrWhiteSpace(body) ? null : body;
    }

    /// <summary>
    /// 按 run 的整理方式（TemplateKey/CustomPrompt）组装摘要 system prompt。
    /// 风格片段来自 TranscribeStyleRegistry（SSOT）；custom 用用户自己的整理要求；
    /// 硬约束（不编造 / 不加前言 / 禁 emoji）对所有风格一律生效。
    /// </summary>
    public static string BuildSummarySystemPrompt(DocumentStoreAgentRun run)
    {
        const string guardrails =
            "硬约束：1) 只依据转录内容，不得编造；2) 未提及的内容不要出现；" +
            "3) 直接以整理后的内容开头，不要任何前言或结语；4) 禁止使用 emoji 字符。";

        var style = TranscribeStyleRegistry.Find(run.TemplateKey);
        if (style?.Key == TranscribeStyleRegistry.CustomKey && !string.IsNullOrWhiteSpace(run.CustomPrompt))
        {
            return "你是录音笔记助手。根据用户提供的录音转录全文，按以下整理要求输出 Markdown：" +
                   run.CustomPrompt.Trim() + "\n" + guardrails;
        }
        var addon = style?.PromptAddon
            ?? TranscribeStyleRegistry.Find(TranscribeStyleRegistry.DefaultKey)!.PromptAddon!;
        return "你是录音笔记助手。根据用户提供的录音转录全文，" + addon + guardrails;
    }
}
