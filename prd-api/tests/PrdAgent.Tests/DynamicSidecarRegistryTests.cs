using System.Net;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using PrdAgent.Core.Interfaces;
using PrdAgent.Infrastructure.Services.ClaudeSidecar;
using Xunit;

namespace PrdAgent.Tests;

public class DynamicSidecarRegistryTests
{
    [Fact]
    public async Task RefreshAsync_DiscoversPairedCdsInstances()
    {
        var options = new ClaudeSidecarOptions
        {
            Enabled = false,
            DefaultSidecarToken = "default-token",
            CdsDiscovery = new CdsDiscoveryConfig
            {
                Enabled = false,
                EnablePairedInfraConnections = true,
                SharedSidecarToken = "shared-sidecar-token",
            },
        };
        var infra = new FakeInfraConnectionService(
            new InfraConnectionPublicView(
                Id: "conn-1",
                Partner: "cds",
                PartnerName: "CDS",
                PartnerId: "cds-1",
                PartnerBaseUrl: "https://cds.example.test",
                ProjectId: "proj-1",
                InstanceDiscoveryUrl: "/api/projects/proj-1/instances",
                Scopes: new[] { "instance:read" },
                Status: "active",
                CreatedAt: DateTime.UtcNow,
                UpdatedAt: DateTime.UtcNow,
                LastProbedAt: null,
                LastProbeOk: null,
                LastProbeError: null,
                LongTokenExpiresAt: DateTime.UtcNow.AddYears(1)),
            "cds-long-token");
        var services = new ServiceCollection()
            .AddSingleton<IInfraConnectionService>(infra)
            .BuildServiceProvider();
        var httpFactory = new FakeHttpClientFactory(req =>
        {
            Assert.Equal("https://cds.example.test/api/projects/proj-1/instances", req.RequestUri!.ToString());
            Assert.Equal("Bearer", req.Headers.Authorization?.Scheme);
            Assert.Equal("cds-long-token", req.Headers.Authorization?.Parameter);
            return new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent("""
                {
                  "projectId": "proj-1",
                  "instances": [
                    {
                      "deploymentId": "dep-1",
                      "hostId": "host-a",
                      "host": "10.0.0.8",
                      "port": 7400,
                      "healthy": true,
                      "tags": ["prod", "agent-sdk"]
                    }
                  ]
                }
                """),
            };
        });

        var registry = new DynamicSidecarRegistry(
            new StaticOptionsMonitor<ClaudeSidecarOptions>(options),
            httpFactory,
            services.GetRequiredService<IServiceScopeFactory>(),
            NullLogger<DynamicSidecarRegistry>.Instance);

        await registry.RefreshAsync(CancellationToken.None);

        var current = registry.GetCurrent();
        var item = Assert.Single(current);
        Assert.Equal("cds-pairing:conn-1:host-a", item.Name);
        Assert.Equal("http://10.0.0.8:7400", item.BaseUrl);
        Assert.Equal("shared-sidecar-token", item.Token);
        Assert.Equal("cds-pairing", item.Source);
        Assert.Contains("agent-sdk", item.Tags);
    }

    [Fact]
    public void Router_IsConfigured_WhenOnlyPairedCdsInstanceExistsAndLocalExecutorDisabled()
    {
        var options = new ClaudeSidecarOptions { Enabled = false };
        var registry = new FakeDynamicRegistry(new[]
        {
            new DynamicSidecarInstance
            {
                Name = "cds-pairing:conn-1:host-a",
                BaseUrl = "http://10.0.0.8:7400",
                Token = "shared-sidecar-token",
                Source = "cds-pairing",
            },
        });
        var router = new ClaudeSidecarRouter(
            new FakeHttpClientFactory(_ => new HttpResponseMessage(HttpStatusCode.OK)),
            new StaticOptionsMonitor<ClaudeSidecarOptions>(options),
            new InstanceStateRegistry(),
            registry,
            NullLogger<ClaudeSidecarRouter>.Instance);

        Assert.True(router.IsConfigured);
        Assert.Equal(1, router.InstanceCount);
    }

    private sealed class FakeInfraConnectionService : IInfraConnectionService
    {
        private readonly List<InfraConnectionPublicView> _items;
        private readonly string _token;

        public FakeInfraConnectionService(InfraConnectionPublicView item, string token)
        {
            _items = new List<InfraConnectionPublicView> { item };
            _token = token;
        }

        public Task<InfraConnectionPublicView> PasteAsync(string clipboardText, string userId, CancellationToken ct) =>
            throw new NotImplementedException();

        public Task<CdsAuthorizationStartView> StartCdsAuthorizationAsync(string cdsBaseUrl, string mapBaseUrl, string userId, CancellationToken ct) =>
            throw new NotImplementedException();

        public Task<InfraConnectionPublicView> CompleteCdsAuthorizationAsync(string code, string state, string userId, CancellationToken ct) =>
            throw new NotImplementedException();

        public Task<List<InfraConnectionPublicView>> ListAsync(CancellationToken ct) =>
            Task.FromResult(_items);

        public Task<InfraConnectionPublicView?> GetAsync(string id, CancellationToken ct) =>
            Task.FromResult(_items.FirstOrDefault(x => x.Id == id));

        public Task<PrdAgent.Core.Models.InfraConnection?> GetRawAsync(string id, CancellationToken ct) =>
            Task.FromResult<PrdAgent.Core.Models.InfraConnection?>(null);

        public Task<string?> TryUnprotectLongTokenAsync(string id, CancellationToken ct, bool revokeOnFailure = true) =>
            Task.FromResult<string?>(_items.Any(x => x.Id == id) ? _token : null);

        public Task<bool> DeleteAsync(string id, CancellationToken ct) =>
            Task.FromResult(false);

        public Task<InfraConnectionPublicView?> ProbeAsync(string id, CancellationToken ct) =>
            Task.FromResult(_items.FirstOrDefault(x => x.Id == id));
    }

    private sealed class FakeDynamicRegistry : IDynamicSidecarRegistry
    {
        private readonly IReadOnlyList<DynamicSidecarInstance> _items;

        public FakeDynamicRegistry(IReadOnlyList<DynamicSidecarInstance> items)
        {
            _items = items;
        }

        public IReadOnlyList<DynamicSidecarInstance> GetCurrent() => _items;
        public Task RefreshAsync(CancellationToken ct) => Task.CompletedTask;
        public DateTime? LastRefreshedAt => DateTime.UtcNow;
        public string? LastRefreshError => null;
    }

    private sealed class FakeHttpClientFactory : IHttpClientFactory
    {
        private readonly Func<HttpRequestMessage, HttpResponseMessage> _handler;

        public FakeHttpClientFactory(Func<HttpRequestMessage, HttpResponseMessage> handler)
        {
            _handler = handler;
        }

        public HttpClient CreateClient(string name) =>
            new(new DelegatingHandlerStub(_handler));
    }

    private sealed class DelegatingHandlerStub : HttpMessageHandler
    {
        private readonly Func<HttpRequestMessage, HttpResponseMessage> _handler;

        public DelegatingHandlerStub(Func<HttpRequestMessage, HttpResponseMessage> handler)
        {
            _handler = handler;
        }

        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken) =>
            Task.FromResult(_handler(request));
    }

    private sealed class StaticOptionsMonitor<T> : IOptionsMonitor<T>
    {
        public StaticOptionsMonitor(T currentValue)
        {
            CurrentValue = currentValue;
        }

        public T CurrentValue { get; }
        public T Get(string? name) => CurrentValue;
        public IDisposable? OnChange(Action<T, string?> listener) => null;
    }
}
