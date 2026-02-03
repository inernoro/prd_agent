namespace PrdAgent.Core.Interfaces;

/// <summary>
/// 海鲜市场可发布配置项的基础接口
/// 所有可发布到海鲜市场的配置类型都应实现此接口
/// </summary>
public interface IMarketplaceItem
{
    /// <summary>配置 ID</summary>
    string Id { get; set; }

    /// <summary>获取显示名称（用于市场列表展示）</summary>
    string GetDisplayName();

    /// <summary>获取配置类型标识（如 "prompt", "refImage", "watermark"）</summary>
    string GetConfigType();

    /// <summary>获取所有者用户 ID</summary>
    string? GetOwnerUserId();

    /// <summary>设置所有者用户 ID</summary>
    void SetOwnerUserId(string userId);

    #region 海鲜市场通用字段

    /// <summary>是否公开到海鲜市场</summary>
    bool IsPublic { get; set; }

    /// <summary>被 Fork 的次数</summary>
    int ForkCount { get; set; }

    /// <summary>Fork 来源配置 ID</summary>
    string? ForkedFromId { get; set; }

    /// <summary>Fork 来源用户 ID</summary>
    string? ForkedFromUserId { get; set; }

    /// <summary>Fork 来源用户名</summary>
    string? ForkedFromUserName { get; set; }

    /// <summary>Fork 来源用户头像</summary>
    string? ForkedFromUserAvatar { get; set; }

    /// <summary>Fork 后是否已修改</summary>
    bool IsModifiedAfterFork { get; set; }

    /// <summary>创建时间</summary>
    DateTime CreatedAt { get; set; }

    /// <summary>更新时间</summary>
    DateTime UpdatedAt { get; set; }

    #endregion
}

/// <summary>
/// 可 Fork 的配置项接口
/// 扩展 IMarketplaceItem，添加 Fork 相关的配置
/// </summary>
public interface IForkable : IMarketplaceItem
{
    /// <summary>
    /// 获取需要拷贝的业务字段名列表（白名单）
    /// Fork 时只拷贝这些字段，其他字段会被重置
    /// </summary>
    /// <returns>字段名数组</returns>
    string[] GetCopyableFields();

    /// <summary>
    /// Fork 后的特殊处理
    /// 例如：重置 IsActive 状态、重新计算 Order 等
    /// </summary>
    void OnForked();
}
