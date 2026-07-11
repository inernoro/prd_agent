using System.Text;

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
        sb.AppendLine();

        sb.Append(FormatSegmentsBody(segments));
        return sb.ToString();
    }

    /// <summary>
    /// 录音转录笔记：AI 摘要在上、转录全文在下（移动端 Notion 式录音流程的最终产物）。
    /// </summary>
    public static string FormatTranscriptNote(string sourceTitle, string summary, IReadOnlyList<SubtitleSegment> segments)
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

        sb.AppendLine("## 转录全文");
        sb.AppendLine();
        sb.Append(FormatSegmentsBody(segments));
        return sb.ToString();
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
              .Append("]** ")
              .Append(seg.Text)
              .AppendLine()
              .AppendLine();
        }

        return sb.ToString();
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
