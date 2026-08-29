using System.Globalization;
using System.Text;
using PrdAgent.Core.Models;

namespace PrdAgent.Api.Services;

/// <summary>
/// 字幕格式化器：把 ASR 分段 / 图片识别结果转成 Markdown 字幕文件。
/// 格式规范（直译、保留时间戳、不加工）：
///
///   # {标题}
///   > 来源：{原文件名} | 生成时间：{now}
///
///   **[00:00:00 - 00:00:05]** 第一句字幕内容…
///   **[00:00:05 - 00:00:12]** 第二句字幕内容…
/// </summary>
public static class SubtitleFormatter
{
    public static string FormatAsrSegments(string sourceTitle, IReadOnlyList<SubtitleSegment> segments)
    {
        var sb = new StringBuilder();
        var baseName = System.IO.Path.GetFileNameWithoutExtension(sourceTitle);
        if (string.IsNullOrWhiteSpace(baseName)) baseName = sourceTitle;

        sb.Append("# ").Append(baseName).Append(" · 字幕").AppendLine();
        sb.Append("> 来源：").Append(sourceTitle)
          .Append(" · 生成时间：").Append(DateTime.Now.ToString("yyyy-MM-dd HH:mm"))
          .AppendLine();
        var subtitleSpeakerNote = FormatSpeakerSourceNote(segments);
        if (subtitleSpeakerNote != null) sb.AppendLine(subtitleSpeakerNote);
        sb.AppendLine();

        sb.Append(FormatSegmentsBody(segments));
        return sb.ToString();
    }

    /// <summary>
    /// 录音转录笔记：AI 摘要在上、转录全文在下（移动端 Notion 式录音流程的最终产物）。
    /// </summary>
    /// <param name="summaryUnavailableNote">
    /// 用户点了整理、但整理没生成出来时要说的那句话。此前这种情况是整个不渲染「摘要」小节：
    /// 笔记照样落库、摘要空着、页面上没有任何提示，用户不知道自己点的整理失败过。
    /// 静默降级比失败更伤——失败至少还告诉你发生了什么。
    /// </param>
    public static string FormatTranscriptNote(
        string sourceTitle,
        string summary,
        IReadOnlyList<SubtitleSegment> segments,
        string? summaryUnavailableNote = null)
    {
        var sb = new StringBuilder();
        var baseName = System.IO.Path.GetFileNameWithoutExtension(sourceTitle);
        if (string.IsNullOrWhiteSpace(baseName)) baseName = sourceTitle;

        sb.Append("# ").Append(baseName).Append(" · 转录笔记").AppendLine();
        sb.Append("> 来源：").Append(sourceTitle)
          .Append(" · 生成时间：").Append(DateTime.Now.ToString("yyyy-MM-dd HH:mm"))
          .AppendLine();
        sb.AppendLine();

        if (!string.IsNullOrWhiteSpace(summary))
        {
            sb.AppendLine("## 摘要");
            sb.AppendLine();
            sb.AppendLine(summary.Trim());
            sb.AppendLine();
        }
        else if (!string.IsNullOrWhiteSpace(summaryUnavailableNote))
        {
            sb.AppendLine("## 摘要");
            sb.AppendLine();
            sb.AppendLine(summaryUnavailableNote.Trim());
            sb.AppendLine();
        }

        sb.AppendLine("## 转录全文");
        sb.AppendLine();
        var speakerSourceNote = FormatSpeakerSourceNote(segments);
        if (speakerSourceNote != null)
        {
            sb.AppendLine(speakerSourceNote);
            sb.AppendLine();
        }
        sb.Append(FormatSegmentsBody(segments));
        return sb.ToString();
    }

    /// <summary>
    /// 说话人来源说明行。三条产出路径可信度差一个量级，界面上却长得一模一样，
    /// 用户没法判断该不该信——所以来源必须随笔记一起落盘，而不是只活在服务端日志里。
    ///
    /// 只在**真的分出了多个说话人**、且所有带说话人的分段来源一致时才写：
    /// 单人录音无所谓来源；来源不一致说明这批分段被混合改写过，此时任何单一结论都是编的，
    /// 宁可不写（形状 6：判据要取真正生效的那个值，取不到就别下结论）。
    ///
    /// 格式 `> 说话人来源：{key} · {说明}`：key 给程序判定，说明给人读，两者同源不分裂。
    /// </summary>
    internal static string? FormatSpeakerSourceNote(IReadOnlyList<SubtitleSegment> segments)
    {
        var labelled = segments.Where(s => !string.IsNullOrWhiteSpace(s.SpeakerId)).ToList();
        if (labelled.Select(s => s.SpeakerId).Distinct(StringComparer.Ordinal).Count() < 2)
            return null;

        var sources = labelled
            .Select(s => s.SpeakerSource)
            .Distinct(StringComparer.Ordinal)
            .ToList();
        if (sources.Count != 1) return null;

        var description = SpeakerSources.Describe(sources[0]);
        return description == null
            ? null
            : $"{TranscribeNoteText.SpeakerSourcePrefix}{sources[0]} · {description}";
    }

    /// <summary>ASR 分段正文：有时间戳时逐段带 **[mm:ss - mm:ss]**，全 0 时按纯段落输出。</summary>
    private static string FormatSegmentsBody(IReadOnlyList<SubtitleSegment> segments)
    {
        var sb = new StringBuilder();
        if (segments.Count == 0)
        {
            sb.AppendLine("_（无可识别内容）_");
            return sb.ToString();
        }

        // 所有段时间戳都为 0 → 当作一段纯文本输出（无时间戳）
        var allZero = segments.All(s => s.StartSec == 0 && s.EndSec == 0);
        if (allZero)
        {
            foreach (var seg in segments)
            {
                if (string.IsNullOrWhiteSpace(seg.Text)) continue;
                if (!string.IsNullOrWhiteSpace(seg.SpeakerId))
                {
                    sb.Append("[说话人")
                      .Append(NormalizeSpeakerLabel(seg.SpeakerId))
                      .Append("] ");
                }
                sb.AppendLine(seg.Text);
                sb.AppendLine();
            }
            return sb.ToString();
        }

        foreach (var seg in segments)
        {
            if (string.IsNullOrWhiteSpace(seg.Text)) continue;
            sb.Append("**[")
              .Append(FormatTime(seg.StartSec))
              .Append(" - ")
              .Append(FormatTime(seg.EndSec))
              .Append("]** ");
            if (!string.IsNullOrWhiteSpace(seg.SpeakerId))
            {
                sb.Append("[说话人")
                  .Append(NormalizeSpeakerLabel(seg.SpeakerId))
                  .Append("] ");
            }
            sb
              .Append(seg.Text)
              .AppendLine()
              .AppendLine();
        }

        return sb.ToString();
    }

    private static string NormalizeSpeakerLabel(string speakerId)
    {
        var trimmed = speakerId.Trim();
        if (trimmed.StartsWith("说话人", StringComparison.Ordinal))
            return trimmed[3..];
        if (int.TryParse(trimmed, out var numeric))
            return (numeric + 1).ToString(CultureInfo.InvariantCulture);
        return trimmed;
    }

    public static string FormatImageText(string sourceTitle, string rawText)
    {
        var sb = new StringBuilder();
        var baseName = System.IO.Path.GetFileNameWithoutExtension(sourceTitle);
        if (string.IsNullOrWhiteSpace(baseName)) baseName = sourceTitle;

        sb.Append("# ").Append(baseName).Append(" · 字幕").AppendLine();
        sb.Append("> 来源：").Append(sourceTitle)
          .Append(" · 生成时间：").Append(DateTime.Now.ToString("yyyy-MM-dd HH:mm"))
          .AppendLine();
        sb.AppendLine();

        if (string.IsNullOrWhiteSpace(rawText))
        {
            sb.AppendLine("_（图片中未识别到文字/内容）_");
        }
        else
        {
            sb.AppendLine(rawText.Trim());
        }
        return sb.ToString();
    }

    /// <summary>把秒数格式化为 HH:MM:SS.mmm 或 HH:MM:SS（短于 1 小时时用 MM:SS）</summary>
    private static string FormatTime(double seconds)
    {
        if (seconds < 0) seconds = 0;
        var ts = TimeSpan.FromSeconds(seconds);
        if (ts.TotalHours >= 1)
            return ts.ToString(@"hh\:mm\:ss");
        return ts.ToString(@"mm\:ss");
    }
}
