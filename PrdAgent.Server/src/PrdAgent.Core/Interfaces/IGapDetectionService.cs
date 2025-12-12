using PrdAgent.Core.Models;

namespace PrdAgent.Core.Interfaces;

/// <summary>
/// 内容缺失检测服务接口
/// </summary>
public interface IGapDetectionService
{
    /// <summary>记录内容缺失</summary>
    Task<ContentGap> RecordGapAsync(
        string groupId, 
        string askedByUserId, 
        string question, 
        GapType gapType,
        string? suggestion = null);
    
    /// <summary>获取群组的缺失列表</summary>
    Task<List<ContentGap>> GetGapsAsync(string groupId, GapStatus? status = null);
    
    /// <summary>更新缺失状态</summary>
    Task<ContentGap> UpdateStatusAsync(string gapId, GapStatus status);
    
    /// <summary>获取未处理的缺失数量</summary>
    Task<int> GetPendingCountAsync(string groupId);
}
