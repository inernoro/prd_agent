using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;

namespace PrdAgent.Infrastructure.Repositories;

public class PrdCommentRepository : IPrdCommentRepository
{
    private readonly IMongoCollection<PrdComment> _comments;

    public PrdCommentRepository(IMongoCollection<PrdComment> comments)
    {
        _comments = comments;
    }

    public async Task<PrdComment?> GetByIdAsync(string commentId)
    {
        return await _comments.Find(c => c.Id == commentId).FirstOrDefaultAsync();
    }

    public async Task<List<PrdComment>> ListAsync(string documentId, string? headingId, int limit)
    {
        var filter = Builders<PrdComment>.Filter.Eq(x => x.DocumentId, documentId);
        if (!string.IsNullOrWhiteSpace(headingId))
        {
            filter &= Builders<PrdComment>.Filter.Eq(x => x.HeadingId, headingId);
        }

        limit = Math.Clamp(limit, 1, 200);

        return await _comments
            .Find(filter)
            .SortByDescending(x => x.CreatedAt)
            .Limit(limit)
            .ToListAsync();
    }

    public async Task InsertAsync(PrdComment comment)
    {
        await _comments.InsertOneAsync(comment);
    }

    public async Task DeleteAsync(string commentId)
    {
        await _comments.DeleteOneAsync(c => c.Id == commentId);
    }

    public async Task DeleteByDocumentIdAsync(string documentId)
    {
        await _comments.DeleteManyAsync(c => c.DocumentId == documentId);
    }
}
