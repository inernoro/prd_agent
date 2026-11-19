using System.Text;
using System.Text.RegularExpressions;

namespace PrdAgent.Core.Services;

/// <summary>Numbers explicit placeholders for the model and applies prompts to their original source ranges.</summary>
public sealed class ArticleIllustrationAnchors
{
    private static readonly Regex Placeholder = new(@"(?m)^[^\S\r\n]*(?:\[IMG\]|\[配图\]|【插图位置】)[^\S\r\n]*(?=\r?$)", RegexOptions.Compiled);

    private readonly string _article;
    private readonly Dictionary<string, Match> _positions = new(StringComparer.Ordinal);

    public ArticleIllustrationAnchors(string article)
    {
        _article = article;
        var prefix = "[IMG:";
        while (article.Contains(prefix, StringComparison.Ordinal)) prefix = "[" + prefix;

        ModelArticle = Placeholder.Replace(article, match =>
        {
            var id = $"{prefix}{_positions.Count + 1}]";
            _positions.Add(id, match);
            return id;
        });
    }

    public string ModelArticle { get; }
    public int Count => _positions.Count;

    public bool Contains(string id) => _positions.ContainsKey(id);

    public string? Apply(IReadOnlyDictionary<string, AnchorInsertion> prompts)
    {
        if (_positions.Keys.Any(id => !prompts.ContainsKey(id))) return null;

        var content = new StringBuilder(_article);
        var newline = _article.Contains("\r\n", StringComparison.Ordinal) ? "\r\n" : "\n";
        foreach (var (id, position) in _positions.Reverse())
        {
            var start = position.Index;
            var end = start + position.Length;
            // A manually typed anchor can share a Markdown block with surrounding text.
            // Isolate the generated marker without rewriting any original paragraph.
            var previousLine = start > 1 ? _article.LastIndexOf('\n', start - 2) + 1 : 0;
            var before = !IsBlankLine(_article.AsSpan(previousLine, start - previousLine));
            var nextLine = _article.IndexOf('\n', end);
            var after = nextLine >= 0 && !IsBlankLine(_article.AsSpan(nextLine + 1));
            content.Remove(start, position.Length).Insert(start,
                (before ? newline : "") + prompts[id].MarkerLine + (after ? newline : ""));
        }
        return content.ToString();
    }

    private static bool IsBlankLine(ReadOnlySpan<char> text)
    {
        var end = text.IndexOf('\n');
        return (end < 0 ? text : text[..end]).Trim().IsEmpty;
    }
}
