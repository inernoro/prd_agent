using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;

namespace PrdAgent.Infrastructure.Repositories;

/// <summary>
/// 内容缺口仓储实现
/// </summary>
public class ContentGapRepository : IContentGapRepository
{
    private readonly IMongoCollection<ContentGap> _gaps;

    public ContentGapRepository(IMongoCollection<ContentGap> gaps)
    {
        _gaps = gaps;
    }

    public async Task InsertAsync(ContentGap gap)
    {
        await _gaps.InsertOneAsync(gap);
    }

    public async Task<List<ContentGap>> GetByGroupIdAsync(string groupId, GapStatus? status = null)
    {
        var filter = Builders<ContentGap>.Filter.Eq(g => g.GroupId, groupId);
        
        if (status.HasValue)
        {
            filter &= Builders<ContentGap>.Filter.Eq(g => g.Status, status.Value);
        }

        return await _gaps.Find(filter)
            .SortByDescending(g => g.AskedAt)
            .ToListAsync();
    }

    public async Task<ContentGap?> FindAndUpdateStatusAsync(string gapId, GapStatus status)
    {
        var update = Builders<ContentGap>.Update
            .Set(g => g.Status, status);

        if (status == GapStatus.Resolved || status == GapStatus.Ignored)
        {
            update = update.Set(g => g.ResolvedAt, DateTime.UtcNow);
        }

        return await _gaps.FindOneAndUpdateAsync<ContentGap, ContentGap>(
            g => g.GapId == gapId,
            update,
            new FindOneAndUpdateOptions<ContentGap, ContentGap> { ReturnDocument = ReturnDocument.After });
    }

    public async Task<long> CountPendingAsync(string groupId)
    {
        return await _gaps.CountDocumentsAsync(
            g => g.GroupId == groupId && g.Status == GapStatus.Pending);
    }
}

