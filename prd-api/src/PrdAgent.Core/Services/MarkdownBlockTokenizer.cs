using System.Text;
using System.Text.RegularExpressions;

namespace PrdAgent.Core.Services;

/// <summary>
/// 将流式文本按“块”切分，便于客户端稳定渲染（Block Protocol）。
///
/// 设计目标：
/// - 以“行”为最小解析粒度：收到换行后再判定块类型，避免 token 级别抖动与误判
/// - 支持：paragraph / heading / listItem / codeBlock
/// - codeBlock 使用 ``` fence；语言从开 fence 行解析
/// </summary>
internal sealed class MarkdownBlockTokenizer
{
    internal const string KindParagraph = "paragraph";
    internal const string KindHeading = "heading";
    internal const string KindListItem = "listItem";
    internal const string KindCodeBlock = "codeBlock";

    private static readonly Regex HeadingRegex = new(@"^(#{1,6})\s+.+$", RegexOptions.Compiled);
    private static readonly Regex BulletRegex = new(@"^([-*+])\s+.+$", RegexOptions.Compiled);
    private static readonly Regex OrderedRegex = new(@"^\d+\.\s+.+$", RegexOptions.Compiled);

    private readonly StringBuilder _lineBuf = new();
    private bool _inCodeBlock;
    private string? _openParagraphBlockId;
    private string? _openCodeBlockId;
    private string? _openCodeLanguage;

    internal IEnumerable<BlockToken> Push(string delta)
    {
        if (string.IsNullOrEmpty(delta))
            yield break;

        _lineBuf.Append(delta);

        while (true)
        {
            var nl = IndexOfNewline(_lineBuf);
            if (nl < 0) yield break;

            // 取出一行（不含 '\n'）
            var line = _lineBuf.ToString(0, nl);
            // 移除这一行 + '\n'
            _lineBuf.Remove(0, nl + 1);

            // 兼容 CRLF
            line = line.TrimEnd('\r');

            foreach (var t in ProcessLine(line))
                yield return t;
        }
    }

    internal IEnumerable<BlockToken> Flush()
    {
        // 处理最后残留的半行
        if (_lineBuf.Length > 0)
        {
            var line = _lineBuf.ToString().TrimEnd('\r');
            _lineBuf.Clear();
            foreach (var t in ProcessLine(line))
                yield return t;
        }

        // 关闭未结束的段落/代码块
        if (_inCodeBlock && _openCodeBlockId != null)
        {
            yield return BlockToken.End(_openCodeBlockId, KindCodeBlock);
            _inCodeBlock = false;
            _openCodeBlockId = null;
            _openCodeLanguage = null;
        }

        if (_openParagraphBlockId != null)
        {
            yield return BlockToken.End(_openParagraphBlockId, KindParagraph);
            _openParagraphBlockId = null;
        }
    }

    private IEnumerable<BlockToken> ProcessLine(string line)
    {
        // code fence 优先级最高
        if (_inCodeBlock)
        {
            if (IsFenceLine(line))
            {
                // 关闭 code block（忽略 fence 行本身）
                if (_openCodeBlockId != null)
                    yield return BlockToken.End(_openCodeBlockId, KindCodeBlock, _openCodeLanguage);

                _inCodeBlock = false;
                _openCodeBlockId = null;
                _openCodeLanguage = null;
                yield break;
            }

            if (_openCodeBlockId == null)
            {
                _openCodeBlockId = NewId();
                yield return BlockToken.Start(_openCodeBlockId, KindCodeBlock, language: _openCodeLanguage);
            }

            yield return BlockToken.Delta(_openCodeBlockId, KindCodeBlock, line + "\n", language: _openCodeLanguage);
            yield break;
        }

        // 空行：结束段落（并向下游保留一个空行，避免段落粘连）
        if (string.IsNullOrWhiteSpace(line))
        {
            if (_openParagraphBlockId != null)
            {
                yield return BlockToken.End(_openParagraphBlockId, KindParagraph);
                _openParagraphBlockId = null;
            }
            yield break;
        }

        // 若下一行是结构化块，先关闭当前段落
        if (_openParagraphBlockId != null && (IsFenceLine(line) || HeadingRegex.IsMatch(line) || BulletRegex.IsMatch(line) || OrderedRegex.IsMatch(line)))
        {
            yield return BlockToken.End(_openParagraphBlockId, KindParagraph);
            _openParagraphBlockId = null;
        }

        // code fence 开始
        if (IsFenceLine(line))
        {
            _inCodeBlock = true;
            _openCodeLanguage = ParseFenceLanguage(line);
            _openCodeBlockId = NewId();
            yield return BlockToken.Start(_openCodeBlockId, KindCodeBlock, language: _openCodeLanguage);
            yield break;
        }

        // heading（单行块）
        if (HeadingRegex.IsMatch(line))
        {
            var id = NewId();
            yield return BlockToken.Start(id, KindHeading);
            yield return BlockToken.Delta(id, KindHeading, line + "\n");
            yield return BlockToken.End(id, KindHeading);
            yield break;
        }

        // list item（单行块）
        if (BulletRegex.IsMatch(line) || OrderedRegex.IsMatch(line))
        {
            var id = NewId();
            yield return BlockToken.Start(id, KindListItem);
            yield return BlockToken.Delta(id, KindListItem, line + "\n");
            yield return BlockToken.End(id, KindListItem);
            yield break;
        }

        // paragraph（多行块）
        if (_openParagraphBlockId == null)
        {
            _openParagraphBlockId = NewId();
            yield return BlockToken.Start(_openParagraphBlockId, KindParagraph);
        }

        yield return BlockToken.Delta(_openParagraphBlockId, KindParagraph, line + "\n");
    }

    private static bool IsFenceLine(string line)
        => line.StartsWith("```", StringComparison.Ordinal);

    private static string? ParseFenceLanguage(string fenceLine)
    {
        // ```lang
        if (fenceLine.Length <= 3) return null;
        var lang = fenceLine[3..].Trim();
        return string.IsNullOrWhiteSpace(lang) ? null : lang;
    }

    private static int IndexOfNewline(StringBuilder sb)
    {
        for (var i = 0; i < sb.Length; i++)
        {
            if (sb[i] == '\n') return i;
        }
        return -1;
    }

    private static string NewId() => Guid.NewGuid().ToString("N");
}

internal readonly record struct BlockToken(string Type, string BlockId, string BlockKind, string? Content = null, string? Language = null)
{
    internal static BlockToken Start(string blockId, string blockKind, string? language = null)
        => new("blockStart", blockId, blockKind, null, language);

    internal static BlockToken Delta(string blockId, string blockKind, string content, string? language = null)
        => new("blockDelta", blockId, blockKind, content, language);

    internal static BlockToken End(string blockId, string blockKind, string? language = null)
        => new("blockEnd", blockId, blockKind, null, language);
}


