namespace PrdAgent.Core.Interfaces;

/// <summary>
/// Admin Controller 扫描结果的元数据
/// </summary>
public sealed class AdminControllerMeta
{
    /// <summary>
    /// Controller 路由前缀（如 "/api/v1/admin/users"）
    /// </summary>
    public string RoutePrefix { get; init; } = string.Empty;

    /// <summary>
    /// 应用标识，用于菜单分组（如 "admin-users"、"visual-agent"）
    /// </summary>
    public string AppKey { get; init; } = string.Empty;

    /// <summary>
    /// 读操作所需权限
    /// </summary>
    public string ReadPermission { get; init; } = string.Empty;

    /// <summary>
    /// 写操作所需权限
    /// </summary>
    public string WritePermission { get; init; } = string.Empty;

    /// <summary>
    /// Controller 类型（用于调试）
    /// </summary>
    public Type ControllerType { get; init; } = typeof(object);
}

/// <summary>
/// Admin Controller 反射扫描服务接口
/// </summary>
public interface IAdminControllerScanner
{
    /// <summary>
    /// 获取所有扫描到的 Controller 元数据
    /// </summary>
    IReadOnlyList<AdminControllerMeta> GetAllControllers();

    /// <summary>
    /// 获取 RoutePrefix → Controller 元数据的映射表
    /// </summary>
    IReadOnlyDictionary<string, AdminControllerMeta> GetRoutePrefixMap();

    /// <summary>
    /// 获取 AppKey → Controller 元数据列表的映射表（一个 AppKey 对应多个 Controller）
    /// </summary>
    IReadOnlyDictionary<string, List<AdminControllerMeta>> GetAppKeyMap();

    /// <summary>
    /// 根据请求路径和方法获取所需权限
    /// </summary>
    /// <param name="path">请求路径</param>
    /// <param name="method">HTTP 方法</param>
    /// <returns>所需权限，如果无需权限则返回 null</returns>
    string? GetRequiredPermission(string path, string method);
}
