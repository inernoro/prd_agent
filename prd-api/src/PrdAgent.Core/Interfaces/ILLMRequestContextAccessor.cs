using PrdAgent.Core.Models;

namespace PrdAgent.Core.Interfaces;

public record LlmRequestContext(
    string RequestId,
    string? GroupId,
    string? SessionId,
    string? UserId,
    string? ViewRole,
    int? DocumentChars,
    string? DocumentHash,
    string? SystemPromptRedacted,
    string? RequestType = null,
    string? AppCallerCode = null,
    string? PlatformId = null,
    string? PlatformName = null,
    /// <summary>模型解析类型（0=直连单模型, 1=默认模型池, 2=专属模型池）</summary>
    ModelResolutionType? ModelResolutionType = null,
    string? ModelGroupId = null,
    string? ModelGroupName = null,
    /// <summary>
    /// 网关传输路径观测标记（S2）：inproc / http / shadow / direct。
    /// 仅真实直连路径需要显式设置 direct；网关路径由各自的日志构建点权威标注，不依赖此字段。
    /// </summary>
    string? GatewayTransport = null,
    /// <summary>
    /// 内部发布取证开关：当前请求强制执行完整 shadow 比对。
    /// 仅由服务端校验过的内部采样 header 设置；普通用户请求保持 false。
    /// </summary>
    bool ForceFullShadowSample = false,
    /// <summary>
    /// 内部健康探针标记：探针必须走真实网关链路，但日志和发布 gate 需要把它与用户流量区分开。
    /// </summary>
    bool? IsHealthProbe = null);

public interface ILLMRequestContextAccessor
{
    LlmRequestContext? Current { get; }
    IDisposable BeginScope(LlmRequestContext context);
}
