using System.Net;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Http;
using PrdAgent.Core.Security;

namespace PrdAgent.Infrastructure.Security;

/// <summary>
/// MAP 的 HTTP 工厂出口边界。只读模型目录保留；模型付费运输只能进入经过平台许可的网关。
/// 此边界与代码守卫配合，不宣称替代容器网络隔离。
/// </summary>
public sealed class MapModelEgressHandler(string clientName, Uri gatewayBase) : DelegatingHandler
{
    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
    {
        Validate(request);
        var response = await base.SendAsync(request, ct);
        // 主处理器禁止自动跳转；普通网页/附件 GET 在本层逐跳校验，避免跳过出口检查。
        if (request.Method != HttpMethod.Get && request.Method != HttpMethod.Head) return response;
        HttpRequestMessage current = request;
        HttpRequestMessage? owned = null;
        try
        {
            for (var hop = 0; IsRedirect(response.StatusCode) && response.Headers.Location is { } location; hop++)
            {
                if (IsGateway(current.RequestUri!) || hop >= 5) return response;
                var nextUri = location.IsAbsoluteUri ? location : new Uri(current.RequestUri!, location);
                var next = new HttpRequestMessage(current.Method, nextUri);
                var sameAuthority = SameAuthority(current.RequestUri!, nextUri);
                foreach (var header in current.Headers)
                {
                    if (!sameAuthority && IsCredential(header.Key)) continue;
                    next.Headers.TryAddWithoutValidation(header.Key, header.Value);
                }
                try { Validate(next); }
                catch { next.Dispose(); response.Dispose(); throw; }
                response.Dispose();
                owned?.Dispose();
                owned = next;
                current = next;
                response = await base.SendAsync(next, ct);
            }
            return response;
        }
        finally { owned?.Dispose(); }
    }

    private void Validate(HttpRequestMessage request)
    {
        var uri = request.RequestUri;
        if (uri is null || !uri.IsAbsoluteUri || uri.Scheme is not ("http" or "https"))
            throw Denied();
        if (IsGateway(uri))
        {
            if (IsReadOnlyGatewayRoute(request)) return;
            if (string.Equals(clientName, AuthorizedGatewayRequest.HttpClientName, StringComparison.Ordinal)
                && AuthorizedGatewayRequest.WasAuthorized(request)) return;
            throw Denied();
        }
        // 网关内部凭据不能被带往其它目的地；HTTP 自报许可不会放开供应商直连。
        if (request.Headers.Contains("X-Gateway-Key") || request.Headers.Contains("X-Gateway-Task-Permit")
            || IsPaidModelProtocol(request))
            throw Denied();
    }

    private bool IsGateway(Uri uri) => SameAuthority(uri, gatewayBase);

    private static bool SameAuthority(Uri left, Uri right)
        => string.Equals(left.Scheme, right.Scheme, StringComparison.OrdinalIgnoreCase)
           && string.Equals(left.IdnHost, right.IdnHost, StringComparison.OrdinalIgnoreCase)
           && left.Port == right.Port;

    private static bool IsReadOnlyGatewayRoute(HttpRequestMessage request)
    {
        var path = request.RequestUri!.AbsolutePath.TrimEnd('/');
        if (request.Method == HttpMethod.Post) return path == "/gw/v1/resolve";
        if (request.Method != HttpMethod.Get) return false;
        if (path is "/gw/v1/pools" or "/gw/v1/image-models" or "/v1/models"
            or "/gw/v1/healthz" or "/gw/v1/healthz/ready" or "/gw/v1/healthz/deep") return true;
        // 这两项是 serving 已登记的只读合同；单模型本来支持 vendor/model catch-all。
        if (path.StartsWith("/v1/models/", StringComparison.Ordinal)) return true;
        var segments = path.Split('/');
        return segments.Length == 6 && segments[1] == "gw" && segments[2] == "v1"
               && segments[3] == "requests" && segments[4].Length > 0 && segments[5] == "status";
    }

    internal static bool IsPaidModelProtocol(HttpRequestMessage request)
    {
        var uri = request.RequestUri!;
        var path = Uri.UnescapeDataString(uri.AbsolutePath).TrimEnd('/').ToLowerInvariant();
        // /models 是只读供应商目录，含供应商认证也不应影响正常配置核验。
        if ((request.Method == HttpMethod.Get || request.Method == HttpMethod.Head)
            && path.EndsWith("/models", StringComparison.Ordinal))
            return false;
        if (path.EndsWith(":generatecontent", StringComparison.Ordinal)
            || path.EndsWith(":streamgeneratecontent", StringComparison.Ordinal)
            || path.EndsWith(":predict", StringComparison.Ordinal)
            || path.EndsWith(":predictlongrunning", StringComparison.Ordinal)) return true;
        string[] endpoints = ["/chat/completions", "/completions", "/responses", "/messages", "/embeddings",
            "/rerank", "/images/generations", "/images/edits", "/images/variations", "/audio/transcriptions",
            "/audio/translations", "/audio/speech", "/contents/generations/tasks", "/predictions"];
        if (endpoints.Any(endpoint => path.EndsWith(endpoint, StringComparison.Ordinal))) return true;
        if (request.Method == HttpMethod.Get || request.Method == HttpMethod.Head) return false;
        if (path.Contains("/api/v3/auc/", StringComparison.Ordinal) || path.Contains("/api/v3/sauc/", StringComparison.Ordinal)) return true;
        if (uri.IdnHost.Equals("fal.run", StringComparison.OrdinalIgnoreCase)
            || uri.IdnHost.EndsWith(".fal.run", StringComparison.OrdinalIgnoreCase)) return true;
        return request.Headers.Contains("anthropic-version")
               || request.Headers.Contains("x-goog-api-key")
               || request.Headers.Contains("X-Api-App-Key")
               || request.Headers.Contains("X-Api-Access-Key");
    }

    private static bool IsCredential(string header)
        => header.Equals("Authorization", StringComparison.OrdinalIgnoreCase)
           || header.Equals("Proxy-Authorization", StringComparison.OrdinalIgnoreCase)
           || header.Equals("Host", StringComparison.OrdinalIgnoreCase)
           || header.Equals("Cookie", StringComparison.OrdinalIgnoreCase)
           || header.EndsWith("-key", StringComparison.OrdinalIgnoreCase)
           || header.EndsWith("-token", StringComparison.OrdinalIgnoreCase)
           || header.StartsWith("X-Gateway-", StringComparison.OrdinalIgnoreCase);

    private static bool IsRedirect(HttpStatusCode status)
        => status is HttpStatusCode.MovedPermanently or HttpStatusCode.Found or HttpStatusCode.SeeOther
            or HttpStatusCode.TemporaryRedirect or HttpStatusCode.PermanentRedirect;

    private static TaskExecutionAdmissionException Denied()
        => new("MODEL_EGRESS_NOT_ADMITTED", "本次模型调用未获得平台许可，请从正常操作入口重新发起。", 403);
}

internal sealed class MapModelEgressFilter(IConfiguration configuration) : IHttpMessageHandlerBuilderFilter
{
    public Action<HttpMessageHandlerBuilder> Configure(Action<HttpMessageHandlerBuilder> next) => builder =>
    {
        next(builder);
        if (builder.PrimaryHandler is HttpClientHandler http) http.AllowAutoRedirect = false;
        if (builder.PrimaryHandler is SocketsHttpHandler sockets) sockets.AllowAutoRedirect = false;
        var gateway = new Uri(configuration["LlmGateway:ServeBaseUrl"] ?? "http://llmgw-serve:8091", UriKind.Absolute);
        builder.AdditionalHandlers.Insert(0, new MapModelEgressHandler(builder.Name ?? string.Empty, gateway));
    };
}

public static class MapModelEgressRegistration
{
    /// <summary>仅 MAP 进程注册；serving 的供应商发送由自身网关治理，不能反向套用本门。</summary>
    public static IServiceCollection AddMapModelEgressGuard(this IServiceCollection services)
    {
        services.AddHttpClient(AuthorizedGatewayRequest.HttpClientName);
        services.TryAddEnumerable(ServiceDescriptor.Singleton<IHttpMessageHandlerBuilderFilter, MapModelEgressFilter>());
        return services;
    }
}
