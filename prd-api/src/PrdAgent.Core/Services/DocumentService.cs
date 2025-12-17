using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using System.Security.Cryptography;
using System.Text;

namespace PrdAgent.Core.Services;

/// <summary>
/// 文档服务实现
/// </summary>
public class DocumentService : IDocumentService
{
    private readonly ICacheManager _cache;
    private readonly IMarkdownParser _parser;
    private readonly IPrdDocumentRepository _documentRepository;

    public DocumentService(ICacheManager cache, IMarkdownParser parser, IPrdDocumentRepository documentRepository)
    {
        _cache = cache;
        _parser = parser;
        _documentRepository = documentRepository;
    }

    public Task<ParsedPrd> ParseAsync(string content)
    {
        if (string.IsNullOrWhiteSpace(content))
        {
            throw new ArgumentException("文档内容不能为空");
        }

        // 归一化换行，避免不同平台导致 hash 不一致
        var normalized = content.Replace("\r\n", "\n");
        var parsed = _parser.Parse(normalized);
        // 以内容 hash 作为稳定 documentId（幂等、可去重）
        parsed.Id = Sha256Hex(normalized);
        return Task.FromResult(parsed);
    }

    public async Task<ParsedPrd?> GetByIdAsync(string documentId)
    {
        var key = CacheKeys.ForDocument(documentId);
        // 1) Redis 热缓存
        var cached = await _cache.GetAsync<ParsedPrd>(key);
        if (cached != null) return cached;

        // 2) MongoDB 长期存储（fallback）
        var persisted = await _documentRepository.GetByIdAsync(documentId);
        if (persisted != null)
        {
            // 写回缓存（仍按默认 TTL，缓存只是加速层）
            await _cache.SetAsync(key, persisted);
        }

        return persisted;
    }

    public async Task<ParsedPrd> SaveAsync(ParsedPrd document)
    {
        var key = CacheKeys.ForDocument(document.Id);
        // MongoDB：长期存储（幂等 upsert）
        await _documentRepository.UpsertAsync(document);
        // Redis：热缓存
        await _cache.SetAsync(key, document);
        return document;
    }

    public int EstimateTokens(string content)
    {
        return _parser.EstimateTokens(content);
    }

    private static string Sha256Hex(string input)
    {
        using var sha = SHA256.Create();
        var bytes = Encoding.UTF8.GetBytes(input);
        var hash = sha.ComputeHash(bytes);
        return Convert.ToHexString(hash).ToLowerInvariant();
    }
}
