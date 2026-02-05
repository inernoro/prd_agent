using PrdAgent.Core.Models.Toolbox;

namespace PrdAgent.Api.Services.Toolbox;

/// <summary>
/// 意图识别器接口
/// 将用户自然语言转换为结构化的意图
/// </summary>
public interface IIntentClassifier
{
    /// <summary>
    /// 识别用户输入的意图
    /// </summary>
    /// <param name="userMessage">用户输入的自然语言</param>
    /// <param name="ct">取消令牌</param>
    /// <returns>意图识别结果</returns>
    Task<IntentResult> ClassifyAsync(string userMessage, CancellationToken ct = default);
}
