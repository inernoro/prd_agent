using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace PrdAgent.Core.Models;

/// <summary>一次回答使用的原文片段；编号和脚注内容均由服务端生成。</summary>
public sealed class WebPageAskEvidence
{
    private const int MaxExcerptChars = 800;
    private static readonly Regex Citation = new(@"\[引用:([^\]\r\n]+)\]", RegexOptions.Compiled);
    private static readonly Regex MarkdownFootnote = new(@"\[\^[^\]\r\n]+\]", RegexOptions.Compiled);
    public IReadOnlyList<string> Excerpts { get; }

    public WebPageAskEvidence(string text)
    {
        var excerpts = new List<string>();
        var section = new StringBuilder();
        void Flush()
        {
            var value = section.ToString().Trim();
            if (value.Length > 0) excerpts.Add(value);
            section.Clear();
        }

        // 优先按标题/段落分开，超长段落再有界切分，不让一条脚注附上整页。
        foreach (var line in text.Replace("\r\n", "\n").Replace('\r', '\n').Split('\n'))
        {
            if (string.IsNullOrWhiteSpace(line)) { Flush(); continue; }
            if (Regex.IsMatch(line, @"^#{1,6}\s") || section.Length + line.Length + 1 > MaxExcerptChars)
                Flush();
            var remaining = line;
            while (remaining.Length > MaxExcerptChars)
            {
                var end = MaxExcerptChars;
                if (char.IsHighSurrogate(remaining[end - 1])) end--;
                excerpts.Add(remaining[..end]);
                remaining = remaining[end..];
            }
            if (section.Length > 0) section.AppendLine();
            section.Append(remaining);
        }
        Flush();
        Excerpts = excerpts.AsReadOnly();
    }

    // 包装与页面文字分开编码。原文里的分隔符、引号和编号仍然是 text 的内容，
    // 标识符即使没有定义或看起来像测试值，也保持可直接引用的原文字面值。
    public string ToPromptText() => JsonSerializer.Serialize(
        Excerpts.Select((text, i) => new { source = i + 1, text }),
        new JsonSerializerOptions { Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping });

    public string CompleteAnswer(string answer)
    {
        // 模型不得自行定义 Markdown 脚注；先转成字面文本，再生成受控脚注。
        var body = MarkdownFootnote.Replace(answer, m => "\\" + m.Value);
        var used = new List<int>();
        var invalid = false;
        body = Citation.Replace(body, m =>
        {
            if (!int.TryParse(m.Groups[1].Value, out var source) || source < 1 || source > Excerpts.Count)
            {
                invalid = true;
                return "";
            }
            var index = used.IndexOf(source);
            if (index < 0) { index = used.Count; used.Add(source); }
            return $"[^{index + 1}]";
        });

        var result = new StringBuilder(body.TrimEnd());
        if (used.Count > 0)
        {
            result.AppendLine().AppendLine();
            for (var i = 0; i < used.Count; i++)
            {
                var excerpt = EscapeMarkdown(Excerpts[used[i] - 1]);
                result.AppendLine($"[^{i + 1}]: {excerpt.Replace("\n", "\n    ")}");
            }
        }
        if (invalid)
            result.AppendLine().AppendLine("> 部分引用无法对应已读取的原文，已移除无效编号。");
        if (used.Count == 0)
            result.AppendLine().AppendLine("> 本次回答未提供可核对的原文引用。");
        return result.ToString().TrimEnd();
    }

    /// <summary>旧客户端回传完整答案时，先去除本系统生成的脚注附录，再裁剪历史。</summary>
    public static string ToHistoryText(string answer)
    {
        var body = Regex.Split(answer, @"\r?\n\r?\n\[\^1\]: ", RegexOptions.None)[0];
        body = Regex.Replace(body, @"(?<!\\)\[\^[1-9]\d*\]", "");
        return Regex.Replace(body, @"\[引用:\d+\]", "");
    }

    private static string EscapeMarkdown(string text) => Regex.Replace(
        text.Replace("&", "&amp;"), @"[\\`*_{}\[\]()<>#!|~+\-.]", m => "\\" + m.Value);
}
