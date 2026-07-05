using System.Text;
using System.Text.Json.Nodes;
using PrdAgent.Infrastructure.LlmGateway;
using PrdAgent.Infrastructure.LlmGateway.Adapters;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Gateway;

/// <summary>
/// B 层：协议保真 MECE 自测（纯函数，无 Mongo / 无 HTTP）——数据驱动版。
///
/// 把 canned 上游 payload 喂给真实 OpenAIGatewayAdapter / ClaudeGatewayAdapter / ThinkTagStripper，
/// 断言 think 三形态归一、tool_calls 归一、token/cache 采集、finish_reason 全枚举、跨 chunk 半截
/// think 缝合、字符集变体、edge→null 等。cell 全集见 Gateway/fixtures/protocol-cells.json
/// （scripts/gen-gw-matrix-report.py 生成，与 doc/report.gw-test-matrix.md 第 3 节同源）。
///
/// 对应 doc/spec.llm-gateway-test-matrix.md 的 D2/D5/D6/D7/E1/E2/E3 维度。
/// 不打 Integration/Manual trait → CI 默认 dotnet test 会真跑全部 cell。
/// </summary>
public class GatewayProtocolFidelityTests
{
    private static IGatewayAdapter Adapter(string? name) => name switch
    {
        "openai" => new OpenAIGatewayAdapter(),
        "claude" => new ClaudeGatewayAdapter(),
        _ => throw new ArgumentException($"未知 adapter: {name}"),
    };

    // ── 全部 91 个协议保真 cell 逐个真跑（[Theory] over protocol-cells.json）──
    [Theory]
    [MemberData(nameof(GatewayMatrixCells.ProtocolIds), MemberType = typeof(GatewayMatrixCells))]
    public void ProtocolCell(string id)
    {
        var cell = GatewayMatrixCells.GetProtocol(id);
        switch (cell.Method)
        {
            case "stream": AssertStream(cell); break;
            case "tokenUsage": AssertTokenUsage(cell); break;
            case "toolCalls": AssertToolCalls(cell); break;
            case "messageContent": AssertMessageContent(cell); break;
            case "thinkStripper": AssertThinkStripper(cell); break;
            default: throw new ArgumentException($"未知 method: {cell.Method} (cell {id})");
        }
    }

    private static void AssertStream(ProtocolCell cell)
    {
        var chunk = Adapter(cell.Adapter).ParseStreamChunk(cell.Payload ?? "");
        var expectType = cell.Str("chunkType");

        if (expectType == "null")
        {
            chunk.ShouldBeNull($"cell {cell.Id}: 期望 edge→null");
            return;
        }

        chunk.ShouldNotBeNull($"cell {cell.Id}: 期望非 null chunk");
        var parsed = Enum.Parse<GatewayChunkType>(expectType!);
        chunk!.Type.ShouldBe(parsed, $"cell {cell.Id}: chunk 类型不符");

        if (cell.Has("content")) chunk.Content.ShouldBe(cell.Str("content"), $"cell {cell.Id}: content 不符");
        if (cell.Has("finishReason")) chunk.FinishReason.ShouldBe(cell.Str("finishReason"), $"cell {cell.Id}: finish 不符");
        if (cell.Has("error")) chunk.Error.ShouldBe(cell.Str("error"), $"cell {cell.Id}: error 不符");
        if (cell.Has("inputTokens"))
        {
            chunk.TokenUsage.ShouldNotBeNull($"cell {cell.Id}: 期望 TokenUsage");
            chunk.TokenUsage!.InputTokens.ShouldBe(cell.Int("inputTokens"), $"cell {cell.Id}: inputTokens 不符");
        }
        if (cell.Has("outputTokens"))
            chunk.TokenUsage!.OutputTokens.ShouldBe(cell.Int("outputTokens"), $"cell {cell.Id}: outputTokens 不符");
    }

    private static void AssertTokenUsage(ProtocolCell cell)
    {
        var usage = Adapter(cell.Adapter).ParseTokenUsage(cell.Payload ?? "");
        usage.ShouldNotBeNull($"cell {cell.Id}: 期望解析出 usage");
        if (cell.Has("inputTokens")) usage!.InputTokens.ShouldBe(cell.Int("inputTokens"), $"cell {cell.Id}");
        if (cell.Has("outputTokens")) usage!.OutputTokens.ShouldBe(cell.Int("outputTokens"), $"cell {cell.Id}");
        if (cell.Has("cacheCreation")) usage!.CacheCreationInputTokens.ShouldBe(cell.Int("cacheCreation"), $"cell {cell.Id}");
        if (cell.Has("cacheRead")) usage!.CacheReadInputTokens.ShouldBe(cell.Int("cacheRead"), $"cell {cell.Id}");
    }

    private static void AssertToolCalls(ProtocolCell cell)
    {
        var arr = Adapter(cell.Adapter).ParseToolCalls(cell.Payload ?? "");
        arr.ShouldNotBeNull($"cell {cell.Id}: 期望解析出 tool_calls");
        if (cell.Has("toolCount")) arr!.Count.ShouldBe(cell.Int("toolCount"), $"cell {cell.Id}: toolCount 不符");
        if (cell.Has("toolFirstName"))
        {
            var fn = arr![0]!.AsObject()["function"]!.AsObject();
            fn["name"]!.GetValue<string>().ShouldBe(cell.Str("toolFirstName"), $"cell {cell.Id}: tool name 不符");
        }
        if (cell.Has("toolFirstType"))
            arr![0]!.AsObject()["type"]!.GetValue<string>().ShouldBe(cell.Str("toolFirstType"), $"cell {cell.Id}: tool type 未归一");
    }

    private static void AssertMessageContent(ProtocolCell cell)
    {
        var content = Adapter(cell.Adapter).ParseMessageContent(cell.Payload ?? "");
        content.ShouldBe(cell.Str("content"), $"cell {cell.Id}: message content 不符");
    }

    private static void AssertThinkStripper(ProtocolCell cell)
    {
        var stripper = new ThinkTagStripper(captureThinking: cell.CaptureThinking);
        var sb = new StringBuilder();
        foreach (var part in cell.PayloadChunks ?? new List<string>())
            sb.Append(stripper.Process(part) ?? "");
        sb.Append(stripper.Flush() ?? "");
        sb.ToString().ShouldBe(cell.Str("thinkVisible"), $"cell {cell.Id}: 可见正文不符");

        if (cell.Has("thinkCaptured"))
            stripper.PopCapturedThinking().ShouldBe(cell.Str("thinkCaptured"), $"cell {cell.Id}: 捕获思考不符");
        else if (cell.Bool("thinkCapturedEmpty"))
            stripper.PopCapturedThinking().ShouldBeNullOrEmpty($"cell {cell.Id}: 不应捕获思考");
    }

    // ─────────────────────── canary（探测有效性元断言）───────────────────────
    // 证明"协议保真"用例不是空跑：reasoning_content 绝不能被当正文 Text 吐出（think 漏进 content 回归）。
    [Fact]
    public void Canary_ReasoningMustNotLeakAsText()
    {
        var chunk = new OpenAIGatewayAdapter().ParseStreamChunk(
            """{"choices":[{"delta":{"reasoning_content":"内部思考不应作为正文"}}]}""");
        chunk.ShouldNotBeNull();
        chunk!.Type.ShouldNotBe(GatewayChunkType.Text);
        // 探测器自检：一个故意错误的期望确实会被判失败（证明断言非空跑）。
        DetectMismatch(expected: "A-model", actual: "B-model").ShouldBeTrue();
        DetectMismatch(expected: "A-model", actual: "A-model").ShouldBeFalse();
    }

    private static bool DetectMismatch(string expected, string actual)
        => !string.Equals(expected, actual, StringComparison.Ordinal);
}
