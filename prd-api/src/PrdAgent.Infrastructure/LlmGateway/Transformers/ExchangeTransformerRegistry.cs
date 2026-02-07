using PrdAgent.Core.Interfaces;

namespace PrdAgent.Infrastructure.LlmGateway.Transformers;

/// <summary>
/// Exchange 转换器注册表
/// 管理所有已注册的转换器实例，按 TransformerType 索引
/// </summary>
public class ExchangeTransformerRegistry
{
    private readonly Dictionary<string, IExchangeTransformer> _transformers = new(StringComparer.OrdinalIgnoreCase);

    public ExchangeTransformerRegistry()
    {
        // 注册内置转换器
        Register(new PassthroughTransformer());
        Register(new FalImageEditTransformer());
    }

    public void Register(IExchangeTransformer transformer)
    {
        _transformers[transformer.TransformerType] = transformer;
    }

    public IExchangeTransformer? Get(string? transformerType)
    {
        if (string.IsNullOrWhiteSpace(transformerType))
            return _transformers.GetValueOrDefault("passthrough");

        return _transformers.TryGetValue(transformerType, out var t) ? t : null;
    }

    /// <summary>
    /// 获取所有已注册的转换器类型
    /// </summary>
    public IReadOnlyList<string> GetRegisteredTypes()
    {
        return _transformers.Keys.ToList().AsReadOnly();
    }
}
