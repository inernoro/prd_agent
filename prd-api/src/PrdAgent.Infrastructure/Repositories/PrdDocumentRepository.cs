using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;

namespace PrdAgent.Infrastructure.Repositories;

/// <summary>
/// PRD 文档持久化仓储实现（MongoDB）
/// </summary>
public class PrdDocumentRepository : IPrdDocumentRepository
{
    private readonly IMongoCollection<ParsedPrd> _documents;

    public PrdDocumentRepository(IMongoCollection<ParsedPrd> documents)
    {
        _documents = documents;
    }

    public async Task<ParsedPrd?> GetByIdAsync(string documentId)
    {
        return await _documents.Find(d => d.Id == documentId).FirstOrDefaultAsync();
    }

    public async Task UpsertAsync(ParsedPrd document)
    {
        // 以 Id 为唯一键（由内容 hash 得出），重复上传同内容应幂等
        await _documents.ReplaceOneAsync(
            d => d.Id == document.Id,
            document,
            new ReplaceOptions { IsUpsert = true });
    }

    public async Task DeleteAsync(string documentId)
    {
        await _documents.DeleteOneAsync(d => d.Id == documentId);
    }
}

