using Microsoft.Extensions.DependencyInjection;
using PrdAgent.Api.Services;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Services;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public class CapsuleExecutorVideoDownloaderSecurityTests
{
    [Fact]
    public async Task ExecuteVideoDownloaderAsync_ShouldBlockPrivateNetworkTargets()
    {
        using var services = BuildServices();
        var node = new WorkflowNode
        {
            NodeId = "video-download-test",
            Name = "视频下载安全测试",
            NodeType = CapsuleTypes.VideoDownloader,
            Config = new Dictionary<string, object?>
            {
                ["videoUrl"] = "http://169.254.169.254/latest/meta-data",
            },
        };

        var ex = await Should.ThrowAsync<InvalidOperationException>(() =>
            CapsuleExecutor.ExecuteVideoDownloaderAsync(
                services,
                node,
                new Dictionary<string, string>(),
                new List<ExecutionArtifact>()));

        ex.Message.ShouldContain("内网或保留地址");
    }

    private static ServiceProvider BuildServices()
    {
        var services = new ServiceCollection();
        services.AddSingleton<ISafeOutboundUrlValidator, SafeOutboundUrlValidator>();
        services.AddSingleton<ISafeOutboundHttpHandlerFactory, SafeOutboundHttpHandlerFactory>();
        services.AddHttpClient("SafeOutbound")
            .ConfigurePrimaryHttpMessageHandler(sp =>
                sp.GetRequiredService<ISafeOutboundHttpHandlerFactory>().CreateHandler());
        return services.BuildServiceProvider();
    }
}
