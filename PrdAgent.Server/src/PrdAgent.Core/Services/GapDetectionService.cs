using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;

namespace PrdAgent.Core.Services;

/// <summary>
/// 内容缺失检测服务实现
/// </summary>
public class GapDetectionService : IGapDetectionService
{
    private readonly IContentGapRepository _gapRepository;

    public GapDetectionService(IContentGapRepository gapRepository)
    {
        _gapRepository = gapRepository;
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

        await _gapRepository.InsertAsync(gap);
        return gap;
    }

    public async Task<List<ContentGap>> GetGapsAsync(string groupId, GapStatus? status = null)
    {
        return await _gapRepository.GetByGroupIdAsync(groupId, status);
    }

    public async Task<ContentGap> UpdateStatusAsync(string gapId, GapStatus status)
    {
        var updated = await _gapRepository.FindAndUpdateStatusAsync(gapId, status);
        return updated ?? throw new KeyNotFoundException("缺失记录不存在");
    }

    public async Task<int> GetPendingCountAsync(string groupId)
    {
        return (int)await _gapRepository.CountPendingAsync(groupId);
    }
}
