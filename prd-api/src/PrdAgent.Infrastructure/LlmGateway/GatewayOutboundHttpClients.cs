using Microsoft.Extensions.DependencyInjection;

namespace PrdAgent.Infrastructure.LlmGateway;

public static class GatewayOutboundHttpClients
{
    public const string InternalClientName = "LlmGatewayOutbound";

    // 保留部署代理与获准内部供应方。每次解析只授权原目标；不自动追随任何跳转。
    public static IHttpClientBuilder AddGatewayOutboundHttpClient(this IServiceCollection services)
        => services.AddHttpClient(InternalClientName)
            .ConfigurePrimaryHttpMessageHandler(() => new SocketsHttpHandler { AllowAutoRedirect = false });
}
