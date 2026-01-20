using System;

namespace PrdAgent.Core.Security;

/// <summary>
/// 标记 Admin Controller 的元数据，用于反射扫描和权限映射
/// </summary>
[AttributeUsage(AttributeTargets.Class, AllowMultiple = false, Inherited = false)]
public sealed class AdminControllerAttribute : Attribute
{
    /// <summary>
    /// 应用标识，用于菜单分组（如 "admin-users"、"visual-agent"）
    /// 一个 AppKey 可以对应多个 Controller（相同前缀）
    /// </summary>
    public string AppKey { get; }

    /// <summary>
    /// 访问该 Controller 所需的读权限（如 "admin.users.read"）
    /// GET/HEAD/OPTIONS 方法使用此权限
    /// </summary>
    public string ReadPermission { get; }

    /// <summary>
    /// 写操作所需权限（可选，默认与 ReadPermission 相同）
    /// POST/PUT/PATCH/DELETE 方法使用此权限
    /// </summary>
    public string? WritePermission { get; set; }

    /// <summary>
    /// 构造函数
    /// </summary>
    /// <param name="appKey">应用标识，用于菜单分组</param>
    /// <param name="readPermission">读操作所需权限</param>
    public AdminControllerAttribute(string appKey, string readPermission)
    {
        AppKey = appKey ?? throw new ArgumentNullException(nameof(appKey));
        ReadPermission = readPermission ?? throw new ArgumentNullException(nameof(readPermission));
    }
}
