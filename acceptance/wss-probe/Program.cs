using Microsoft.Extensions.Logging.Abstractions;
using PrdAgent.Infrastructure.LlmGateway;
using PrdAgent.Infrastructure.Services;

var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();

app.MapGet("/healthz", () => Results.Ok(new { ok = true }));
app.MapGet("/run", async () =>
{
    const string target = "wss://llmgw-wss-acceptance-stub-codex-prd-agent-llmgw-wss-stub.miduo.org/asr";
    var connector = new SafeOutboundWebSocketConnector(new SafeOutboundUrlValidator());
    var rejected = new[]
    {
        "ws://example.com/asr",
        "wss://user:password@example.com/asr",
        "wss://localhost/asr",
        "wss://127.0.0.1/asr",
        "wss://10.0.0.1/asr",
        "wss://169.254.169.254/latest/meta-data",
        "wss://192.0.2.1/asr",
    };
    var rejectionResults = new List<object>();
    foreach (var url in rejected)
    {
        try
        {
            await connector.PrepareAsync(url);
            rejectionResults.Add(new { url, rejected = false, reason = "not-rejected" });
        }
        catch (InvalidOperationException ex)
        {
            rejectionResults.Add(new { url, rejected = true, reason = ex.Message });
        }
    }

    var prepared = await connector.PrepareAsync(target);
    var service = new DoubaoStreamAsrService(
        NullLogger<DoubaoStreamAsrService>.Instance,
        connector);
    var result = await service.TranscribeAsync(
        target,
        "acceptance-app",
        "acceptance-access",
        CreateSilentWav(),
        new Dictionary<string, object>
        {
            ["resourceId"] = "acceptance.resource",
        },
        requirePublicPinnedWebSocket: true);
    return Results.Json(new
    {
        prepared = new
        {
            scheme = prepared.Uri.Scheme,
            host = prepared.Uri.IdnHost,
            publicAddresses = prepared.Addresses.Select(address => address.ToString()).ToArray(),
        },
        rejected = rejectionResults,
        roundtrip = new
        {
            result.Success,
            result.FullText,
            result.Error,
            responseCount = result.Responses.Count,
        },
    });
});

app.Run();

static byte[] CreateSilentWav()
{
    const int sampleRate = 16000;
    const short channels = 1;
    const short bitsPerSample = 16;
    const int samples = sampleRate / 10;
    var pcmBytes = samples * channels * bitsPerSample / 8;

    using var stream = new MemoryStream();
    using var writer = new BinaryWriter(stream);
    writer.Write("RIFF"u8.ToArray());
    writer.Write(36 + pcmBytes);
    writer.Write("WAVE"u8.ToArray());
    writer.Write("fmt "u8.ToArray());
    writer.Write(16);
    writer.Write((short)1);
    writer.Write(channels);
    writer.Write(sampleRate);
    writer.Write(sampleRate * channels * bitsPerSample / 8);
    writer.Write((short)(channels * bitsPerSample / 8));
    writer.Write(bitsPerSample);
    writer.Write("data"u8.ToArray());
    writer.Write(pcmBytes);
    writer.Write(new byte[pcmBytes]);
    return stream.ToArray();
}
