using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using PrdAgent.Core.Interfaces;

namespace PrdAgent.Infrastructure.Services.ClaudeSidecar;

/// <summary>
/// 周期性 GET 每个 sidecar 的 /healthz，把成败写入 InstanceStateRegistry。
/// 实例列表通过 IDynamicSidecarRegistry 拿（合并 appsettings 静态 + CDS 发现）。
/// 配置未启用时直接退出。
/// </summary>
public sealed class ClaudeSidecarHealthChecker : BackgroundService
{
    private readonly IHttpClientFactory _httpFactory;
    private readonly IOptionsMonitor<ClaudeSidecarOptions> _options;
    private readonly InstanceStateRegistry _state;
    private readonly IDynamicSidecarRegistry _registry;
    private readonly ILogger<ClaudeSidecarHealthChecker> _logger;

    public ClaudeSidecarHealthChecker(
        IHttpClientFactory httpFactory,
        IOptionsMonitor<ClaudeSidecarOptions> options,
        InstanceStateRegistry state,
        IDynamicSidecarRegistry registry,
        ILogger<ClaudeSidecarHealthChecker> logger)
    {
        _httpFactory = httpFactory;
        _options = options;
        _state = state;
        _registry = registry;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var opts = _options.CurrentValue;
        if (!opts.Enabled)
        {
            _logger.LogInformation("[ClaudeSdk] Sidecar 健康检查已跳过：ClaudeSdkExecutor.Enabled=false");
            return;
        }

        _logger.LogInformation(
            "[ClaudeSdk] Sidecar 健康检查启动，间隔={Interval}s（实例列表来自 IDynamicSidecarRegistry）",
            opts.HealthCheck.IntervalSeconds);

        // 启动后立即首检 + 后续按 interval 走
        while (!stoppingToken.IsCancellationRequested)
        {
            try { await ProbeAllAsync(stoppingToken); }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "[ClaudeSdk] 健康检查循环异常");
            }

            try
            {
                var interval = Math.Max(2, _options.CurrentValue.HealthCheck.IntervalSeconds);
                await Task.Delay(TimeSpan.FromSeconds(interval), stoppingToken);
            }
            catch (OperationCanceledException) { return; }
        }
    }

    private async Task ProbeAllAsync(CancellationToken ct)
    {
        var opts = _options.CurrentValue;
        var path = string.IsNullOrWhiteSpace(opts.HealthCheck.Path) ? "/healthz" : opts.HealthCheck.Path;
        var timeout = TimeSpan.FromSeconds(Math.Max(1, opts.HealthCheck.TimeoutSeconds));

        var instances = _registry.GetCurrent();
        if (instances.Count == 0) return;

        var tasks = instances.Select(s => ProbeOneAsync(s, path, timeout, ct));
        await Task.WhenAll(tasks);
    }

    private async Task ProbeOneAsync(
        DynamicSidecarInstance instance, string path, TimeSpan timeout, CancellationToken ct)
    {
        var url = instance.BaseUrl.TrimEnd('/') + (path.StartsWith("/") ? path : "/" + path);
        using var http = _httpFactory.CreateClient(ClaudeSidecarRouter.HttpClientName);
        http.Timeout = timeout;

        try
        {
            using var resp = await http.GetAsync(url, ct);
            if (resp.IsSuccessStatusCode)
            {
                _state.RecordSuccess(instance.Name);
            }
            else
            {
                _state.RecordFailure(instance.Name, _options.CurrentValue.HealthCheck.UnhealthyThreshold);
                _logger.LogWarning(
                    "[ClaudeSdk] sidecar={Name} unhealthy http={Status}",
                    instance.Name, (int)resp.StatusCode);
            }
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _state.RecordFailure(instance.Name, _options.CurrentValue.HealthCheck.UnhealthyThreshold);
            _logger.LogWarning(
                "[ClaudeSdk] sidecar={Name} health probe failed: {Msg}",
                instance.Name, ex.Message);
        }
    }
}
