using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;

namespace PrdAgent.Core.Services;

/// <summary>
/// 文档服务实现
/// </summary>
public class DocumentService : IDocumentService
{
    private readonly ICacheManager _cache;
    private readonly IMarkdownParser _parser;

    public DocumentService(ICacheManager cache, IMarkdownParser parser)
    {
        _cache = cache;
        _parser = parser;
    }

    public Task<ParsedPrd> ParseAsync(string content)
    {
        if (string.IsNullOrWhiteSpace(content))
        {
            throw new ArgumentException("文档内容不能为空");
        }

        var parsed = _parser.Parse(content);
        return Task.FromResult(parsed);
    }

    public async Task<ParsedPrd?> GetByIdAsync(string documentId)
    {
        var key = CacheKeys.ForDocument(documentId);
        return await _cache.GetAsync<ParsedPrd>(key);
    }

    public async Task<ParsedPrd> SaveAsync(ParsedPrd document)
    {
        var key = CacheKeys.ForDocument(document.Id);
        await _cache.SetAsync(key, document);
        return document;
    }

    public int EstimateTokens(string content)
    {
        return _parser.EstimateTokens(content);
    }
}
