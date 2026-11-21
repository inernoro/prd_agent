using System.Diagnostics;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Configuration;
using PrdAgent.Core.LlmGateway;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public sealed partial class UpstreamResponseProtectionTests
{
    // 合成大负载按需点名运行，避免默认并发测试把测量互相污染；不是生产性能阈值。
    [Theory, Trait("Category", "Manual")]
    [InlineData("send", 8 * 1024 * 1024, true)]
    [InlineData("content", 8 * 1024 * 1024, true)]
    [InlineData("reasoning_content", 8 * 1024 * 1024, true)]
    [InlineData("arguments", 8 * 1024 * 1024, true)]
    [InlineData("content", 33 * 1024 * 1024, false)]
    public async Task MeasureCandidateBudgetCompatibility(string kind, int chars, bool success)
    {
        var text = new string('x', chars);
        var body = kind == "send" ? JsonSerializer.Serialize(new { choices = new[] { new { message = new { content = text } } } })
            : string.Concat(Enumerable.Range(0, (chars + 65535) / 65536).Select(i => Event(kind, text.Substring(i * 65536, Math.Min(65536, chars - i * 65536))))) + "data: [DONE]\n\n";
        var config = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["LlmGateway:ResponseBudget:ResponseBytes"] = (32 * 1024 * 1024).ToString(),
            ["LlmGateway:ResponseBudget:EventBytes"] = (4 * 1024 * 1024).ToString(),
            ["LlmGateway:ResponseBudget:OutputBytes"] = (32 * 1024 * 1024).ToString(),
        }).Build();
        var logs = new CapturingLogWriter();
        var gateway = Gateway(new BodyFactory(body, kind == "send" ? "application/json" : "text/event-stream", unknownLength: true), logs, config);
        using var process = Process.GetCurrentProcess();
        var initialWorkingSet = process.WorkingSet64;
        long sampledPeakWorkingSet = initialWorkingSet;
        using var memorySampler = new Timer(_ =>
        {
            process.Refresh();
            var current = process.WorkingSet64;
            long previous;
            do { previous = Interlocked.Read(ref sampledPeakWorkingSet); }
            while (current > previous && Interlocked.CompareExchange(ref sampledPeakWorkingSet, current, previous) != previous);
        }, null, 0, 10);
        var allocation = GC.GetTotalAllocatedBytes(true); var timer = Stopwatch.StartNew();
        long outputBytes = 0; var sawSuccess = false; string? error = null;
        if (kind == "send")
        {
            var result = await gateway.SendAsync(Request()); sawSuccess = result.Success; error = result.ErrorCode;
            outputBytes = Encoding.UTF8.GetByteCount(result.Content ?? "");
        }
        else
        {
            await foreach (var chunk in gateway.StreamAsync(Request()))
            {
                if (chunk.Type == GatewayChunkType.Done) sawSuccess = true;
                if (chunk.Type == GatewayChunkType.Error) error = chunk.ErrorCode;
                outputBytes += Encoding.UTF8.GetByteCount(chunk.Content ?? "");
                if (chunk.ToolCallDelta is { } calls)
                    foreach (var call in calls) outputBytes += Encoding.UTF8.GetByteCount(call?["function"]?["arguments"]?.GetValue<string>() ?? "");
            }
        }
        timer.Stop();
        await memorySampler.DisposeAsync();
        process.Refresh();
        sampledPeakWorkingSet = Math.Max(sampledPeakWorkingSet, process.WorkingSet64);
        var allocatedBytes = GC.GetTotalAllocatedBytes(true) - allocation;
        Assert.Equal(success, sawSuccess);
        if (success) Assert.Equal(chars, outputBytes);
        else Assert.Equal("UPSTREAM_RESPONSE_TOO_LARGE", error);
        Assert.Equal(success ? "succeeded" : "failed", logs.Done?.Status);
        if (success && kind == "arguments")
        {
            using var recorded = JsonDocument.Parse(logs.Done!.ResponseToolCalls!);
            Assert.Equal(text, recorded.RootElement[0].GetProperty("function").GetProperty("arguments").GetString());
        }
        output.WriteLine($"kind={kind};contentLengthAbsent=true;wireBytes={Encoding.UTF8.GetByteCount(body)};outputBytes={outputBytes};success={sawSuccess};elapsedMs={timer.Elapsed.TotalMilliseconds:F1};allocatedBytes={allocatedBytes};initialWorkingSetBytes={initialWorkingSet};sampledPeakWorkingSetBytes={sampledPeakWorkingSet};processLifetimePeakWorkingSetBytes={process.PeakWorkingSet64};workingSetBytes={process.WorkingSet64}");
    }
}
