using System.Globalization;
using System.Text.RegularExpressions;
using Map.PerformanceProbe;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;

Environment.SetEnvironmentVariable("MAP_PERF_ISOLATED", "1");
var dependency = WebApplication.CreateBuilder();
dependency.WebHost.UseUrls("http://127.0.0.1:0");
await using var upstream = dependency.Build();
upstream.MapGet("/", async () => { await Task.Delay(150); return "external fixture"; });
await upstream.StartAsync();
string Address(WebApplication app) => app.Services.GetRequiredService<IServer>()
    .Features.Get<IServerAddressesFeature>()!.Addresses.Single();

var builder = WebApplication.CreateBuilder();
builder.WebHost.UseUrls("http://127.0.0.1:0");
builder.Services.AddSingleton<IStartupFilter, ProbeFilter>();
await using var app = builder.Build();
using var http = new HttpClient();
app.MapGet("/external", async () =>
{
    await Task.WhenAll(http.GetStringAsync(Address(upstream)), http.GetStringAsync(Address(upstream)));
    return "ok";
});
app.MapGet("/api/document-store/entries/test/content", () => "ok");
await app.StartAsync();

async Task<Dictionary<string, double>> Timing(string route)
{
    using var response = await http.GetAsync(Address(app) + route);
    response.EnsureSuccessStatusCode();
    var header = response.Headers.GetValues("Server-Timing").Single();
    return Regex.Matches(header, @"([a-z_]+);dur=([\d.]+)")
        .ToDictionary(m => m.Groups[1].Value, m => double.Parse(m.Groups[2].Value, CultureInfo.InvariantCulture));
}
// Warm JIT and sockets, then check actual HTTP diagnostic events and overlapping spans.
await Timing("/external");
var external = await Timing("/external");
if (external["external_http"] < 140 || external["external_http"] > external["server"]
    || external["external_http"] > 260 || external["app"] > 100)
    throw new Exception("HTTP依赖耗时未被独立测量，或并行调用被重复相加");
Environment.SetEnvironmentVariable("MAP_PERF_DELAY_MS", "350");
var injected = await Timing("/api/document-store/entries/test/content");
if (injected["app"] < 340 || injected["external_http"] != 0)
    throw new Exception("应用退化被错误归为外部服务耗时");
Console.WriteLine($"通过: 并发上游 union={external["external_http"]}ms, app={external["app"]}ms; 注入 app={injected["app"]}ms");
