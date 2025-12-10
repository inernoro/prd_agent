using PrdAgent.Core.Models;

namespace PrdAgent.Core.Interfaces;

/// <summary>
/// Markdown解析器接口
/// </summary>
public interface IMarkdownParser
{
    /// <summary>解析Markdown内容</summary>
    ParsedPrd Parse(string content);

    /// <summary>估算Token数量</summary>
    int EstimateTokens(string content);
}


