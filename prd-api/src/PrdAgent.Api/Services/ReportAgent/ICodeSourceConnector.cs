namespace PrdAgent.Api.Services.ReportAgent;

/// <summary>
/// 代码源连接器接口（Git / SVN 等）
/// </summary>
public interface ICodeSourceConnector
{
    /// <summary>
    /// 测试连接是否正常
    /// </summary>
    Task<bool> TestConnectionAsync(CancellationToken ct);

    /// <summary>
    /// 同步提交记录，返回新增数量
    /// </summary>
    Task<int> SyncAsync(CancellationToken ct);
}
