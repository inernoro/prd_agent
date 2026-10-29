using System.Collections.Concurrent;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using PrdAgent.Infrastructure.Security;

namespace PrdAgent.Api.Services.BackgroundTasks;

public enum BackgroundTaskKind
{
    Maintenance,
    UserRunConsumer,
    SharedAutomatic,
    ModelLeaderboardMirror,
    Framework,
    Unregistered,
}

public sealed record BackgroundTaskAdmissionState(
    string Service, BackgroundTaskKind Kind, bool Allowed, string Reason, DateTime CheckedAt);

/// <summary>
/// 所有 HostedService 的启动准入清单。未登记默认拒绝，不需要新业务自己记得加开关。
/// 允许用户 Run 的续处理不代表承诺其所有业务步骤已经有任务级授权，后续许可证另行收敛。
/// </summary>
public sealed class BackgroundTaskAdmissionRegistry
{
    private readonly IConfiguration _configuration;
    private readonly IReadOnlyDictionary<Type, BackgroundTaskKind> _policies;
    private readonly ConcurrentDictionary<string, BackgroundTaskAdmissionState> _states = new();

    public BackgroundTaskAdmissionRegistry(IConfiguration configuration)
        : this(configuration, RegisteredPolicies) { }

    internal BackgroundTaskAdmissionRegistry(
        IConfiguration configuration, IReadOnlyDictionary<Type, BackgroundTaskKind> policies)
    {
        _configuration = configuration;
        _policies = policies;
    }

    internal static IReadOnlyDictionary<Type, BackgroundTaskKind> RegisteredPolicies { get; } = BuildPolicies();

    public string SourceDeployment => DeploymentAuthority.DescribeSource(_configuration);
    public bool SharedAutomaticEnabled => DeploymentAuthority.CanRunSharedScheduledWork(_configuration);
    public IReadOnlyList<BackgroundTaskAdmissionState> Snapshot()
        => _states.Values.OrderBy(x => x.Service, StringComparer.Ordinal).ToArray();

    internal BackgroundTaskAdmissionState Check(Type type)
    {
        var kind = _policies.GetValueOrDefault(type, IsFramework(type)
            ? BackgroundTaskKind.Framework : BackgroundTaskKind.Unregistered);
        var allowed = kind switch
        {
            BackgroundTaskKind.SharedAutomatic => SharedAutomaticEnabled,
            // 已批准的只读公开镜像仅保留原有 main 例外，不授予其它自动任务权限。
            BackgroundTaskKind.ModelLeaderboardMirror => DeploymentAuthority.CanRunModelLeaderboardSync(_configuration),
            BackgroundTaskKind.Unregistered => false,
            _ => true,
        };
        var reason = kind switch
        {
            BackgroundTaskKind.Unregistered => "后台服务未登记执行策略，平台拒绝启动；请先登记责任、触发方式与执行范围。",
            BackgroundTaskKind.SharedAutomatic when !allowed => "共享自动任务未获部署授权或当前为分支预览，平台拒绝启动。",
            BackgroundTaskKind.ModelLeaderboardMirror when !allowed => "当前部署不具备公开榜单镜像的既定执行资格。",
            BackgroundTaskKind.UserRunConsumer => "保留用户已提交任务的处理与恢复。",
            BackgroundTaskKind.Maintenance => "已登记的平台维护服务，沿用其归属和幂等约束。",
            BackgroundTaskKind.Framework => "宿主框架基础服务。",
            _ => "已通过平台自动任务部署准入。",
        };
        var state = new BackgroundTaskAdmissionState(type.FullName ?? type.Name, kind, allowed, reason, DateTime.UtcNow);
        _states[state.Service] = state;
        return state;
    }

    internal string AutomaticSource(Type type)
    {
        var source = $"{_configuration[DeploymentAuthority.DeploymentIdentityKey]}/{type.Name}/{SourceDeployment}";
        // HTTP 来源头是诊断标签，长度有界且只保留可打印 ASCII，不参与额度分区。
        return new string(source.Take(200).Select(ch => char.IsAsciiLetterOrDigit(ch)
            || ch is '-' or '_' or '.' or '/' or ':' or '@' ? ch : '_').ToArray());
    }

    internal static bool IsFramework(Type type)
    {
        var assembly = type.Assembly.GetName().Name ?? "";
        return assembly.StartsWith("Microsoft.AspNetCore.", StringComparison.Ordinal)
               || assembly.StartsWith("Microsoft.Extensions.", StringComparison.Ordinal);
    }

    private static IReadOnlyDictionary<Type, BackgroundTaskKind> BuildPolicies()
    {
        var result = new Dictionary<Type, BackgroundTaskKind>();
        Add(BackgroundTaskKind.Maintenance,
            typeof(AdminPushNotificationWorker), typeof(LlmGatewayIncidentWatchdog),
            typeof(PrdAgent.Infrastructure.LLM.ImageGenModelConfigSyncWorker),
            typeof(PrdAgent.Api.Middleware.ApiRequestLogWatchdog),
            typeof(PrdAgent.Api.Middleware.AiScoreWatchdog),
            typeof(PrdAgent.Api.Middleware.TranscriptRunWatchdog),
            typeof(PlatformKeyIntegrityWorker), typeof(MongoIndexAdvisoryStartupCheck),
            typeof(EscalationNotificationCleanupService), typeof(ReprocessAgentSeeder),
            typeof(PermissionMigrationService), typeof(AppCallerRegistrySyncService),
            typeof(PrdAgent.Infrastructure.Services.ClaudeSidecar.ClaudeSidecarHealthChecker),
            typeof(PrdAgent.Infrastructure.Services.ClaudeSidecar.CdsSidecarSyncService));
        Add(BackgroundTaskKind.UserRunConsumer,
            typeof(DataSync.DataSyncRunWorker), typeof(Toolbox.ToolboxRunWorker),
            typeof(ImageGenRunWorker), typeof(ProfileAvatarGenerationCleanupService),
            typeof(DocumentAssetCleanupService), typeof(ChatRunWorker),
            typeof(MdToPpt.HtmlPptDesignArtifactRecoveryWorker), typeof(MdToPpt.HtmlPptPublishRecoveryWorker),
            typeof(HostedSiteEditRunWorker), typeof(WorkflowRunWorker),
            typeof(HostedSiteDeletionCleanupService), typeof(HostedSiteOptimizationCleanupService),
            typeof(VideoGenRunWorker), typeof(VideoToDocRunWorker), typeof(ArenaRunWorker),
            typeof(TranscriptRunWorker), typeof(DocumentStoreAgentWorker),
            typeof(DocumentRecordingArchiveWorker), typeof(ShortVideoMaterialWorker),
            typeof(InfraAgentRuntimeWorker), typeof(InfraAgentSessionCleanupWorker), typeof(ChatAgentTurnWorker));
        Add(BackgroundTaskKind.SharedAutomatic,
            typeof(ProductAgent.ProductInitiationAutoIssueWorker),
            typeof(ProductAgent.ProductClaimWebhookWorker), typeof(ProductAgent.ProductAnnouncementSyncWorker),
            typeof(PeerSync.PeerSyncScheduleWorker), typeof(CdsReportImportWorker),
            typeof(PrdAgent.Infrastructure.Services.Changelog.ChangelogRefreshWorker),
            typeof(PrdAgent.Infrastructure.ModelPool.ModelPoolHealthProbeService),
            typeof(WorkflowScheduleWorker), typeof(HostedSiteBackfillService), typeof(DocumentSyncWorker),
            typeof(PrdAgent.Infrastructure.Services.AiNewsCacheWarmer),
            typeof(EmailChannelWorker), typeof(TutorialEmailWorker),
            typeof(ReportAgent.GitSyncWorker), typeof(ReportAgent.ReportAutoGenerateWorker));
        Add(BackgroundTaskKind.ModelLeaderboardMirror, typeof(ModelLeaderboard.ModelLeaderboardSyncWorker));
        return result;

        void Add(BackgroundTaskKind kind, params Type[] types)
        {
            foreach (var type in types) result.Add(type, kind);
        }
    }
}

public static class BackgroundTaskAdmissionRegistration
{
    /// <summary>在全部业务注册之后、Build 之前运行；类型、实例与工厂注册都经过同一个启动总闸。</summary>
    public static void EnforceBackgroundTaskAdmission(this IServiceCollection services)
    {
        services.AddSingleton<BackgroundTaskAdmissionRegistry>();
        foreach (var descriptor in services.Where(x => x.ServiceType == typeof(IHostedService) && !x.IsKeyedService).ToArray())
        {
            var declaredType = descriptor.ImplementationType ?? descriptor.ImplementationInstance?.GetType();
            if (declaredType is not null && BackgroundTaskAdmissionRegistry.IsFramework(declaredType)) continue;
            var key = new object();
            services.Remove(descriptor);
            services.Add(descriptor.ImplementationType is { } type
                ? ServiceDescriptor.KeyedSingleton(typeof(IHostedService), key, type)
                : descriptor.ImplementationInstance is { } instance
                    ? ServiceDescriptor.KeyedSingleton(typeof(IHostedService), key, instance)
                    : ServiceDescriptor.KeyedSingleton(typeof(IHostedService), key,
                        (sp, _) => descriptor.ImplementationFactory!(sp)));
            services.AddSingleton<IHostedService>(sp => new AdmittedHostedService(
                () => sp.GetRequiredKeyedService<IHostedService>(key), declaredType,
                sp.GetRequiredService<BackgroundTaskAdmissionRegistry>(),
                sp.GetRequiredService<ILogger<AdmittedHostedService>>()));
        }
    }
}

/// <summary>
/// 仍是 BackgroundService，保持 Host 对异常、停机和执行任务的监督。
/// 原实例由 keyed DI 持有，避免工厂/共享单例的生命周期被装饰器接管。
/// </summary>
internal sealed class AdmittedHostedService(
    Func<IHostedService> resolve, Type? declaredType,
    BackgroundTaskAdmissionRegistry registry, ILogger<AdmittedHostedService> logger) : BackgroundService
{
    private IHostedService? _inner;
    private BackgroundTaskAdmissionState? _state;

    public override async Task StartAsync(CancellationToken cancellationToken)
    {
        // 已知类型先判定再构造，拒绝时连其构造函数也不执行。
        var type = declaredType ?? (_inner = resolve()).GetType();
        _state = registry.Check(type);
        if (!_state.Allowed)
        {
            logger.LogWarning("[BackgroundTaskAdmission] 已拒绝 {Service}: {Reason}", _state.Service, _state.Reason);
            return;
        }
        _inner ??= resolve();
        using var origin = _state.Kind is BackgroundTaskKind.SharedAutomatic or BackgroundTaskKind.ModelLeaderboardMirror
            ? AutomaticTaskExecutionContext.Enter(registry.AutomaticSource(_inner.GetType())) : null;
        // Host 必须等原 StartAsync 完成；不能把框架或普通 IHostedService 的启动移进后台。
        await _inner.StartAsync(cancellationToken);
        await base.StartAsync(cancellationToken);
    }

    protected override Task ExecuteAsync(CancellationToken stoppingToken)
        => _inner is BackgroundService background ? background.ExecuteTask ?? Task.CompletedTask : Task.CompletedTask;

    public override async Task StopAsync(CancellationToken cancellationToken)
    {
        if (_state?.Allowed == true) await _inner!.StopAsync(cancellationToken);
        await base.StopAsync(cancellationToken);
    }
}
