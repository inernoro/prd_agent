namespace PrdAgent.Api.Models.Requests;

/// <summary>
/// 初始化群内默认机器人账号请求
/// </summary>
public class BootstrapGroupBotsRequest
{
    /// <summary>
    /// 是否只返回机器人列表但不创建/不加入（预留；当前固定为 false，保持接口向后可扩展）
    /// </summary>
    public bool DryRun { get; set; } = false;

    public (bool isValid, string? error) Validate()
    {
        // 预留扩展：后续可以支持指定 kinds / 是否自动交接策略等
        return (true, null);
    }
}


