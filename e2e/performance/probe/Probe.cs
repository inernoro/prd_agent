using System.Collections.Concurrent;
using System.Diagnostics;
using System.Globalization;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;

[assembly: HostingStartup(typeof(Map.PerformanceProbe.Startup))]

namespace Map.PerformanceProbe;

// Loaded only by the isolated runner; the application has no reference to this assembly.
public sealed class Startup : IHostingStartup
{
    public void Configure(IWebHostBuilder builder) => builder.ConfigureServices(services =>
        services.AddSingleton<IStartupFilter, ProbeFilter>());
}

public sealed class ProbeFilter : IStartupFilter
{
    private static readonly AsyncLocal<RequestTiming?> Current = new();
    private static readonly ConcurrentDictionary<string, RequestTiming> Pending = new();
    private static readonly Listener Observer = new();
    private static readonly IDisposable Subscription = DiagnosticListener.AllListeners.Subscribe(Observer);

    public Action<IApplicationBuilder> Configure(Action<IApplicationBuilder> next) => app =>
    {
        if (Environment.GetEnvironmentVariable("MAP_PERF_ISOLATED") != "1")
            throw new InvalidOperationException("Performance probe requires an isolated test runtime");
        app.Use(async (context, onward) =>
        {
            var timing = new RequestTiming();
            Current.Value = timing;
            context.Response.OnStarting(() =>
            {
                var elapsed = timing.Clock.Elapsed.TotalMilliseconds;
                var external = timing.ExternalMilliseconds();
                context.Response.Headers["Server-Timing"] = string.Create(CultureInfo.InvariantCulture,
                    $"server;dur={elapsed:F3}, external_http;dur={external:F3}, app;dur={Math.Max(0, elapsed - external):F3}");
                context.Response.Headers["X-Map-Perf-Isolated"] = "v1";
                return Task.CompletedTask;
            });
            try
            {
                // Controlled application-side regression, before the real controller runs.
                // No injected response, bypass, or production application code is involved.
                if (context.Request.Path.Value?.StartsWith("/api/document-store/entries/", StringComparison.Ordinal) == true
                    && context.Request.Path.Value.EndsWith("/content", StringComparison.Ordinal)
                    && int.TryParse(Environment.GetEnvironmentVariable("MAP_PERF_DELAY_MS"), out var delay)
                    && delay > 0)
                    await Task.Delay(Math.Min(delay, 2000), context.RequestAborted);
                await onward();
            }
            finally { Current.Value = null; }
        });
        next(app);
    };

    private sealed class RequestTiming
    {
        public Stopwatch Clock { get; } = Stopwatch.StartNew();
        private readonly List<(double Start, double End)> _spans = new();
        public void Add(double start) { lock (_spans) _spans.Add((start, Clock.Elapsed.TotalMilliseconds)); }
        public double ExternalMilliseconds()
        {
            lock (_spans)
            {
                double end = 0, total = 0;
                foreach (var span in _spans.OrderBy(x => x.Start))
                {
                    total += Math.Max(0, span.End - Math.Max(end, span.Start));
                    end = Math.Max(end, span.End);
                }
                return total;
            }
        }
    }

    private sealed class Listener : IObserver<DiagnosticListener>, IObserver<KeyValuePair<string, object?>>
    {
        private readonly ConcurrentDictionary<string, double> _starts = new();
        public void OnNext(DiagnosticListener value)
        {
            if (value.Name == "HttpHandlerDiagnosticListener") value.Subscribe(this);
        }
        public void OnNext(KeyValuePair<string, object?> value)
        {
            var id = Activity.Current?.Id;
            if (id == null) return;
            if (value.Key == "System.Net.Http.HttpRequestOut.Start" && Current.Value is { } timing)
            {
                Pending[id] = timing;
                _starts[id] = timing.Clock.Elapsed.TotalMilliseconds;
            }
            else if (value.Key == "System.Net.Http.HttpRequestOut.Stop"
                && Pending.TryRemove(id, out var owner) && _starts.TryRemove(id, out var start))
                owner.Add(start);
        }
        public void OnCompleted() { }
        public void OnError(Exception error) { }
    }
}
