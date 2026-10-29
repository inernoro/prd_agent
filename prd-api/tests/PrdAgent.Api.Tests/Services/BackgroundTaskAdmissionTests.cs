using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using MongoDB.Bson;
using PrdAgent.Api.Services;
using PrdAgent.Api.Services.BackgroundTasks;
using PrdAgent.Infrastructure.Security;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public class BackgroundTaskAdmissionTests
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task UnregisteredService_ExecuteIsBlocked_ForTypeAndFactoryRegistration(bool factory)
    {
        var probe = new Probe();
        using var host = new HostBuilder().ConfigureServices(services =>
        {
            services.AddSingleton<IConfiguration>(Configuration());
            services.AddSingleton(probe);
            if (factory) services.AddHostedService(sp => new UnknownWorker(sp.GetRequiredService<Probe>()));
            else services.AddHostedService<UnknownWorker>();
            services.EnforceBackgroundTaskAdmission();
        }).Build();
        await host.StartAsync();
        probe.UnknownCalls.ShouldBe(0);
        var state = host.Services.GetRequiredService<BackgroundTaskAdmissionRegistry>().Snapshot().Single();
        state.Kind.ShouldBe(BackgroundTaskKind.Unregistered);
        state.Allowed.ShouldBeFalse();
        state.Reason.ShouldContain("未登记");
        await host.StopAsync();
    }

    [Theory]
    [InlineData(false, false)]
    [InlineData(true, false)]
    [InlineData(true, true)]
    public async Task UserRunConsumerStillExecutes_WhenAutomaticServiceIsDenied(bool grant, bool preview)
    {
        var config = Configuration(grant, preview);
        var probe = new Probe();
        using var host = TestHost(config, probe);
        await host.StartAsync();
        await probe.UserStarted.Task.WaitAsync(TimeSpan.FromSeconds(2));
        probe.UserCalls.ShouldBe(1);
        probe.UserSource.ShouldBeNull();
        probe.AutomaticCalls.ShouldBe(grant && !preview ? 1 : 0);
        var state = host.Services.GetRequiredService<BackgroundTaskAdmissionRegistry>().Snapshot()
            .Single(x => x.Service.EndsWith(nameof(AutomaticWorker), StringComparison.Ordinal));
        state.Allowed.ShouldBe(grant && !preview);
        await host.StopAsync();
        probe.UserStopped.ShouldBeTrue();
    }

    [Fact]
    public async Task AuthorizedAutomaticOrigin_FlowsIntoWorkerAndDoesNotLeakToOtherWork()
    {
        var probe = new Probe();
        using var host = TestHost(Configuration(grant: true), probe);
        await host.StartAsync();
        await probe.AutomaticStarted.Task.WaitAsync(TimeSpan.FromSeconds(2));
        await probe.UserStarted.Task.WaitAsync(TimeSpan.FromSeconds(2));
        probe.AutomaticSource!.ShouldContain(nameof(AutomaticWorker));
        probe.UserSource.ShouldBeNull();
        AutomaticTaskExecutionContext.SourceDeployment.ShouldBeNull();
        await host.StopAsync();
    }

    [Fact]
    public async Task GuardPreservesHostedServiceStartupAwaiting()
    {
        var probe = new Probe();
        var config = Configuration();
        using var host = new HostBuilder().ConfigureServices(services =>
        {
            services.AddSingleton<IConfiguration>(config);
            services.AddSingleton(probe);
            services.AddHostedService<AwaitedStartupWorker>();
            services.EnforceBackgroundTaskAdmission();
            services.AddSingleton(new BackgroundTaskAdmissionRegistry(config, new Dictionary<Type, BackgroundTaskKind>
            {
                [typeof(AwaitedStartupWorker)] = BackgroundTaskKind.Maintenance,
            }));
        }).Build();
        await host.StartAsync();
        probe.UserCalls.ShouldBe(1);
        await host.StopAsync();
    }

    [Fact]
    public void ExistingBusinessPolicies_CoverAutomaticServicesBeyondWeeklyReports()
    {
        var registry = new BackgroundTaskAdmissionRegistry(Configuration());
        foreach (var type in new[]
                 {
                     typeof(WorkflowScheduleWorker), typeof(EmailChannelWorker), typeof(TutorialEmailWorker),
                     typeof(DocumentSyncWorker), typeof(PrdAgent.Api.Services.PeerSync.PeerSyncScheduleWorker),
                     typeof(PrdAgent.Api.Services.ReportAgent.ReportAutoGenerateWorker),
                     typeof(PrdAgent.Api.Services.ProductAgent.ProductInitiationAutoIssueWorker),
                     typeof(PrdAgent.Api.Services.ProductAgent.ProductClaimWebhookWorker),
                     typeof(PrdAgent.Api.Services.ProductAgent.ProductAnnouncementSyncWorker),
                 })
        {
            var state = registry.Check(type);
            state.Kind.ShouldBe(BackgroundTaskKind.SharedAutomatic);
            state.Allowed.ShouldBeFalse();
            new BackgroundTaskAdmissionRegistry(Configuration(grant: true)).Check(type).Allowed.ShouldBeTrue();
            new BackgroundTaskAdmissionRegistry(Configuration(grant: true, preview: true)).Check(type).Allowed.ShouldBeFalse();
        }
        registry.Check(typeof(ChatRunWorker)).Allowed.ShouldBeTrue();
        registry.Check(typeof(WorkflowRunWorker)).Allowed.ShouldBeTrue();
        registry.Check(typeof(TranscriptRunWorker)).Allowed.ShouldBeTrue();
    }

    [Fact]
    public void ConsumptionNotification_HasStableDedupKeyAndExplainsPreUpstreamBlock()
    {
        var alert = new BsonDocument
        {
            ["_id"] = "window-key", ["Kind"] = "blocked", ["AppCallerCode"] = "workflow.generate::chat",
            ["Origin"] = "automatic", ["Count"] = 21L, ["Limit"] = 20, ["WindowSeconds"] = 60,
            ["RequestId"] = "request-1", ["SourceDeployment"] = "deployment-1",
            ["Prompt"] = "secret prompt should never be copied",
        };
        var first = LlmGatewayIncidentWatchdog.BuildConsumptionNotification(alert)!;
        var second = LlmGatewayIncidentWatchdog.BuildConsumptionNotification(alert)!;
        first.Id.ShouldBe(second.Id);
        first.Key.ShouldBe(second.Key);
        var message = first.Message!;
        message.ShouldContain("发送上游之前拒绝");
        message.ShouldContain("自动任务");
        message.ShouldNotContain("secret prompt");
        first.ActionUrl!.ShouldContain("request-1");
    }

    private static IConfiguration Configuration(bool grant = false, bool preview = false)
        => new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            [DeploymentAuthority.DeploymentIdentityKey] = "prd-agent:test",
            [DeploymentAuthority.SharedScheduledWorkEnabledKey] = grant.ToString(),
            ["CDS_PROJECT_ID"] = preview ? "test-preview" : null,
        }).Build();

    private static IHost TestHost(IConfiguration config, Probe probe)
        => new HostBuilder().ConfigureServices(services =>
        {
            services.AddSingleton<IConfiguration>(config);
            services.AddSingleton(probe);
            services.AddHostedService<AutomaticWorker>();
            services.AddHostedService<UserWorker>();
            services.EnforceBackgroundTaskAdmission();
            services.AddSingleton(new BackgroundTaskAdmissionRegistry(config, new Dictionary<Type, BackgroundTaskKind>
            {
                [typeof(AutomaticWorker)] = BackgroundTaskKind.SharedAutomatic,
                [typeof(UserWorker)] = BackgroundTaskKind.UserRunConsumer,
            }));
        }).Build();

    public sealed class Probe
    {
        public int UnknownCalls;
        public int AutomaticCalls;
        public int UserCalls;
        public string? AutomaticSource;
        public string? UserSource;
        public bool UserStopped;
        public TaskCompletionSource AutomaticStarted { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public TaskCompletionSource UserStarted { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
    }

    public sealed class UnknownWorker(Probe probe) : BackgroundService
    {
        protected override Task ExecuteAsync(CancellationToken stoppingToken)
        {
            Interlocked.Increment(ref probe.UnknownCalls);
            return Task.CompletedTask;
        }
    }

    public sealed class AwaitedStartupWorker(Probe probe) : IHostedService
    {
        public async Task StartAsync(CancellationToken cancellationToken)
        {
            await Task.Delay(20, cancellationToken);
            probe.UserCalls++;
        }
        public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;
    }

    public sealed class AutomaticWorker(Probe probe) : BackgroundService
    {
        protected override async Task ExecuteAsync(CancellationToken stoppingToken)
        {
            Interlocked.Increment(ref probe.AutomaticCalls);
            probe.AutomaticSource = AutomaticTaskExecutionContext.SourceDeployment;
            probe.AutomaticStarted.TrySetResult();
            await Task.Delay(Timeout.Infinite, stoppingToken);
        }
    }

    public sealed class UserWorker(Probe probe) : BackgroundService
    {
        protected override async Task ExecuteAsync(CancellationToken stoppingToken)
        {
            Interlocked.Increment(ref probe.UserCalls);
            probe.UserSource = AutomaticTaskExecutionContext.SourceDeployment;
            probe.UserStarted.TrySetResult();
            await Task.Delay(Timeout.Infinite, stoppingToken);
        }

        public override async Task StopAsync(CancellationToken cancellationToken)
        {
            probe.UserStopped = true;
            await base.StopAsync(cancellationToken);
        }
    }
}
