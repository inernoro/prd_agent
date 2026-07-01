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
    /// 供直连客户端（ModelDomainService 兜底、ModelLab/Arena 锁定 platform+model）在构建日志时
    /// 读取本上下文的传输标记；网关路径由各自的日志构建点权威标注，不依赖此字段。
    /// </summary>
    string? GatewayTransport = null);

public interface ILLMRequestContextAccessor
{
    LlmRequestContext? Current { get; }
    IDisposable BeginScope(LlmRequestContext context);
}

