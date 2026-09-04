using System.Net;
using System.Runtime.CompilerServices;
using Microsoft.Extensions.Configuration;
using PrdAgent.Api.Services;
using PrdAgent.Core.Models;
using Xunit;

namespace PrdAgent.Api.Tests;

public class DesignArtifactProviderCatalogTests
{
    [Fact]
    public async Task CatalogAcceptsAdditionalProviderWithoutChangingController()
    {
        var configuration = new ConfigurationBuilder().Build();
        var catalog = new DesignArtifactProviderCatalog(
            [new BuiltInDesignArtifactProviderDefinitionSource(), new ClosedDesignDefinitionSource()],
            [new StubExecutor("map-gateway"), new StubExecutor("closed-design")],
            configuration,
            new StubHttpClientFactory(HttpStatusCode.OK));

        var capability = await catalog.FindAsync("closed-design");

        Assert.NotNull(capability);
        Assert.True(capability.Enabled);
        Assert.Equal(DesignArtifactAdapterKinds.InProcess, capability.AdapterKind);
        Assert.Contains(DesignArtifactOperations.Edit, capability.Operations);
    }

    [Fact]
    public async Task RemoteProviderStaysDisabledUntilRuntimeAndAdapterBothExist()
    {
        var configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["DesignGeneration:Runtimes:OpenDesign:Enabled"] = "true",
                ["DesignGeneration:Runtimes:OpenDesign:BaseUrl"] = "https://open-design.test/",
            })
            .Build();
        var catalog = new DesignArtifactProviderCatalog(
            [new BuiltInDesignArtifactProviderDefinitionSource()],
            [new StubExecutor("map-gateway")],
            configuration,
            new StubHttpClientFactory(HttpStatusCode.OK));

        var capability = await catalog.FindAsync(DesignArtifactRuntimes.OpenDesign);

        Assert.NotNull(capability);
        Assert.True(capability.Configured);
        Assert.True(capability.Healthy);
        Assert.False(capability.Enabled);
        Assert.Equal(DesignArtifactExecutionOwners.CdsRemoteAgent, capability.ExecutionOwner);
        Assert.Equal(DesignArtifactIsolationModes.SessionContainer, capability.IsolationMode);
        Assert.Contains("适配器尚未安装", capability.Reason);
    }

    private sealed class ClosedDesignDefinitionSource : IDesignArtifactProviderDefinitionSource
    {
        public IEnumerable<DesignArtifactProviderDefinition> GetDefinitions()
        {
            yield return new DesignArtifactProviderDefinition(
                "closed-design",
                "ClosedDesign",
                DesignArtifactAdapterKinds.InProcess,
                DesignArtifactExecutionOwners.Map,
                DesignArtifactIsolationModes.Process,
                [DesignArtifactTypes.WebPage],
                [DesignArtifactOperations.Generate, DesignArtifactOperations.Edit],
                [DesignArtifactSourceSurfaces.WebHosting]);
        }
    }

    private sealed class StubExecutor(string runtime) : IDesignArtifactExecutor
    {
        public string Runtime { get; } = runtime;

        public bool Supports(string artifactType, string operation) => true;

        public async IAsyncEnumerable<DesignArtifactExecutorChunk> ExecuteAsync(
            DesignArtifactRun run,
            string? currentHtml,
            [EnumeratorCancellation] CancellationToken ct)
        {
            await Task.CompletedTask;
            yield break;
        }
    }

    private sealed class StubHttpClientFactory(HttpStatusCode statusCode) : IHttpClientFactory
    {
        public HttpClient CreateClient(string name) => new(new StubHandler(statusCode));
    }

    private sealed class StubHandler(HttpStatusCode statusCode) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken) =>
            Task.FromResult(new HttpResponseMessage(statusCode));
    }
}
