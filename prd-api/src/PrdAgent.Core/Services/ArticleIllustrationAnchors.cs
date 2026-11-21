using System.Text;
using System.Text.RegularExpressions;

namespace PrdAgent.Core.Services;

/// <summary>Numbers explicit placeholders for the model and applies prompts to their original source ranges.</summary>
public sealed class ArticleIllustrationAnchors
{
    private static readonly Regex Placeholder = new(@"(?m)^\uFEFF?[^\S\r\n]*(?:\[IMG\]|\[配图\]|【插图位置】)[^\S\r\n]*(?=\r?$)", RegexOptions.Compiled);
    private static readonly Regex LoneCarriageReturn = new(@"\r(?!\n)", RegexOptions.Compiled);
    private static readonly Regex PromptWhitespace = new(@"[\s\uFEFF]+", RegexOptions.Compiled);

    private readonly string _article;
    private readonly Dictionary<string, (Match Range, int Index)> _positions = new(StringComparer.Ordinal);

    public ArticleIllustrationAnchors(string article)
    {
        _article = LoneCarriageReturn.Replace(article, "\n");
        var prefix = "[IMG:";
        while (article.Contains(prefix, StringComparison.Ordinal)) prefix = "[" + prefix;

        ModelArticle = Placeholder.Replace(_article, match =>
        {
            var id = $"{prefix}{_positions.Count + 1}]";
            _positions.Add(id, (match, _positions.Count));
            return id;
        });
    }

    public string ModelArticle { get; }
    public int Count => _positions.Count;

    public bool TryAddPrompt(Dictionary<string, AnchorInsertion> prompts, AnchorInsertion prompt)
    {
        if (!_positions.TryGetValue(prompt.AnchorText, out var anchor) || ToSingleLine(prompt.MarkerText).Length == 0)
            return false;
        if (!prompts.TryAdd(prompt.AnchorText, prompt)) return false;

        prompt.Index = anchor.Index;
        return true;
    }

    public (string Content, int FallbackCount) Apply(IReadOnlyDictionary<string, AnchorInsertion> prompts)
    {
        var content = new StringBuilder(_article);
        var newline = _article.Contains("\r\n", StringComparison.Ordinal) ? "\r\n" : "\n";
        string[]? contexts = null;
        var fallbackCount = 0;
        foreach (var (id, anchor) in _positions.OrderByDescending(entry => entry.Value.Index))
        {
            var prompt = prompts.TryGetValue(id, out var response) ? ToSingleLine(response.MarkerText) : string.Empty;
            if (prompt.Length == 0)
            {
                contexts ??= ReadSourceContexts();
                var excerpt = contexts[anchor.Index];
                prompt = string.IsNullOrEmpty(excerpt)
                    ? "根据这处锚点绘制与本文风格一致的配图，图中所有文字使用中文"
                    : $"根据这处锚点附近的原文绘制配图，忠实呈现场景和细节。参考正文「{excerpt}」。图中所有文字使用中文";
                fallbackCount++;
            }

            var position = anchor.Range;
            var start = position.Index;
            var end = start + position.Length;
            // A manually typed anchor can share a Markdown block with surrounding text.
            // Isolate the generated marker without rewriting any original paragraph.
            var previousLine = start > 1 ? _article.LastIndexOf('\n', start - 2) + 1 : 0;
            var before = !IsBlankLine(_article.AsSpan(previousLine, start - previousLine));
            var nextLine = _article.IndexOf('\n', end);
            var after = nextLine >= 0 && !IsBlankLine(_article.AsSpan(nextLine + 1));
            content.Remove(start, position.Length).Insert(start,
                (before ? newline : "") + "[插图]: " + prompt + (after ? newline : ""));
        }
        return (content.ToString(), fallbackCount);
    }

    private string[] ReadSourceContexts()
    {
        var contexts = new string[Count];
        var anchorIndex = 0;
        var previous = string.Empty;
        using var reader = new StringReader(_article);
        while (reader.ReadLine() is { } line)
        {
            if (Placeholder.IsMatch(line))
            {
                contexts[anchorIndex++] = previous;
                continue;
            }
            var excerpt = ToSingleLine(line);
            if (excerpt.Length == 0) continue;

            var length = Math.Min(excerpt.Length, 200);
            if (char.IsHighSurrogate(excerpt[length - 1])) length--;
            var context = excerpt[..length];
            if (previous.Length == 0) Array.Fill(contexts, context, 0, anchorIndex);
            previous = context;
        }
        return contexts;
    }

    private static string ToSingleLine(string text) => PromptWhitespace.Replace(text, " ").Trim();

    private static bool IsBlankLine(ReadOnlySpan<char> text)
    {
        var end = text.IndexOf('\n');
        return (end < 0 ? text : text[..end]).Trim().IsEmpty;
    }
}
