using System.Reflection;
using PrdAgent.Core.Interfaces;

namespace PrdAgent.Infrastructure.Services;

/// <summary>
/// 通用 Fork 服务
/// 使用白名单机制拷贝业务字段，避免手动逐字段拷贝导致的遗漏问题
/// </summary>
public class ForkService
{
    /// <summary>
    /// Fork 一个配置项
    /// </summary>
    /// <typeparam name="T">配置类型，必须实现 IForkable 接口并有无参构造函数</typeparam>
    /// <param name="source">源配置</param>
    /// <param name="newOwnerId">新所有者用户 ID</param>
    /// <param name="sourceOwnerName">源配置所有者名称</param>
    /// <param name="sourceOwnerAvatar">源配置所有者头像</param>
    /// <returns>Fork 后的新配置</returns>
    public T Fork<T>(
        T source,
        string newOwnerId,
        string? sourceOwnerName = null,
        string? sourceOwnerAvatar = null)
        where T : class, IForkable, new()
    {
        var forked = new T();
        var type = typeof(T);

        // 1. 拷贝白名单中的业务字段
        var copyableFields = source.GetCopyableFields();
        foreach (var fieldName in copyableFields)
        {
            var prop = type.GetProperty(fieldName, BindingFlags.Public | BindingFlags.Instance);
            if (prop != null && prop.CanRead && prop.CanWrite)
            {
                var value = prop.GetValue(source);
                prop.SetValue(forked, value);
            }
        }

        // 2. 设置新 ID
        forked.Id = Guid.NewGuid().ToString("N");

        // 3. 设置新所有者
        forked.SetOwnerUserId(newOwnerId);

        // 4. 设置 Fork 来源信息
        forked.ForkedFromId = source.Id;
        forked.ForkedFromUserId = source.GetOwnerUserId();
        forked.ForkedFromUserName = sourceOwnerName;
        forked.ForkedFromUserAvatar = sourceOwnerAvatar;

        // 5. 重置市场相关字段
        forked.IsPublic = false;
        forked.ForkCount = 0;
        forked.IsModifiedAfterFork = false;

        // 6. 设置时间戳
        var now = DateTime.UtcNow;
        forked.CreatedAt = now;
        forked.UpdatedAt = now;

        // 7. 类型特定的后处理
        forked.OnForked();

        return forked;
    }

    /// <summary>
    /// 清除配置的 Fork 来源信息（用于用户修改后）
    /// </summary>
    /// <param name="item">配置项</param>
    public void ClearForkSource(IMarketplaceItem item)
    {
        if (item.ForkedFromId != null)
        {
            item.IsModifiedAfterFork = true;
            item.ForkedFromId = null;
            item.ForkedFromUserId = null;
            item.ForkedFromUserName = null;
            item.ForkedFromUserAvatar = null;
            item.UpdatedAt = DateTime.UtcNow;
        }
    }
}
