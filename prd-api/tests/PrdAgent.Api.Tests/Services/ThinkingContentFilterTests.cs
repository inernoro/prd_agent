using System.Text.Json;
using PrdAgent.Core.Interfaces;
using PrdAgent.Infrastructure.LLM;
using PrdAgent.Infrastructure.LlmGateway;
using PrdAgent.Infrastructure.LlmGateway.Adapters;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

/// <summary>
/// 思考内容过滤测试
/// 验证 Claude thinking_delta 和 DeepSeek/doubao reasoning_content 的正确处理：
/// - Claude: thinking_delta 在适配器层直接过滤
/// - OpenAI 兼容模型: reasoning_content 标记为 Reasoning 类型，由 GatewayLLMClient 智能决策
///   - 有 content → 只输出 content（DeepSeek R1 场景）
///   - 无 content → 将 reasoning 作为回复输出（doubao-seed 场景）
///
/// 运行方式:
///   dotnet test --filter "ThinkingContentFilterTests"
/// </summary>
public class ThinkingContentFilterTests
{
    #region ClaudeGatewayAdapter Tests

    [Fact]
    public void Claude_TextDelta_ShouldReturnContent()
    {
        var adapter = new ClaudeGatewayAdapter();
        var sseData = """
        {
            "type": "content_block_delta",
            "index": 0,
            "delta": { "type": "text_delta", "text": "你好世界" }
        }
        """;

        var chunk = adapter.ParseStreamChunk(sseData);

        chunk.ShouldNotBeNull();
        chunk.Type.ShouldBe(GatewayChunkType.Text);
        chunk.Content.ShouldBe("你好世界");
    }

    [Fact]
    public void Claude_ThinkingDelta_ShouldBeFiltered()
    {
        var adapter = new ClaudeGatewayAdapter();
        var sseData = """
        {
            "type": "content_block_delta",
            "index": 0,
            "delta": { "type": "thinking_delta", "thinking": "让我分析一下这个问题..." }
        }
        """;

        var chunk = adapter.ParseStreamChunk(sseData);

        chunk.ShouldBeNull();
    }

    [Fact]
    public void Claude_ThinkingDelta_WithTextFieldToo_ShouldBeFiltered()
    {
        var adapter = new ClaudeGatewayAdapter();
        var sseData = """
        {
            "type": "content_block_delta",
            "index": 0,
            "delta": { "type": "thinking_delta", "text": "这不应该输出", "thinking": "思考过程..." }
        }
        """;

        var chunk = adapter.ParseStreamChunk(sseData);

        chunk.ShouldBeNull();
    }

    [Fact]
    public void Claude_DeltaWithoutType_ShouldBeFiltered()
    {
        var adapter = new ClaudeGatewayAdapter();
        var sseData = """
        {
            "type": "content_block_delta",
            "index": 0,
            "delta": { "text": "缺少 type 的 delta" }
        }
        """;

        var chunk = adapter.ParseStreamChunk(sseData);

        chunk.ShouldBeNull();
    }

    [Fact]
    public void Claude_MessageStop_ShouldStillWork()
    {
        var adapter = new ClaudeGatewayAdapter();
        var sseData = """{ "type": "message_stop" }""";

        var chunk = adapter.ParseStreamChunk(sseData);

        chunk.ShouldNotBeNull();
        chunk.Type.ShouldBe(GatewayChunkType.Done);
    }

    [Fact]
    public void Claude_MessageDelta_WithUsage_ShouldStillWork()
    {
        var adapter = new ClaudeGatewayAdapter();
        var sseData = """
        {
            "type": "message_delta",
            "delta": { "stop_reason": "end_turn" },
            "usage": { "output_tokens": 150 }
        }
        """;

        var chunk = adapter.ParseStreamChunk(sseData);

        chunk.ShouldNotBeNull();
        chunk.Type.ShouldBe(GatewayChunkType.Done);
        chunk.FinishReason.ShouldBe("end_turn");
    }

    [Theory]
    [InlineData("signature_delta")]
    [InlineData("citations_delta")]
    [InlineData("input_json_delta")]
    public void Claude_OtherDeltaTypes_ShouldBeFiltered(string deltaType)
    {
        var adapter = new ClaudeGatewayAdapter();
        var sseData = $$"""
        {
            "type": "content_block_delta",
            "index": 0,
            "delta": { "type": "{{deltaType}}", "text": "不应该输出" }
        }
        """;

        var chunk = adapter.ParseStreamChunk(sseData);

        chunk.ShouldBeNull();
    }

    #endregion

    #region OpenAIGatewayAdapter Tests

    [Fact]
    public void OpenAI_NormalContent_ShouldReturnText()
    {
        var adapter = new OpenAIGatewayAdapter();
        var sseData = """
        {
            "choices": [{
                "delta": { "content": "正常回复内容" }
            }]
        }
        """;

        var chunk = adapter.ParseStreamChunk(sseData);

        chunk.ShouldNotBeNull();
        chunk.Type.ShouldBe(GatewayChunkType.Text);
        chunk.Content.ShouldBe("正常回复内容");
    }

    [Fact]
    public void OpenAI_ReasoningContent_ShouldReturnReasoningType()
    {
        // reasoning_content 应标记为 Reasoning 类型（不是 Text，也不是 null）
        var adapter = new OpenAIGatewayAdapter();
        var sseData = """
        {
            "choices": [{
                "delta": { "reasoning_content": "让我仔细想想这个问题的解法..." }
            }]
        }
        """;

        var chunk = adapter.ParseStreamChunk(sseData);

        chunk.ShouldNotBeNull();
        chunk.Type.ShouldBe(GatewayChunkType.Reasoning);
        chunk.Content.ShouldBe("让我仔细想想这个问题的解法...");
    }

    [Fact]
    public void OpenAI_ContentAndReasoning_ShouldPreferContent()
    {
        // 同时有 content 和 reasoning_content 时，优先返回 content（Text 类型）
        var adapter = new OpenAIGatewayAdapter();
        var sseData = """
        {
            "choices": [{
                "delta": {
                    "content": "最终答案",
                    "reasoning_content": "中间推理过程"
                }
            }]
        }
        """;

        var chunk = adapter.ParseStreamChunk(sseData);

        chunk.ShouldNotBeNull();
        chunk.Type.ShouldBe(GatewayChunkType.Text);
        chunk.Content.ShouldBe("最终答案");
    }

    [Fact]
    public void OpenAI_EmptyContentWithReasoning_ShouldReturnReasoning()
    {
        // content 为空字符串 + reasoning_content 有值 → 返回 Reasoning
        var adapter = new OpenAIGatewayAdapter();
        var sseData = """
        {
            "choices": [{
                "delta": {
                    "content": "",
                    "reasoning_content": "推理过程内容"
                }
            }]
        }
        """;

        var chunk = adapter.ParseStreamChunk(sseData);

        chunk.ShouldNotBeNull();
        chunk.Type.ShouldBe(GatewayChunkType.Reasoning);
        chunk.Content.ShouldBe("推理过程内容");
    }

    [Fact]
    public void OpenAI_FinishReason_ShouldStillWork()
    {
        var adapter = new OpenAIGatewayAdapter();
        var sseData = """
        {
            "choices": [{
                "finish_reason": "stop",
                "delta": {}
            }]
        }
        """;

        var chunk = adapter.ParseStreamChunk(sseData);

        chunk.ShouldNotBeNull();
        chunk.Type.ShouldBe(GatewayChunkType.Done);
        chunk.FinishReason.ShouldBe("stop");
    }

    [Fact]
    public void OpenAI_UsageChunk_ShouldStillWork()
    {
        var adapter = new OpenAIGatewayAdapter();
        var sseData = """
        {
            "usage": { "prompt_tokens": 100, "completion_tokens": 200 }
        }
        """;

        var chunk = adapter.ParseStreamChunk(sseData);

        chunk.ShouldNotBeNull();
        chunk.Type.ShouldBe(GatewayChunkType.Done);
        chunk.TokenUsage.ShouldNotBeNull();
        chunk.TokenUsage!.InputTokens.ShouldBe(100);
        chunk.TokenUsage.OutputTokens.ShouldBe(200);
    }

    #endregion

    #region ClaudeDelta Deserialization Tests

    [Fact]
    public void ClaudeDelta_TextDelta_ShouldDeserializeCorrectly()
    {
        var json = """
        {
            "type": "content_block_delta",
            "delta": { "type": "text_delta", "text": "hello" }
        }
        """;

        var evt = JsonSerializer.Deserialize(json, LLMJsonContext.Default.ClaudeStreamEvent);

        evt.ShouldNotBeNull();
        evt!.Type.ShouldBe("content_block_delta");
        evt.Delta.ShouldNotBeNull();
        evt.Delta!.Type.ShouldBe("text_delta");
        evt.Delta.Text.ShouldBe("hello");
    }

    [Fact]
    public void ClaudeDelta_ThinkingDelta_ShouldDeserializeWithNullText()
    {
        var json = """
        {
            "type": "content_block_delta",
            "delta": { "type": "thinking_delta", "thinking": "let me think..." }
        }
        """;

        var evt = JsonSerializer.Deserialize(json, LLMJsonContext.Default.ClaudeStreamEvent);

        evt.ShouldNotBeNull();
        evt!.Delta.ShouldNotBeNull();
        evt.Delta!.Type.ShouldBe("thinking_delta");
        evt.Delta.Text.ShouldBeNull();
    }

    [Fact]
    public void ClaudeDelta_TextDelta_TypeCheckPreventsThinkingLeak()
    {
        var textJson = """
        {
            "type": "content_block_delta",
            "delta": { "type": "text_delta", "text": "正文内容" }
        }
        """;
        var thinkingJson = """
        {
            "type": "content_block_delta",
            "delta": { "type": "thinking_delta", "thinking": "思考过程" }
        }
        """;

        var textEvt = JsonSerializer.Deserialize(textJson, LLMJsonContext.Default.ClaudeStreamEvent);
        var thinkingEvt = JsonSerializer.Deserialize(thinkingJson, LLMJsonContext.Default.ClaudeStreamEvent);

        bool textPasses = textEvt?.Type == "content_block_delta"
                          && textEvt.Delta?.Type == "text_delta"
                          && textEvt.Delta?.Text != null;

        bool thinkingPasses = thinkingEvt?.Type == "content_block_delta"
                              && thinkingEvt.Delta?.Type == "text_delta"
                              && thinkingEvt.Delta?.Text != null;

        textPasses.ShouldBeTrue("text_delta 应该通过过滤");
        thinkingPasses.ShouldBeFalse("thinking_delta 不应通过过滤");
    }

    #endregion

    #region End-to-End: Claude Extended Thinking (adapter layer)

    [Fact]
    public void Claude_ExtendedThinking_FullStream_OnlyTextShouldPass()
    {
        var adapter = new ClaudeGatewayAdapter();

        var sseEvents = new[]
        {
            """{ "type": "message_start", "message": { "usage": { "input_tokens": 50 } } }""",
            """{ "type": "content_block_start", "index": 0, "content_block": { "type": "thinking", "thinking": "" } }""",
            """{ "type": "content_block_delta", "index": 0, "delta": { "type": "thinking_delta", "thinking": "首先分析问题的要求，" } }""",
            """{ "type": "content_block_delta", "index": 0, "delta": { "type": "thinking_delta", "thinking": "然后逐步推理出解决方案..." } }""",
            """{ "type": "content_block_stop", "index": 0 }""",
            """{ "type": "content_block_start", "index": 1, "content_block": { "type": "text", "text": "" } }""",
            """{ "type": "content_block_delta", "index": 1, "delta": { "type": "text_delta", "text": "根据分析，" } }""",
            """{ "type": "content_block_delta", "index": 1, "delta": { "type": "text_delta", "text": "答案是42。" } }""",
            """{ "type": "content_block_stop", "index": 1 }""",
            """{ "type": "message_delta", "delta": { "stop_reason": "end_turn" }, "usage": { "output_tokens": 200 } }""",
            """{ "type": "message_stop" }""",
        };

        var textChunks = new List<string>();
        var allChunks = new List<GatewayStreamChunk>();

        foreach (var sse in sseEvents)
        {
            var chunk = adapter.ParseStreamChunk(sse);
            if (chunk != null)
            {
                allChunks.Add(chunk);
                if (chunk.Type == GatewayChunkType.Text && !string.IsNullOrEmpty(chunk.Content))
                {
                    textChunks.Add(chunk.Content);
                }
            }
        }

        var assembled = string.Join("", textChunks);
        assembled.ShouldBe("根据分析，答案是42。");
        assembled.ShouldNotContain("首先分析");
        assembled.ShouldNotContain("逐步推理");
        allChunks.ShouldContain(c => c.Type == GatewayChunkType.Done);
    }

    #endregion

    #region End-to-End: DeepSeek R1 (adapter + consumer layer)

    [Fact]
    public void DeepSeek_R1_AdapterLevel_ReasoningAndTextSeparated()
    {
        // DeepSeek R1: reasoning_content 标记为 Reasoning，content 标记为 Text
        var adapter = new OpenAIGatewayAdapter();

        var sseEvents = new[]
        {
            """{ "choices": [{ "delta": { "reasoning_content": "好的，让我分析一下。" } }] }""",
            """{ "choices": [{ "delta": { "reasoning_content": "考虑边界条件..." } }] }""",
            """{ "choices": [{ "delta": { "content": "经过分析，" } }] }""",
            """{ "choices": [{ "delta": { "content": "结论是可行。" } }] }""",
            """{ "choices": [{ "finish_reason": "stop", "delta": {} }] }""",
        };

        var textChunks = new List<string>();
        var reasoningChunks = new List<string>();

        foreach (var sse in sseEvents)
        {
            var chunk = adapter.ParseStreamChunk(sse);
            if (chunk == null) continue;

            if (chunk.Type == GatewayChunkType.Text)
                textChunks.Add(chunk.Content!);
            else if (chunk.Type == GatewayChunkType.Reasoning)
                reasoningChunks.Add(chunk.Content!);
        }

        // 适配器层：两种类型分开标记
        string.Join("", textChunks).ShouldBe("经过分析，结论是可行。");
        string.Join("", reasoningChunks).ShouldBe("好的，让我分析一下。考虑边界条件...");
    }

    [Fact]
    public async Task DeepSeek_R1_ConsumerLevel_OnlyContentOutput()
    {
        // GatewayLLMClient 消费层：有 content 时，丢弃 reasoning，只输出 content
        var chunks = new GatewayStreamChunk[]
        {
            GatewayStreamChunk.Start(new GatewayModelResolution { Success = true, ResolutionType = "DefaultPool", ActualModel = "deepseek-r1" }),
            GatewayStreamChunk.ReasoningContent("让我分析一下。"),
            GatewayStreamChunk.ReasoningContent("考虑边界条件..."),
            GatewayStreamChunk.Text("经过分析，"),
            GatewayStreamChunk.Text("结论是可行。"),
            GatewayStreamChunk.Done("stop", null),
        };

        var gateway = new FakeGateway(chunks);
        var client = new GatewayLLMClient(gateway, "test.chat::chat", "chat");

        var output = new List<string>();
        await foreach (var chunk in client.StreamGenerateAsync("system", new List<LLMMessage>()))
        {
            if (chunk.Type == "delta" && !string.IsNullOrEmpty(chunk.Content))
                output.Add(chunk.Content);
        }

        var assembled = string.Join("", output);
        assembled.ShouldBe("经过分析，结论是可行。");
        assembled.ShouldNotContain("让我分析");
        assembled.ShouldNotContain("边界条件");
    }

    #endregion

    #region End-to-End: Doubao Seed (reasoning-only model)

    [Fact]
    public async Task DoubaoSeed_ReasoningOnly_ShouldFlushAsContent()
    {
        // doubao-seed 场景：所有输出都走 reasoning_content，content 始终为空
        // GatewayLLMClient 应该在流结束时将 reasoning 作为回复 flush 输出
        var chunks = new GatewayStreamChunk[]
        {
            GatewayStreamChunk.Start(new GatewayModelResolution { Success = true, ResolutionType = "DefaultPool", ActualModel = "doubao-seed-1-8" }),
            GatewayStreamChunk.ReasoningContent("这是"),
            GatewayStreamChunk.ReasoningContent("完整的"),
            GatewayStreamChunk.ReasoningContent("回复内容。"),
            GatewayStreamChunk.Done("stop", new GatewayTokenUsage { InputTokens = 100, OutputTokens = 50 }),
        };

        var gateway = new FakeGateway(chunks);
        var client = new GatewayLLMClient(gateway, "test.chat::chat", "chat");

        var output = new List<string>();
        LLMStreamChunk? doneChunk = null;
        await foreach (var chunk in client.StreamGenerateAsync("system", new List<LLMMessage>()))
        {
            if (chunk.Type == "delta" && !string.IsNullOrEmpty(chunk.Content))
                output.Add(chunk.Content);
            if (chunk.Type == "done")
                doneChunk = chunk;
        }

        // reasoning 被当作回复输出（因为没有 content）
        var assembled = string.Join("", output);
        assembled.ShouldBe("这是完整的回复内容。");

        // token 统计正常
        doneChunk.ShouldNotBeNull();
        doneChunk!.InputTokens.ShouldBe(100);
        doneChunk.OutputTokens.ShouldBe(50);
    }

    [Fact]
    public async Task DoubaoSeed_AdapterToConsumer_FullPipeline()
    {
        // 完整管线测试：OpenAI 适配器解析 → GatewayLLMClient 智能过滤
        var adapter = new OpenAIGatewayAdapter();

        // 模拟 doubao-seed 的 SSE 事件
        var sseEvents = new[]
        {
            """{ "choices": [{ "delta": { "reasoning_content": "## 分析结果\n" } }] }""",
            """{ "choices": [{ "delta": { "reasoning_content": "1. 第一点\n" } }] }""",
            """{ "choices": [{ "delta": { "reasoning_content": "2. 第二点\n" } }] }""",
            """{ "choices": [{ "finish_reason": "stop", "delta": {} }] }""",
        };

        // 解析 SSE 事件
        var gatewayChunks = new List<GatewayStreamChunk>
        {
            GatewayStreamChunk.Start(new GatewayModelResolution { Success = true, ResolutionType = "DefaultPool", ActualModel = "doubao-seed" })
        };
        foreach (var sse in sseEvents)
        {
            var chunk = adapter.ParseStreamChunk(sse);
            if (chunk != null) gatewayChunks.Add(chunk);
        }

        // 通过 GatewayLLMClient 消费
        var gateway = new FakeGateway(gatewayChunks.ToArray());
        var client = new GatewayLLMClient(gateway, "test.chat::chat", "chat");

        var output = new List<string>();
        await foreach (var chunk in client.StreamGenerateAsync("system", new List<LLMMessage>()))
        {
            if (chunk.Type == "delta" && !string.IsNullOrEmpty(chunk.Content))
                output.Add(chunk.Content);
        }

        var assembled = string.Join("", output);
        assembled.ShouldBe("## 分析结果\n1. 第一点\n2. 第二点\n");
    }

    #endregion

    #region Edge Cases

    [Fact]
    public async Task NormalModel_NoReasoning_ShouldStreamNormally()
    {
        // 普通模型（如 GPT-4o）：没有 reasoning，直接输出 content
        var chunks = new GatewayStreamChunk[]
        {
            GatewayStreamChunk.Start(new GatewayModelResolution { Success = true, ResolutionType = "DefaultPool", ActualModel = "gpt-4o" }),
            GatewayStreamChunk.Text("你好，"),
            GatewayStreamChunk.Text("世界！"),
            GatewayStreamChunk.Done("stop", null),
        };

        var gateway = new FakeGateway(chunks);
        var client = new GatewayLLMClient(gateway, "test.chat::chat", "chat");

        var output = new List<string>();
        await foreach (var chunk in client.StreamGenerateAsync("system", new List<LLMMessage>()))
        {
            if (chunk.Type == "delta" && !string.IsNullOrEmpty(chunk.Content))
                output.Add(chunk.Content);
        }

        string.Join("", output).ShouldBe("你好，世界！");
    }

    [Fact]
    public async Task ReasoningAfterContent_ShouldBeDiscarded()
    {
        // 边界情况：content 之后又出现 reasoning（理论上不会发生，但要安全处理）
        var chunks = new GatewayStreamChunk[]
        {
            GatewayStreamChunk.Start(new GatewayModelResolution { Success = true, ResolutionType = "DefaultPool", ActualModel = "test-model" }),
            GatewayStreamChunk.Text("正文内容"),
            GatewayStreamChunk.ReasoningContent("这段 reasoning 应该被丢弃"),
            GatewayStreamChunk.Done("stop", null),
        };

        var gateway = new FakeGateway(chunks);
        var client = new GatewayLLMClient(gateway, "test.chat::chat", "chat");

        var output = new List<string>();
        await foreach (var chunk in client.StreamGenerateAsync("system", new List<LLMMessage>()))
        {
            if (chunk.Type == "delta" && !string.IsNullOrEmpty(chunk.Content))
                output.Add(chunk.Content);
        }

        string.Join("", output).ShouldBe("正文内容");
    }

    #endregion

    #region Test Helpers

    /// <summary>
    /// 假 Gateway，直接返回预设的 chunks
    /// </summary>
    private sealed class FakeGateway : ILlmGateway
    {
        private readonly GatewayStreamChunk[] _chunks;

        public FakeGateway(GatewayStreamChunk[] chunks)
        {
            _chunks = chunks;
        }

        public async IAsyncEnumerable<GatewayStreamChunk> StreamAsync(
            GatewayRequest request,
            [System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken ct = default)
        {
            foreach (var chunk in _chunks)
            {
                yield return chunk;
            }
            await Task.CompletedTask;
        }

        // 以下方法不在测试范围内
        public Task<GatewayResponse> SendAsync(GatewayRequest request, CancellationToken ct = default)
            => throw new NotImplementedException();
        public Task<GatewayRawResponse> SendRawAsync(GatewayRawRequest request, CancellationToken ct = default)
            => throw new NotImplementedException();
        public Task<GatewayModelResolution> ResolveModelAsync(string appCallerCode, string modelType, string? expectedModel = null, CancellationToken ct = default)
            => throw new NotImplementedException();
        public Task<List<AvailableModelPool>> GetAvailablePoolsAsync(string appCallerCode, string modelType, CancellationToken ct = default)
            => throw new NotImplementedException();
        public ILLMClient CreateClient(string appCallerCode, string modelType, int maxTokens = 4096, double temperature = 0.2)
            => throw new NotImplementedException();
    }

    #endregion
}
