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
                      "profileId": "api-prd-agent",
                      "branchId": "shared-main",
                      "branch": "main",
                      "serviceKind": "branch-service",
                      "projectKind": "shared-service",
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
        Assert.Contains("profile:api-prd-agent", item.Tags);
        Assert.Contains("branch:main", item.Tags);
        Assert.Contains("branchId:shared-main", item.Tags);
        Assert.Contains("serviceKind:branch-service", item.Tags);
        Assert.Contains("projectKind:shared-service", item.Tags);
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
        var httpFactory = new FakeHttpClientFactory(_ => new HttpResponseMessage(HttpStatusCode.Unauthorized)
        {
            Content = new StringContent("""
            {"error":{"code":"invalid_long_token","message":"invalid connection token"}}
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
        Assert.Contains("paired-endpoint-failures conn-fai proj-1 HTTP 401", error);
        Assert.Contains("invalid_long_token", error);
        Assert.Equal(new[] { "conn-failure-1" }, infra.ProbedIds);
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
            {
              "projectId":"shared-sidecar-pool",
              "instances":[],
              "discovery": {
                "projectKind": "shared-service",
                "deploymentCount": 0,
                "runningDeploymentCount": 0,
                "disabledHostDeploymentCount": 0,
                "branchCount": 1,
                "runningBranchCount": 1,
                "runningBranchServiceCount": 0,
                "runtimeBranchServiceCount": 0,
                "skippedBranchServiceCount": 0,
                "previewRootConfigured": true
              }
            }
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
        Assert.Contains("discovery(projectKind=shared-service", error);
        Assert.Contains("runningBranchServices=0", error);
        Assert.Contains("runtimeBranchServices=0", error);
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
        Assert.Contains("MAP 当前没有发现任何可路由 sidecar runtime 实例", diagnostics.Blockers ?? Array.Empty<string>());
        Assert.Contains("未发现静态 ClaudeSdkExecutor:Sidecars，也未发现可用的 CDS paired sidecar 实例", diagnostics.Blockers ?? Array.Empty<string>());
        Assert.Contains("paired-connections total=1 activeCds=1 usable=1 endpointsWithInstances=0", diagnostics.Blockers ?? Array.Empty<string>());
        Assert.Contains(
            "确认共享 CDS 控制面的 /api/projects/{id}/instances 已包含 branch-service sidecar 实例发现修复",
            diagnostics.NextActions ?? Array.Empty<string>());
        Assert.Contains(
            "如需绕过共享 CDS discovery，显式配置 ClaudeSdkExecutor:Enabled=true 与 ClaudeSdkExecutor:Sidecars[0].BaseUrl/Token 指向一个健康的 claude-agent-sdk sidecar",
            diagnostics.NextActions ?? Array.Empty<string>());
        Assert.Contains(
            "本地/临时验证可设置 CLAUDE_SIDECAR_BASE_URL 与 CLAUDE_SIDECAR_TOKEN，并确保 ClaudeSdkExecutor:Enabled=true",
            diagnostics.NextActions ?? Array.Empty<string>());
        Assert.DoesNotContain(
            "在 MAP 基础设施设置中重新完成 CDS 长期授权，清理旧 DataProtection key 或 invalid_long_token 失效连接",
            diagnostics.NextActions ?? Array.Empty<string>());
    }

    [Fact]
    public async Task Router_Diagnostics_ShouldPreferCdsControlPlaneAction_WhenPairedEndpointIsEmpty()
    {
        var options = new ClaudeSidecarOptions { Enabled = false };
        var registry = new FakeDynamicRegistry(
            Array.Empty<DynamicSidecarInstance>(),
            "paired-connections total=12 activeCds=1 usable=1 tokenFailures=0 endpointFailures=0 emptyEndpoints=1 endpointsWithInstances=0; paired-empty-endpoints conn-1 shared-sidecar-pool empty_instances");
        var router = new ClaudeSidecarRouter(
            new FakeHttpClientFactory(_ => new HttpResponseMessage(HttpStatusCode.OK)),
            new StaticOptionsMonitor<ClaudeSidecarOptions>(options),
            new InstanceStateRegistry(),
            registry,
            new ConfigurationBuilder().Build(),
            new HttpContextAccessor(),
            NullLogger<ClaudeSidecarRouter>.Instance);

        var diagnostics = await router.GetDiagnosticsAsync(CancellationToken.None);

        Assert.Contains(
            "当前 CDS 授权可用但实例列表为空：优先更新共享 CDS 控制面的 /api/projects/{id}/instances，使其暴露 running 的 branch-service sidecar 实例",
            diagnostics.NextActions ?? Array.Empty<string>());
        Assert.Contains(
            "当前 CDS 控制面未返回 instances discovery 摘要，说明共享 CDS 本体仍是旧版本或尚未完成发布",
            diagnostics.NextActions ?? Array.Empty<string>());
        Assert.DoesNotContain(
            "在 MAP 基础设施设置中重新完成 CDS 长期授权，清理旧 DataProtection key 或 invalid_long_token 失效连接",
            diagnostics.NextActions ?? Array.Empty<string>());
    }

    [Fact]
    public async Task Router_Diagnostics_ShouldNotAskForControlPlaneUpgrade_WhenDiscoverySummaryExists()
    {
        var options = new ClaudeSidecarOptions { Enabled = false };
        var registry = new FakeDynamicRegistry(
            Array.Empty<DynamicSidecarInstance>(),
            "paired-connections total=12 activeCds=1 usable=1 tokenFailures=0 endpointFailures=0 emptyEndpoints=1 endpointsWithInstances=0; paired-empty-endpoints conn-1 shared-sidecar-pool empty_instances discovery(projectKind=shared-service deployments=0 runningDeployments=0 disabledHostDeployments=0 branches=1 runningBranches=1 runningBranchServices=1 runtimeBranchServices=0 skippedBranchServices=1 previewRootConfigured=True)");
        var router = new ClaudeSidecarRouter(
            new FakeHttpClientFactory(_ => new HttpResponseMessage(HttpStatusCode.OK)),
            new StaticOptionsMonitor<ClaudeSidecarOptions>(options),
            new InstanceStateRegistry(),
            registry,
            new ConfigurationBuilder().Build(),
            new HttpContextAccessor(),
            NullLogger<ClaudeSidecarRouter>.Instance);

        var diagnostics = await router.GetDiagnosticsAsync(CancellationToken.None);

        Assert.DoesNotContain(
            "当前 CDS 控制面未返回 instances discovery 摘要，说明共享 CDS 本体仍是旧版本或尚未完成发布",
            diagnostics.NextActions ?? Array.Empty<string>());
        Assert.Contains(
            "CDS 发现到 running 分支服务但全部被 runtime 过滤跳过：确认 sidecar runtime profile/service 名称包含 api、sidecar、runtime、worker 或 agent，且不要命名为 admin/web/ui",
            diagnostics.NextActions ?? Array.Empty<string>());
        Assert.DoesNotContain(
            "确认 shared sidecar pool 分支服务正在运行；当前 discovery 未看到 running branch service",
            diagnostics.NextActions ?? Array.Empty<string>());
        Assert.NotNull(diagnostics.DiscoveryMetrics);
        Assert.Equal(12, diagnostics.DiscoveryMetrics!.TotalConnections);
        Assert.Equal(1, diagnostics.DiscoveryMetrics.ActiveCdsConnections);
        Assert.Equal(1, diagnostics.DiscoveryMetrics.UsableConnections);
        Assert.Equal(1, diagnostics.DiscoveryMetrics.EmptyEndpoints);
        Assert.Equal(0, diagnostics.DiscoveryMetrics.EndpointsWithInstances);
        Assert.Equal("shared-service", diagnostics.DiscoveryMetrics.ProjectKind);
        Assert.Equal(1, diagnostics.DiscoveryMetrics.RunningBranchServiceCount);
        Assert.Equal(0, diagnostics.DiscoveryMetrics.RuntimeBranchServiceCount);
        Assert.Equal(1, diagnostics.DiscoveryMetrics.SkippedBranchServiceCount);
        Assert.True(diagnostics.DiscoveryMetrics.PreviewRootConfigured);
    }

    [Fact]
    public async Task Router_Diagnostics_ShouldAskForReauthorization_WhenPairedTokenIsInvalid()
    {
        var options = new ClaudeSidecarOptions { Enabled = false };
        var registry = new FakeDynamicRegistry(
            Array.Empty<DynamicSidecarInstance>(),
            "paired-connections total=12 activeCds=5 usable=5 tokenFailures=0 endpointFailures=4 emptyEndpoints=1 endpointsWithInstances=0; paired-endpoint-failures conn-1 shared-sidecar-pool HTTP 401 {\"error\":{\"code\":\"invalid_long_token\"}}");
        var router = new ClaudeSidecarRouter(
            new FakeHttpClientFactory(_ => new HttpResponseMessage(HttpStatusCode.OK)),
            new StaticOptionsMonitor<ClaudeSidecarOptions>(options),
            new InstanceStateRegistry(),
            registry,
            new ConfigurationBuilder().Build(),
            new HttpContextAccessor(),
            NullLogger<ClaudeSidecarRouter>.Instance);

        var diagnostics = await router.GetDiagnosticsAsync(CancellationToken.None);

        Assert.Contains(
            "在 MAP 基础设施设置中重新完成 CDS 长期授权，清理旧 DataProtection key 或 invalid_long_token 失效连接",
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
                  "providerKeyRequiredForReady": false,
                  "sidecarToken": true,
                  "agentAdapter": "claude-agent-sdk",
                  "blockers": ["missing claude_agent_sdk", "missing workspace_root"],
                  "nextActions": ["install the official SDK: pip install claude-agent-sdk", "set AGENT_WORKSPACE_ROOT to an existing readable workspace"],
                  "adapterDiagnostics": {
                    "adapter": "claude-agent-sdk",
                    "ready": false,
                    "loopOwner": "claude-agent-sdk",
                    "sdkLoopEnabled": true,
                    "mapRole": "control-plane",
                    "cdsRole": "sandbox-runtime",
                    "missing": ["claude_agent_sdk", "workspace_root"],
                    "claudeCliPath": null,
                    "claudeCliBundled": false,
                    "workspacePreparation": {
                      "autoGitWorkspace": true,
                      "workspacesRoot": "/tmp/cds-agent-workspaces",
                      "workspacesRootExists": true,
                      "gitInstalled": true,
                      "supportedRepositoryHosts": ["github.com"],
                      "supportedRepositoryFormats": ["owner/repo", "https://github.com/owner/repo"],
                      "workspaceLock": "in-process"
                    }
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
        Assert.False(diagnostics.Instances[0].ProviderKeyRequiredForReady);
        Assert.True(diagnostics.Instances[0].SidecarTokenConfigured);
        Assert.Equal("claude-agent-sdk", diagnostics.Instances[0].LoopOwner);
        Assert.True(diagnostics.Instances[0].SdkLoopEnabled);
        Assert.Equal("control-plane", diagnostics.Instances[0].MapRole);
        Assert.Equal("sandbox-runtime", diagnostics.Instances[0].CdsRole);
        Assert.Null(diagnostics.Instances[0].ClaudeCliPath);
        Assert.False(diagnostics.Instances[0].ClaudeCliBundled);
        Assert.NotNull(diagnostics.Instances[0].WorkspacePreparation);
        Assert.True(diagnostics.Instances[0].WorkspacePreparation!.AutoGitWorkspace);
        Assert.Equal("/tmp/cds-agent-workspaces", diagnostics.Instances[0].WorkspacePreparation!.WorkspacesRoot);
        Assert.True(diagnostics.Instances[0].WorkspacePreparation!.WorkspacesRootExists);
        Assert.True(diagnostics.Instances[0].WorkspacePreparation!.GitInstalled);
        Assert.Equal("in-process", diagnostics.Instances[0].WorkspacePreparation!.WorkspaceLock);
        Assert.Contains("github.com", diagnostics.Instances[0].WorkspacePreparation!.SupportedRepositoryHosts ?? Array.Empty<string>());
        Assert.Contains("owner/repo", diagnostics.Instances[0].WorkspacePreparation!.SupportedRepositoryFormats ?? Array.Empty<string>());
        Assert.Contains("missing claude_agent_sdk", diagnostics.Instances[0].ReadyzBlockers ?? Array.Empty<string>());
        Assert.Contains(
            "install the official SDK: pip install claude-agent-sdk",
            diagnostics.Instances[0].ReadyzNextActions ?? Array.Empty<string>());
        Assert.Contains("所有已发现的 sidecar runtime 实例当前都不可用", diagnostics.Blockers ?? Array.Empty<string>());
        Assert.Contains("cds-pairing:conn-1:host-a: /readyz 返回 HTTP 503", diagnostics.Blockers ?? Array.Empty<string>());
        Assert.Contains("cds-pairing:conn-1:host-a: /readyz ready=false", diagnostics.Blockers ?? Array.Empty<string>());
        Assert.Contains("cds-pairing:conn-1:host-a: missing claude_agent_sdk", diagnostics.Blockers ?? Array.Empty<string>());
        Assert.DoesNotContain("cds-pairing:conn-1:host-a: 缺少 ANTHROPIC_API_KEY", diagnostics.Blockers ?? Array.Empty<string>());
        Assert.Contains("cds-pairing:conn-1:host-a: 缺少 claude_agent_sdk", diagnostics.Blockers ?? Array.Empty<string>());
        Assert.Contains("cds-pairing:conn-1:host-a: 缺少 workspace_root", diagnostics.Blockers ?? Array.Empty<string>());
        Assert.Contains(
            "install the official SDK: pip install claude-agent-sdk",
            diagnostics.NextActions ?? Array.Empty<string>());
        Assert.Contains(
            "进入 sidecar 容器检查 /readyz，优先修复 SIDECAR_TOKEN 和 claude-agent-sdk；模型 provider key 可由 MAP runtime profile 按请求下发",
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
        private readonly List<string> _probedIds = new();

        public FakeInfraConnectionService(InfraConnectionPublicView item, string token)
        {
            _items = new List<InfraConnectionPublicView> { item };
            _token = token;
        }

        public IReadOnlyList<string> ProbedIds => _probedIds;

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

        public Task<InfraConnectionPublicView?> ProbeAsync(string id, CancellationToken ct)
        {
            _probedIds.Add(id);
            return Task.FromResult(_items.FirstOrDefault(x => x.Id == id));
        }
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
