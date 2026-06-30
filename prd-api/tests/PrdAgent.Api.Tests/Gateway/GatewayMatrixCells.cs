using System.Text.Json;

namespace PrdAgent.Api.Tests.Gateway;

/// <summary>
/// 数据驱动矩阵 cell 加载器：读取 scripts/gen-gw-matrix-report.py 生成的 JSON 目录
/// （Gateway/fixtures/{protocol,transport}-cells.json，已 CopyToOutputDirectory）。
///
/// 设计：MemberData 只产出 cell id（string，xUnit 可序列化、测试名即 id），
/// 测试体按 id 从静态字典取完整 cell。报告 doc/report.gw-test-matrix.md 与这两份 JSON 同源，
/// 所以"报告里列的每一行"就是"CI 真跑的每一个 cell"。
/// </summary>
public static class GatewayMatrixCells
{
    private static readonly JsonSerializerOptions Opts = new() { PropertyNameCaseInsensitive = true };

    private static string FixtureDir =>
        Path.Combine(AppContext.BaseDirectory, "Gateway", "fixtures");

    public static IReadOnlyList<ProtocolCell> Protocol { get; } = Load<ProtocolCell>("protocol-cells.json");
    public static IReadOnlyList<TransportCell> Transport { get; } = Load<TransportCell>("transport-cells.json");

    private static readonly Dictionary<string, ProtocolCell> ProtocolById =
        Protocol.ToDictionary(c => c.Id);
    private static readonly Dictionary<string, TransportCell> TransportById =
        Transport.ToDictionary(c => c.Id);

    public static ProtocolCell GetProtocol(string id) => ProtocolById[id];
    public static TransportCell GetTransport(string id) => TransportById[id];

    public static IEnumerable<object[]> ProtocolIds() => Protocol.Select(c => new object[] { c.Id });
    public static IEnumerable<object[]> TransportIds() => Transport.Select(c => new object[] { c.Id });

    private static List<T> Load<T>(string file)
    {
        var path = Path.Combine(FixtureDir, file);
        if (!File.Exists(path))
            throw new FileNotFoundException(
                $"矩阵 cell 目录缺失: {path}。请先跑 `python3 scripts/gen-gw-matrix-report.py` 生成。");
        var json = File.ReadAllText(path);
        return JsonSerializer.Deserialize<List<T>>(json, Opts)
               ?? throw new InvalidOperationException($"解析 {file} 失败");
    }
}

public sealed class ProtocolCell
{
    public string Id { get; set; } = "";
    public string Group { get; set; } = "";
    public string Dim { get; set; } = "";
    public string? Adapter { get; set; }
    public string Method { get; set; } = "";
    public string? Payload { get; set; }
    public List<string>? PayloadChunks { get; set; }
    public bool CaptureThinking { get; set; }
    public Dictionary<string, JsonElement> Expect { get; set; } = new();

    public bool Has(string key) => Expect.ContainsKey(key);
    public string? Str(string key) => Expect.TryGetValue(key, out var v) ? v.GetString() : null;
    public int Int(string key) => Expect[key].GetInt32();
    public bool Bool(string key) => Expect.TryGetValue(key, out var v) && v.GetBoolean();
}

public sealed class TransportCell
{
    public string Id { get; set; } = "";
    public string Method { get; set; } = "";
    public string Gateway { get; set; } = "";
    public bool AuthOk { get; set; }
    public int Concurrency { get; set; } = 1;
    public string Dim { get; set; } = "";
    public Dictionary<string, JsonElement> Expect { get; set; } = new();

    public bool Has(string key) => Expect.ContainsKey(key);
    public bool Bool(string key) => Expect.TryGetValue(key, out var v) && v.GetBoolean();
    public int Int(string key) => Expect[key].GetInt32();
    public string? Str(string key) => Expect.TryGetValue(key, out var v) ? v.GetString() : null;
}
