using PrdAgent.GatewayTransport;
using PrdAgent.Core.LlmGateway;

namespace PrdAgent.Infrastructure.LlmGateway;

// 一个逻辑调用持有自己的客户端；每个重试候选使用计算阶段确定的代理，
// 流式响应读完后才统一释放，避免把客户端在响应头返回时提前销毁。
internal sealed class UpstreamProxyClientScope(IHttpClientFactory factory, bool publicOnly,
    UpstreamResponseBudget? budget = null) : IDisposable
{
    private readonly Dictionary<ResolvedUpstreamProxy, HttpClient> _clients = new();
    private readonly List<HttpClient> _protectedClients = new();
    private readonly List<HttpResponseMessage> _responses = new();
    private HttpClient? _default;

    public HttpClient Get(ModelResolutionResult resolution, int timeoutSeconds, bool lineEvents = false,
        UpstreamResponseBudget? responseBudget = null)
    {
        var timeout = timeoutSeconds <= 0 ? Timeout.InfiniteTimeSpan : TimeSpan.FromSeconds(timeoutSeconds);
        HttpClient client;
        if (resolution.UpstreamProxy is not { } proxy)
        {
            if (_default is null)
            {
                _default = publicOnly ? factory.CreateClient("SafeOutbound")
                    : factory.CreateClient(GatewayOutboundHttpClients.InternalClientName);
                _default.Timeout = timeout;
            }
            client = _default;
        }
        else if (!_clients.TryGetValue(proxy, out client!))
        {
            // 模型调用的建连和代理握手服从请求期限，避免被探测用的 15 秒连接上限截断。
            client = new HttpClient(UpstreamProxy.CreateHandler(proxy, publicOnly, connectTimeout: timeout))
                { Timeout = timeout };
            _clients.Add(proxy, client);
        }
        var proxySnapshot = resolution.UpstreamProxy;
        var secrets = new List<string?> { resolution.ApiKey, proxySnapshot?.Password };
        if (!string.IsNullOrEmpty(proxySnapshot?.Password))
            secrets.Add(Convert.ToBase64String(System.Text.Encoding.UTF8.GetBytes($"{proxySnapshot.Username}:{proxySnapshot.Password}")));
        var guarded = new HttpClient(new ProtectedUpstreamHandler(client, secrets, responseBudget ?? budget ?? new(), lineEvents, _responses.Add))
            { Timeout = client.Timeout };
        _protectedClients.Add(guarded);
        return guarded;
    }

    public void Dispose()
    {
        foreach (var client in _protectedClients) client.Dispose();
        foreach (var response in _responses) response.Dispose();
        _default?.Dispose();
        foreach (var client in _clients.Values) client.Dispose();
    }
}
