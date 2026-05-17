using System.Net;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Configuration;
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
    public async Task RefreshAsync_RecordsPairedEndpointFailureDetails()
    {
        var options = new ClaudeSidecarOptions
        {
            Enabled = false,
            CdsDiscovery = new CdsDiscoveryConfig
            {
                Enabled = false,
                EnablePairedInfraConnections = true,
                SharedSidecarToken = "shared-sidecar-token",
            },
        };
        var infra = new FakeInfraConnectionService(
            new InfraConnectionPublicView(
                Id: "conn-failure-1",
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
        var httpFactory = new FakeHttpClientFactory(_ => new HttpResponseMessage(HttpStatusCode.Forbidden)
        {
            Content = new StringContent("""
            {"error":{"code":"project_mismatch","message":"connection token cannot access this project"}}
            """),
        });

        var registry = new DynamicSidecarRegistry(
            new StaticOptionsMonitor<ClaudeSidecarOptions>(options),
            httpFactory,
            services.GetRequiredService<IServiceScopeFactory>(),
            NullLogger<DynamicSidecarRegistry>.Instance);

        await registry.RefreshAsync(CancellationToken.None);

        Assert.Empty(registry.GetCurrent());
        var error = registry.LastRefreshError ?? string.Empty;
        Assert.Contains("endpointFailures=1", error);
        Assert.Contains("paired-endpoint-failures conn-fai proj-1 HTTP 403", error);
        Assert.Contains("project_mismatch", error);
    }

    [Fact]
    public async Task RefreshAsync_RecordsPairedEmptyEndpointDetails()
    {
        var options = new ClaudeSidecarOptions
        {
            Enabled = false,
            CdsDiscovery = new CdsDiscoveryConfig
            {
                Enabled = false,
                EnablePairedInfraConnections = true,
                SharedSidecarToken = "shared-sidecar-token",
            },
        };
        var infra = new FakeInfraConnectionService(
            new InfraConnectionPublicView(
                Id: "conn-empty-1",
                Partner: "cds",
                PartnerName: "CDS",
                PartnerId: "cds-1",
                PartnerBaseUrl: "https://cds.example.test",
                ProjectId: "shared-sidecar-pool",
                InstanceDiscoveryUrl: "/api/projects/shared-sidecar-pool/instances",
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
        var httpFactory = new FakeHttpClientFactory(_ => new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent("""
            {"projectId":"shared-sidecar-pool","instances":[]}
            """),
        });

        var registry = new DynamicSidecarRegistry(
            new StaticOptionsMonitor<ClaudeSidecarOptions>(options),
            httpFactory,
            services.GetRequiredService<IServiceScopeFactory>(),
            NullLogger<DynamicSidecarRegistry>.Instance);

        await registry.RefreshAsync(CancellationToken.None);

        Assert.Empty(registry.GetCurrent());
        var error = registry.LastRefreshError ?? string.Empty;
        Assert.Contains("emptyEndpoints=1", error);
        Assert.Contains("paired-empty-endpoints conn-emp shared-sidecar-pool empty_instances", error);
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
            new ConfigurationBuilder().Build(),
            new HttpContextAccessor(),
            NullLogger<ClaudeSidecarRouter>.Instance);

        Assert.True(router.IsConfigured);
        Assert.Equal(1, router.InstanceCount);
    }

    [Fact]
    public async Task Router_Diagnostics_ShouldExplainMissingRuntimePool()
    {
        var options = new ClaudeSidecarOptions { Enabled = false };
        var registry = new FakeDynamicRegistry(
            Array.Empty<DynamicSidecarInstance>(),
            "paired-connections total=1 activeCds=1 usable=1 endpointsWithInstances=0");
        var router = new ClaudeSidecarRouter(
            new FakeHttpClientFactory(_ => new HttpResponseMessage(HttpStatusCode.OK)),
            new StaticOptionsMonitor<ClaudeSidecarOptions>(options),
            new InstanceStateRegistry(),
            registry,
            new ConfigurationBuilder().Build(),
            new HttpContextAccessor(),
            NullLogger<ClaudeSidecarRouter>.Instance);

        var diagnostics = await router.GetDiagnosticsAsync(CancellationToken.None);

        Assert.False(diagnostics.IsConfigured);
        Assert.Equal(0, diagnostics.InstanceCount);
        Assert.Contains("MAP 当前没有发现任何 CDS sidecar runtime 实例", diagnostics.Blockers ?? Array.Empty<string>());
        Assert.Contains("paired-connections total=1 activeCds=1 usable=1 endpointsWithInstances=0", diagnostics.Blockers ?? Array.Empty<string>());
        Assert.Contains(
            "确认共享 CDS 控制面的 /api/projects/{id}/instances 已包含 branch-service sidecar 实例发现修复",
            diagnostics.NextActions ?? Array.Empty<string>());
        Assert.Contains(
            "在 MAP 基础设施设置中重新完成 CDS 长期授权，清理旧 DataProtection key 失效的连接",
            diagnostics.NextActions ?? Array.Empty<string>());
    }

    [Fact]
    public async Task Router_Diagnostics_ShouldExposeOfficialSdkReadinessBlockers()
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
            new FakeHttpClientFactory(_ => new HttpResponseMessage(HttpStatusCode.ServiceUnavailable)
            {
                Content = new StringContent("""
                {
                  "ready": false,
                  "anthropicKey": false,
                  "sidecarToken": true,
                  "agentAdapter": "claude-agent-sdk",
                  "adapterDiagnostics": {
                    "adapter": "claude-agent-sdk",
                    "ready": false,
                    "missing": ["claude_cli", "workspace_root"]
                  }
                }
                """)
            }),
            new StaticOptionsMonitor<ClaudeSidecarOptions>(options),
            new InstanceStateRegistry(),
            registry,
            new ConfigurationBuilder().Build(),
            new HttpContextAccessor(),
            NullLogger<ClaudeSidecarRouter>.Instance);

        var diagnostics = await router.GetDiagnosticsAsync(CancellationToken.None);

        Assert.True(diagnostics.IsConfigured);
        Assert.Equal(1, diagnostics.InstanceCount);
        Assert.Equal(0, diagnostics.HealthyCount);
        Assert.False(diagnostics.Instances[0].AnthropicKeyConfigured);
        Assert.True(diagnostics.Instances[0].SidecarTokenConfigured);
        Assert.Contains("所有已发现的 sidecar runtime 实例当前都不可用", diagnostics.Blockers ?? Array.Empty<string>());
        Assert.Contains("cds-pairing:conn-1:host-a: /readyz 返回 HTTP 503", diagnostics.Blockers ?? Array.Empty<string>());
        Assert.Contains("cds-pairing:conn-1:host-a: /readyz ready=false", diagnostics.Blockers ?? Array.Empty<string>());
        Assert.Contains("cds-pairing:conn-1:host-a: 缺少 ANTHROPIC_API_KEY", diagnostics.Blockers ?? Array.Empty<string>());
        Assert.Contains("cds-pairing:conn-1:host-a: 缺少 claude_cli", diagnostics.Blockers ?? Array.Empty<string>());
        Assert.Contains("cds-pairing:conn-1:host-a: 缺少 workspace_root", diagnostics.Blockers ?? Array.Empty<string>());
        Assert.Contains(
            "进入 sidecar 容器检查 /readyz，优先修复 ANTHROPIC_API_KEY、SIDECAR_TOKEN、claude CLI 和 claude-agent-sdk",
            diagnostics.NextActions ?? Array.Empty<string>());
        Assert.Contains(
            "官方 SDK 模式下保持 MAP/CDS 只做控制面，工具执行和 turn loop 继续走 claude-agent-sdk",
            diagnostics.NextActions ?? Array.Empty<string>());
    }

    [Fact]
    public async Task Router_UsesPublicCallbackBaseUrl_ForPairedCdsInstance()
    {
        var options = new ClaudeSidecarOptions
        {
            Enabled = false,
            CallbackBaseUrl = "http://api:8080",
        };
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
        string? body = null;
        var httpFactory = new FakeHttpClientFactory(req =>
        {
            body = req.Content!.ReadAsStringAsync().GetAwaiter().GetResult();
            return new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent("event: done\ndata: {\"final_text\":\"ok\"}\n\n", Encoding.UTF8, "text/event-stream")
            };
        });
        var configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["App:FrontendBaseUrl"] = "https://main-prd-agent.miduo.org/",
            })
            .Build();
        var router = new ClaudeSidecarRouter(
            httpFactory,
            new StaticOptionsMonitor<ClaudeSidecarOptions>(options),
            new InstanceStateRegistry(),
            registry,
            configuration,
            new HttpContextAccessor(),
            NullLogger<ClaudeSidecarRouter>.Instance);

        await foreach (var _ in router.RunStreamAsync(new SidecarRunRequest { RunId = "run-1" }, CancellationToken.None))
        {
        }

        Assert.NotNull(body);
        using var doc = JsonDocument.Parse(body!);
        Assert.Equal("https://main-prd-agent.miduo.org", doc.RootElement.GetProperty("callbackBaseUrl").GetString());
    }

    [Fact]
    public async Task Router_DerivesPreviewCallbackBaseUrl_WhenBackgroundWorkerHasNoHttpContext()
    {
        var options = new ClaudeSidecarOptions
        {
            Enabled = false,
            CallbackBaseUrl = "http://api:8080",
        };
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
        string? body = null;
        var httpFactory = new FakeHttpClientFactory(req =>
        {
            body = req.Content!.ReadAsStringAsync().GetAwaiter().GetResult();
            return new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent("event: done\ndata: {\"final_text\":\"ok\"}\n\n", Encoding.UTF8, "text/event-stream")
            };
        });
        var configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["VITE_GIT_BRANCH"] = "main",
                ["AGENT_WORKSPACE_GITHUB_REPOSITORY"] = "inernoro/prd_agent",
                ["CDS_PREVIEW_DOMAIN"] = "miduo.org",
            })
            .Build();
        var router = new ClaudeSidecarRouter(
            httpFactory,
            new StaticOptionsMonitor<ClaudeSidecarOptions>(options),
            new InstanceStateRegistry(),
            registry,
            configuration,
            new HttpContextAccessor(),
            NullLogger<ClaudeSidecarRouter>.Instance);

        await foreach (var _ in router.RunStreamAsync(new SidecarRunRequest { RunId = "run-1" }, CancellationToken.None))
        {
        }

        Assert.NotNull(body);
        using var doc = JsonDocument.Parse(body!);
        Assert.Equal("https://main-prd-agent.miduo.org", doc.RootElement.GetProperty("callbackBaseUrl").GetString());
    }

    [Fact]
    public async Task Router_DerivesPreviewCallbackBaseUrl_ForPrefixedBranch()
    {
        var options = new ClaudeSidecarOptions
        {
            Enabled = false,
            CallbackBaseUrl = "http://api:8080",
        };
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
        string? body = null;
        var httpFactory = new FakeHttpClientFactory(req =>
        {
            body = req.Content!.ReadAsStringAsync().GetAwaiter().GetResult();
            return new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent("event: done\ndata: {\"final_text\":\"ok\"}\n\n", Encoding.UTF8, "text/event-stream")
            };
        });
        var configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["VITE_GIT_BRANCH"] = "feat/auth/login",
                ["AGENT_WORKSPACE_GITHUB_REPOSITORY"] = "inernoro/prd_agent",
                ["CDS_PREVIEW_DOMAIN"] = "miduo.org",
            })
            .Build();
        var router = new ClaudeSidecarRouter(
            httpFactory,
            new StaticOptionsMonitor<ClaudeSidecarOptions>(options),
            new InstanceStateRegistry(),
            registry,
            configuration,
            new HttpContextAccessor(),
            NullLogger<ClaudeSidecarRouter>.Instance);

        await foreach (var _ in router.RunStreamAsync(new SidecarRunRequest { RunId = "run-1" }, CancellationToken.None))
        {
        }

        Assert.NotNull(body);
        using var doc = JsonDocument.Parse(body!);
        Assert.Equal("https://auth-login-feat-prd-agent.miduo.org", doc.RootElement.GetProperty("callbackBaseUrl").GetString());
    }

    [Fact]
    public async Task Router_DerivesPreviewCallbackBaseUrl_FromWorkspaceFallback()
    {
        var options = new ClaudeSidecarOptions
        {
            Enabled = false,
            CallbackBaseUrl = "http://api-prd-agent:5000",
        };
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
        string? body = null;
        var httpFactory = new FakeHttpClientFactory(req =>
        {
            body = req.Content!.ReadAsStringAsync().GetAwaiter().GetResult();
            return new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent("event: done\ndata: {\"final_text\":\"ok\"}\n\n", Encoding.UTF8, "text/event-stream")
            };
        });
        var configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["VITE_GIT_BRANCH"] = "main",
                ["CDS_PREVIEW_DOMAIN"] = "miduo.org",
            })
            .Build();
        var router = new ClaudeSidecarRouter(
            httpFactory,
            new StaticOptionsMonitor<ClaudeSidecarOptions>(options),
            new InstanceStateRegistry(),
            registry,
            configuration,
            new HttpContextAccessor(),
            NullLogger<ClaudeSidecarRouter>.Instance);

        await foreach (var _ in router.RunStreamAsync(new SidecarRunRequest { RunId = "run-1" }, CancellationToken.None))
        {
        }

        Assert.NotNull(body);
        using var doc = JsonDocument.Parse(body!);
        Assert.Equal("https://main-prd-agent.miduo.org", doc.RootElement.GetProperty("callbackBaseUrl").GetString());
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
        private readonly string? _lastRefreshError;

        public FakeDynamicRegistry(IReadOnlyList<DynamicSidecarInstance> items, string? lastRefreshError = null)
        {
            _items = items;
            _lastRefreshError = lastRefreshError;
        }

        public IReadOnlyList<DynamicSidecarInstance> GetCurrent() => _items;
        public Task RefreshAsync(CancellationToken ct) => Task.CompletedTask;
        public DateTime? LastRefreshedAt => DateTime.UtcNow;
        public string? LastRefreshError => _lastRefreshError;
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
