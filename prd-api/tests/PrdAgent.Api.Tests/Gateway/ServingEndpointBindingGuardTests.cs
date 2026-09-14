using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Routing;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using PrdAgent.LlmGatewayHost;
using Shouldly;
using System.Text.Json;
using Xunit;

namespace PrdAgent.Api.Tests.Gateway;

/// <summary>
/// serving 端点的参数绑定守卫。
///
/// 由来（2026-09-14 真实事故）：`/v1/models` 的处理函数写成
/// <c>(HttpContext http, LlmGatewayDataContext data, CancellationToken ct)</c>，
/// 没标 <c>[FromServices]</c>。minimal API 对「不在 DI 里」的复杂类型一律推断成 body，
/// 而 GET 不许有推断 body，于是**整张端点表构建失败**——同一个 app 上的所有端点跟着一起没了。
///
/// 为什么没被发现：生产 serving 里 <c>LlmGatewayDataContext</c> 是注册着的，
/// 推断走到服务那一支，一切正常；只有在「没注册它」的宿主上才炸。
/// 于是 CDS 上的真实验证全绿，坏的是另外两条跑同一个 MapGatewayServingEndpoints 的测试用例，
/// 而它们的报错（Body was inferred）完全不提是谁引入的。
///
/// 判据因此不能是「扫源码里有没有 FromServices」——那只是症状的一种写法。
/// 判据是**行为**：在一个不注册任何网关服务的宿主上装上全部端点，它必须能建得起来。
/// 把 FromServices 拿掉，这条用例立刻红。
/// </summary>
public sealed class ServingEndpointBindingGuardTests
{
    [Fact]
    public async Task 不注册网关服务的宿主_也必须能把端点表建起来()
    {
        var builder = WebApplication.CreateBuilder();
        builder.Logging.ClearProviders();
        builder.WebHost.UseTestServer();
        // 宿主照 GatewayMultipartHttpTests 那个已知可用的最小集注册——它是这道判据的参照系：
        // 那套注册下端点表本来建得起来，是 `/v1/models` 把它弄坏的。
        // 这里只要让 IServiceProviderIsService 认得这几个类型，绑定推断就会走服务那一支，
        // 所以给 null 工厂足够：委托一次都不会被执行，我们只建端点表不发请求。
        builder.Services.AddSingleton<PrdAgent.Infrastructure.Services.AssetStorage.IAssetStorage>(_ => null!);
        builder.Services.AddSingleton<PrdAgent.Core.LlmGateway.ILlmGateway>(_ => null!);
        builder.Services.AddSingleton<PrdAgent.Core.Interfaces.ILLMRequestContextAccessor>(_ => null!);
        // 唯独不注册 LlmGatewayDataContext：这正是「推断成 body」会发生的那种宿主。
        await using var app = builder.Build();
        app.MapGatewayServingEndpoints(
            new JsonSerializerOptions(JsonSerializerDefaults.Web),
            "binding-guard-key",
            "binding-guard-test");

        await app.StartAsync();
        try
        {
            // 判据必须落在**枚举 EndpointDataSource** 上，不能只是 StartAsync 成功：
            // 每个端点的委托是懒建的，StartAsync 不碰它，只有枚举（或真有请求匹配上）
            // 才会逐个 RequestDelegateFactory.Create——参数绑定推断错就在那一刻抛。
            // 第一版就是只断言了 StartAsync，把 FromServices 撤掉照样绿（形状 4：测试自己坏了）。
            var endpoints = app.Services.GetRequiredService<EndpointDataSource>();
            Should.NotThrow(() =>
            {
                foreach (var endpoint in endpoints.Endpoints)
                {
                    _ = (endpoint as RouteEndpoint)?.RequestDelegate;
                }
            });
        }
        finally
        {
            await app.StopAsync();
        }
    }
}
