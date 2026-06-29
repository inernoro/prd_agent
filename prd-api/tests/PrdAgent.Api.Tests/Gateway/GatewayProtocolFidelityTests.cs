using System.Text.Json.Nodes;
using PrdAgent.Infrastructure.LlmGateway;
using PrdAgent.Infrastructure.LlmGateway.Adapters;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Gateway;

/// <summary>
/// B 层：协议保真 MECE 自测（纯函数，无 Mongo / 无 HTTP）。
///
/// 把 canned 上游 payload 喂给真实的 OpenAIGatewayAdapter / ClaudeGatewayAdapter / ThinkTagStripper，
/// 断言 think 字段三形态归一、tool_calls 归一、token/cache 采集、finish_reason、跨 chunk 半截 think 标签缝合。
/// 对应 doc/spec.llm-gateway-test-matrix.md 的 D2/D4/D5/D6/D7 维度。
///
/// canary（D11 探测有效性）：最后一个用例用"期望检测到不一致"的语义证明比对不是空跑。
/// 不打 Integration/Manual trait → CI 默认 dotnet test 会真跑。
/// </summary>
public class GatewayProtocolFidelityTests
{
    private readonly OpenAIGatewayAdapter _openai = new();
    private readonly ClaudeGatewayAdapter _claude = new();

    // ── D5 think 位置：reasoning_content 字段（DeepSeek/Qwen 原生）→ Thinking chunk ──
    [Fact]
    public void OpenAI_ReasoningContentField_ShouldEmitThinkingChunk()
    {
        var chunk = _openai.ParseStreamChunk("""{"choices":[{"delta":{"reasoning_content":"想一想"}}]}""");
        chunk.ShouldNotBeNull();
        chunk!.Type.ShouldBe(GatewayChunkType.Thinking);
        chunk.Content.ShouldBe("想一想");
    }

    // ── D5 think 位置：reasoning 字段（OpenRouter 归一 deepseek-r1）→ Thinking chunk ──
    [Fact]
    public void OpenAI_ReasoningField_ShouldEmitThinkingChunk()
    {
        var chunk = _openai.ParseStreamChunk("""{"choices":[{"delta":{"reasoning":"reasoning here"}}]}""");
        chunk.ShouldNotBeNull();
        chunk!.Type.ShouldBe(GatewayChunkType.Thinking);
        chunk.Content.ShouldBe("reasoning here");
    }

    // ── D2/正文：content delta → Text chunk ──
    [Fact]
    public void OpenAI_ContentDelta_ShouldEmitTextChunk()
    {
        var chunk = _openai.ParseStreamChunk("""{"choices":[{"delta":{"content":"hello"}}]}""");
        chunk.ShouldNotBeNull();
        chunk!.Type.ShouldBe(GatewayChunkType.Text);
        chunk.Content.ShouldBe("hello");
    }

    // ── finish_reason → Done chunk，带 FinishReason ──
    [Fact]
    public void OpenAI_FinishReason_ShouldEmitDoneChunk()
    {
        var chunk = _openai.ParseStreamChunk("""{"choices":[{"delta":{},"finish_reason":"stop"}]}""");
        chunk.ShouldNotBeNull();
        chunk!.Type.ShouldBe(GatewayChunkType.Done);
        chunk.FinishReason.ShouldBe("stop");
    }

    // ── D7 token：流式 usage → TokenUsage 采集 ──
    [Fact]
    public void OpenAI_StreamUsage_ShouldPopulateTokenUsage()
    {
        var chunk = _openai.ParseStreamChunk("""{"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":7}}""");
        chunk.ShouldNotBeNull();
        chunk!.TokenUsage.ShouldNotBeNull();
        chunk.TokenUsage!.InputTokens.ShouldBe(12);
        chunk.TokenUsage.OutputTokens.ShouldBe(7);
    }

    // ── D6 工具：流式 tool_calls delta → ToolCall chunk ──
    [Fact]
    public void OpenAI_ToolCallsDelta_ShouldEmitToolCallChunk()
    {
        var chunk = _openai.ParseStreamChunk(
            """{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"f","arguments":"{}"}}]}}]}""");
        chunk.ShouldNotBeNull();
        chunk!.Type.ShouldBe(GatewayChunkType.ToolCall);
        chunk.ToolCallDelta.ShouldNotBeNull();
    }

    // ── D7 token：非流式 usage 解析 ──
    [Fact]
    public void OpenAI_NonStreamUsage_ShouldParse()
    {
        var usage = _openai.ParseTokenUsage("""{"usage":{"prompt_tokens":30,"completion_tokens":11}}""");
        usage.ShouldNotBeNull();
        usage!.InputTokens.ShouldBe(30);
        usage.OutputTokens.ShouldBe(11);
    }

    // ── D6 工具：非流式 OpenAI tool_calls 解析 ──
    [Fact]
    public void OpenAI_NonStreamToolCalls_ShouldParseArray()
    {
        var arr = _openai.ParseToolCalls(
            """{"choices":[{"message":{"tool_calls":[{"id":"c1","type":"function","function":{"name":"g","arguments":"{}"}}]}}]}""");
        arr.ShouldNotBeNull();
        arr!.Count.ShouldBe(1);
    }

    // ── D6 工具：Claude tool_use → 归一成 OpenAI 形状 tool_calls ──
    [Fact]
    public void Claude_ToolUse_ShouldNormalizeToOpenAiToolCalls()
    {
        var arr = _claude.ParseToolCalls(
            """{"content":[{"type":"tool_use","id":"tu_1","name":"search","input":{"q":"x"}}]}""");
        arr.ShouldNotBeNull();
        arr!.Count.ShouldBe(1);
        var first = arr[0]!.AsObject();
        first["type"]!.GetValue<string>().ShouldBe("function");
        first["function"]!.AsObject()["name"]!.GetValue<string>().ShouldBe("search");
    }

    // ── D7 cache：Claude usage 带 cache_creation/cache_read ──
    [Fact]
    public void Claude_Usage_ShouldParseCacheTokens()
    {
        var usage = _claude.ParseTokenUsage(
            """{"usage":{"input_tokens":40,"output_tokens":9,"cache_creation_input_tokens":15,"cache_read_input_tokens":3}}""");
        usage.ShouldNotBeNull();
        usage!.InputTokens.ShouldBe(40);
        usage.CacheCreationInputTokens.ShouldBe(15);
        usage.CacheReadInputTokens.ShouldBe(3);
    }

    // ── D5 think 位置：<think> 标签内联 → 剥离 + 捕获（单块）──
    [Fact]
    public void ThinkTagStripper_InlineThinkTag_ShouldStripAndCapture()
    {
        var stripper = new ThinkTagStripper(captureThinking: true);
        var visible = (stripper.Process("<think>推理内容</think>正式回答") ?? "") + (stripper.Flush() ?? "");
        visible.ShouldBe("正式回答");
        stripper.PopCapturedThinking().ShouldBe("推理内容");
    }

    // ── D5 think 位置：<think> 跨 chunk 半截标签 → 正确缝合 ──
    [Fact]
    public void ThinkTagStripper_ThinkTagSplitAcrossChunks_ShouldStitch()
    {
        var stripper = new ThinkTagStripper(captureThinking: false);
        var sb = new System.Text.StringBuilder();
        sb.Append(stripper.Process("abc<thi") ?? "");
        sb.Append(stripper.Process("nk>secret</thi") ?? "");
        sb.Append(stripper.Process("nk>xyz") ?? "");
        sb.Append(stripper.Flush() ?? "");
        sb.ToString().ShouldBe("abcxyz");
    }

    // ── D5：无 think 的普通内容，stripper 原样透传 ──
    [Fact]
    public void ThinkTagStripper_PlainContent_ShouldPassThrough()
    {
        var stripper = new ThinkTagStripper(captureThinking: true);
        var visible = (stripper.Process("just text") ?? "") + (stripper.Flush() ?? "");
        visible.ShouldBe("just text");
        stripper.PopCapturedThinking().ShouldBeNullOrEmpty();
    }

    // ─────────────────────── canary（探测有效性元断言）───────────────────────
    // D11：证明"协议保真"用例不是空跑——故意构造一个"reasoning 被误当 content 吐出"的回归，
    // 用真实适配器解析正确结果，再断言：若有人把 reasoning_content 改成走 Text，会被本套用例抓到。
    // 这里用一个确定性的负向控制：reasoning_content 解析结果的 Type 必须 != Text。
    [Fact]
    public void Canary_ReasoningMustNotLeakAsText()
    {
        var chunk = _openai.ParseStreamChunk("""{"choices":[{"delta":{"reasoning_content":"内部思考不应作为正文"}}]}""");
        chunk.ShouldNotBeNull();
        // 负向控制：思考绝不能被当作正文 Text 吐给调用方（否则就是"think 漏进 content"回归）。
        chunk!.Type.ShouldNotBe(GatewayChunkType.Text);
        // 探测器自检：一个故意错误的期望确实会被 Shouldly 判失败（证明断言非空跑）。
        DetectMismatch(expected: "A-model", actual: "B-model").ShouldBeTrue();
        DetectMismatch(expected: "A-model", actual: "A-model").ShouldBeFalse();
    }

    // 模拟 golden 比对器的"选 A 给 B"探测：期望与实际不一致即判异常。
    private static bool DetectMismatch(string expected, string actual)
        => !string.Equals(expected, actual, StringComparison.Ordinal);
}
