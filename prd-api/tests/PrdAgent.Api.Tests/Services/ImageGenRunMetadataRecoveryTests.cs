using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Moq;
using PrdAgent.Api.Services;
using PrdAgent.Core.LlmGateway;
using PrdAgent.Core.Models;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public sealed class ImageGenRunMetadataRecoveryTests
{
    // 使用未配置过的业务模型，避免把恢复能力绑在某个供应商名称上。
    private const string PublicId = "future-image-recovery-fixture";
    private const string Caller = "visual-agent.image.text2img::generation";

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task SizePreviewLeavesRecoveryLeaseForActualGeneration(bool explicitLogicalModel)
    {
        var gateway = new Mock<ILlmGateway>(MockBehavior.Strict);
        gateway.Setup(x => x.ResolveModelMetadataAsync(
                Caller, "generation", PublicId, null, null, It.IsAny<CancellationToken>()))
            .ReturnsAsync(new GatewayModelResolution
            {
                Success = true,
                LogicalModelPublicId = PublicId,
                ActualModel = "future-provider-image",
                ParameterCapabilities = new() { ["image_size.prompt"] = true },
            });
        using var provider = new ServiceCollection().AddSingleton(gateway.Object).BuildServiceProvider();
        using var worker = new ImageGenRunWorker(null!, provider.GetRequiredService<IServiceScopeFactory>(),
            null!, NullLogger<ImageGenRunWorker>.Instance, null!, new ConfigurationBuilder().Build());
        var run = new ImageGenRun
        {
            ModelId = PublicId,
            LogicalModelPublicId = explicitLogicalModel ? PublicId : null,
            PlatformId = explicitLogicalModel ? "logical-model" : null,
        };

        Assert.True(await worker.ResolveRunIsAdaptiveAsync(run, Caller, CancellationToken.None));
        gateway.VerifyAll();
        // 执行解析的次数必须为零，它会原子认领唯一半开名额。
        gateway.Verify(x => x.ResolveModelAsync(It.IsAny<string>(), It.IsAny<string>(),
            It.IsAny<string?>(), It.IsAny<string?>(), It.IsAny<string?>(), It.IsAny<CancellationToken>()), Times.Never);
        gateway.VerifyNoOtherCalls();
    }

    [Theory]
    [InlineData(false, PublicId)]
    [InlineData(true, "unrelated-model")]
    public async Task MissingOrMismatchedMetadataUsesStaticFallbackWithoutExecution(bool success, string actualPublicId)
    {
        var gateway = new Mock<ILlmGateway>(MockBehavior.Strict);
        gateway.Setup(x => x.ResolveModelMetadataAsync(
                Caller, "generation", PublicId, null, null, It.IsAny<CancellationToken>()))
            .ReturnsAsync(new GatewayModelResolution
            {
                Success = success,
                LogicalModelPublicId = actualPublicId,
                ParameterCapabilities = new() { ["image_size.prompt"] = true },
            });
        using var provider = new ServiceCollection().AddSingleton(gateway.Object).BuildServiceProvider();
        using var worker = new ImageGenRunWorker(null!, provider.GetRequiredService<IServiceScopeFactory>(),
            null!, NullLogger<ImageGenRunWorker>.Instance, null!, new ConfigurationBuilder().Build());
        Assert.False(await worker.ResolveRunIsAdaptiveAsync(new ImageGenRun
        {
            ModelId = PublicId, LogicalModelPublicId = PublicId, PlatformId = "logical-model",
        }, Caller, CancellationToken.None));
        gateway.VerifyAll();
        gateway.VerifyNoOtherCalls();
    }
}
