namespace PrdAgent.Core.Interfaces;

/// <summary>
/// LLM客户端工厂接口
/// </summary>
public interface ILLMClientFactory
{
    /// <summary>获取主要LLM客户端</summary>
    ILLMClient GetPrimaryClient();

    /// <summary>获取备用LLM客户端</summary>
    ILLMClient? GetFallbackClient();

    /// <summary>切换到备用客户端</summary>
    void SwitchToFallback();

    /// <summary>重置到主要客户端</summary>
    void ResetToPrimary();

    /// <summary>当前使用的提供商</summary>
    string CurrentProvider { get; }
}