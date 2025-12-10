using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;

namespace PrdAgent.Core.Services;

/// <summary>
/// 内容缺失检测服务实现
/// </summary>
public class GapDetectionService : IGapDetectionService
{
    private readonly IMongoCollection<ContentGap> _gaps;

    public GapDetectionService(IMongoCollection<ContentGap> gaps)
    {
        _gaps = gaps;
    }

    public async Task<ContentGap> RecordGapAsync(
        string groupId,
        string askedByUserId,
        string question,
        GapType gapType,
        string? suggestion = null)
    {
        var gap = new ContentGap
        {
            GroupId = groupId,
            AskedByUserId = askedByUserId,
            Question = question,
            GapType = gapType,
            Suggestion = suggestion,
            Status = GapStatus.Pending
        };

        await _gaps.InsertOneAsync(gap);
        return gap;
    }

    public async Task<List<ContentGap>> GetGapsAsync(string groupId, GapStatus? status = null)
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

    public async Task<ContentGap> UpdateStatusAsync(string gapId, GapStatus status)
    {
        var update = Builders<ContentGap>.Update
            .Set(g => g.Status, status);

        if (status == GapStatus.Resolved || status == GapStatus.Ignored)
        {
            update = update.Set(g => g.ResolvedAt, DateTime.UtcNow);
        }

        var result = await _gaps.FindOneAndUpdateAsync(
            g => g.GapId == gapId,
            update,
            new FindOneAndUpdateOptions<ContentGap> { ReturnDocument = ReturnDocument.After });

        return result ?? throw new KeyNotFoundException("缺失记录不存在");
    }

    public async Task<int> GetPendingCountAsync(string groupId)
    {
        return (int)await _gaps.CountDocumentsAsync(
            g => g.GroupId == groupId && g.Status == GapStatus.Pending);
    }
}

