namespace PrdAgent.Core.Interfaces.LlmGateway;

/// <summary>
/// LLM Gateway 统一接口 - 所有大模型调用的守门员
///
/// 设计原则：
/// 1. 所有 LLM 调用必须通过此接口
/// 2. 自动处理模型调度（根据 AppCallerCode 和模型池配置）
/// 3. 统一日志记录
/// 4. 统一健康管理
/// </summary>
public interface ILlmGateway
{
    /// <summary>
    /// 创建 LLM 客户端（用于流式对话等场景）
    /// 返回的客户端内部通过 Gateway 发送所有请求
    /// </summary>
    /// <param name="appCallerCode">应用调用标识（如 "prd-agent.chat::chat"）</param>
    /// <param name="modelType">模型类型（chat/vision/intent/generation）</param>
    /// <param name="maxTokens">最大 Token 数（默认 4096）</param>
    /// <param name="temperature">温度参数（默认 0.2）</param>
    /// <returns>LLM 客户端实例</returns>
    ILLMClient CreateClient(
        string appCallerCode,
        string modelType,
        int maxTokens = 4096,
        double temperature = 0.2,
        bool includeThinking = false);
}
