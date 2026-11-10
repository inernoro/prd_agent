using PrdAgent.GatewayTransport;
using PrdAgent.Core.LlmGateway;

namespace PrdAgent.Infrastructure.LlmGateway;

// 一个逻辑调用持有自己的客户端；每个重试候选使用计算阶段确定的代理，
// 流式响应读完后才统一释放，避免把客户端在响应头返回时提前销毁。
internal sealed class UpstreamProxyClientScope(IHttpClientFactory factory, bool publicOnly) : IDisposable
{
    private readonly Dictionary<ResolvedUpstreamProxy, HttpClient> _clients = new();
    private HttpClient? _default;

    public HttpClient Get(ModelResolutionResult resolution, int timeoutSeconds)
    {
        HttpClient client;
        if (resolution.UpstreamProxy is not { } proxy)
        {
            if (_default is null)
            {
                _default = publicOnly ? factory.CreateClient("SafeOutbound") : factory.CreateClient();
                _default.Timeout = timeoutSeconds <= 0 ? Timeout.InfiniteTimeSpan : TimeSpan.FromSeconds(timeoutSeconds);
            }
            client = _default;
        }
        else if (!_clients.TryGetValue(proxy, out client!))
        {
            client = new HttpClient(UpstreamProxy.CreateHandler(proxy, publicOnly))
                { Timeout = timeoutSeconds <= 0 ? Timeout.InfiniteTimeSpan : TimeSpan.FromSeconds(timeoutSeconds) };
            _clients.Add(proxy, client);
        }
        return client;
    }

    public void Dispose()
    {
        _default?.Dispose();
        foreach (var client in _clients.Values) client.Dispose();
    }
}
