namespace PrdAgent.Infrastructure.LlmGateway;

/// <summary>
/// 显式逻辑模型的独立 Gateway 边界。
///
/// 逻辑模型属于 llmgw-serve 配置域，解析与发送必须跨进程走 HTTP，不能受 MAP
/// 仍处于 inproc/shadow 迁移阶段的全局模式影响，也不能退回同名旧模型池。
/// </summary>
public interface ILogicalModelGateway : ILlmGateway
{
}
