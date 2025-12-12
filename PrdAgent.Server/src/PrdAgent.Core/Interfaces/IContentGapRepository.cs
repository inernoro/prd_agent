using PrdAgent.Core.Models;

namespace PrdAgent.Core.Interfaces;

/// <summary>
/// 内容缺口仓储接口
/// </summary>
public interface IContentGapRepository
{
    Task InsertAsync(ContentGap gap);
    Task<List<ContentGap>> GetByGroupIdAsync(string groupId, GapStatus? status = null);
    Task<ContentGap?> FindAndUpdateStatusAsync(string gapId, GapStatus status);
    Task<long> CountPendingAsync(string groupId);
}
