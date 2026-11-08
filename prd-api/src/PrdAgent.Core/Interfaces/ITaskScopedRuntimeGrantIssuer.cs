namespace PrdAgent.Core.Interfaces;

/// <summary>
/// 仅为当前已核验的平台任务准备远程 SDK 请求；保留已选模型，替换为父许可约束下的短期网关密钥。
/// 不解析新模型，不签发任务许可，不接受用户身份或供应商密钥作为执行授权。
/// </summary>
public interface ITaskScopedRuntimeGrantIssuer
{
    Task<SidecarRunRequest> PrepareAsync(SidecarRunRequest request, CancellationToken ct);
}
