using System.Text.Json;
using PrdAgent.Infrastructure.LLM;
using PrdAgent.Infrastructure.LlmGateway;
using PrdAgent.Infrastructure.LlmGateway.Adapters;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

/// <summary>
/// 思考内容过滤测试
/// - Claude: thinking_delta 在适配器层过滤，只输出 text_delta
/// - OpenAI 兼容模型: reasoning_content 直接透传为正文，不干预模型输出
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
    public void OpenAI_ReasoningContent_ShouldPassThrough()
    {
        // reasoning_content 直接透传为 Text，不干预模型输出
        var adapter = new OpenAIGatewayAdapter();
        var sseData = """
        {
            "choices": [{
                "delta": { "reasoning_content": "推理过程直接输出" }
            }]
        }
        """;

        var chunk = adapter.ParseStreamChunk(sseData);

        chunk.ShouldNotBeNull();
        chunk.Type.ShouldBe(GatewayChunkType.Text);
        chunk.Content.ShouldBe("推理过程直接输出");
    }

    [Fact]
    public void OpenAI_ContentAndReasoning_ShouldPreferContent()
    {
        // 同时有 content 和 reasoning_content 时，优先使用 content
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
    public void OpenAI_EmptyContentWithReasoning_ShouldUseReasoning()
    {
        // content 为空字符串时回退到 reasoning_content
        var adapter = new OpenAIGatewayAdapter();
        var sseData = """
        {
            "choices": [{
                "delta": {
                    "content": "",
                    "reasoning_content": "回退到推理内容"
                }
            }]
        }
        """;

        var chunk = adapter.ParseStreamChunk(sseData);

        chunk.ShouldNotBeNull();
        chunk.Type.ShouldBe(GatewayChunkType.Text);
        chunk.Content.ShouldBe("回退到推理内容");
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
        evt!.Delta.ShouldNotBeNull();
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

    #region End-to-End: Claude Extended Thinking

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

        foreach (var sse in sseEvents)
        {
            var chunk = adapter.ParseStreamChunk(sse);
            if (chunk?.Type == GatewayChunkType.Text && !string.IsNullOrEmpty(chunk.Content))
                textChunks.Add(chunk.Content);
        }

        var assembled = string.Join("", textChunks);
        assembled.ShouldBe("根据分析，答案是42。");
        assembled.ShouldNotContain("首先分析");
        assembled.ShouldNotContain("逐步推理");
    }

    #endregion

    #region End-to-End: OpenAI Reasoning Models (passthrough)

    [Fact]
    public void DeepSeek_R1_FullStream_AllContentPassedThrough()
    {
        // OpenAI 兼容模型的 reasoning_content 直接透传
        var adapter = new OpenAIGatewayAdapter();

        var sseEvents = new[]
        {
            """{ "choices": [{ "delta": { "reasoning_content": "好的，让我分析。" } }] }""",
            """{ "choices": [{ "delta": { "reasoning_content": "考虑边界条件..." } }] }""",
            """{ "choices": [{ "delta": { "content": "经过分析，" } }] }""",
            """{ "choices": [{ "delta": { "content": "结论是可行。" } }] }""",
            """{ "choices": [{ "finish_reason": "stop", "delta": {} }] }""",
        };

        var allText = new List<string>();
        foreach (var sse in sseEvents)
        {
            var chunk = adapter.ParseStreamChunk(sse);
            if (chunk?.Type == GatewayChunkType.Text && !string.IsNullOrEmpty(chunk.Content))
                allText.Add(chunk.Content);
        }

        // reasoning_content 和 content 都透传
        var assembled = string.Join("", allText);
        assembled.ShouldBe("好的，让我分析。考虑边界条件...经过分析，结论是可行。");
    }

    [Fact]
    public void DoubaoSeed_ReasoningOnly_ShouldPassThrough()
    {
        // doubao-seed: 所有输出走 reasoning_content，直接透传
        var adapter = new OpenAIGatewayAdapter();

        var sseEvents = new[]
        {
            """{ "choices": [{ "delta": { "reasoning_content": "## 分析结果\n" } }] }""",
            """{ "choices": [{ "delta": { "reasoning_content": "1. 第一点\n" } }] }""",
            """{ "choices": [{ "delta": { "reasoning_content": "2. 第二点\n" } }] }""",
            """{ "choices": [{ "finish_reason": "stop", "delta": {} }] }""",
        };

        var allText = new List<string>();
        foreach (var sse in sseEvents)
        {
            var chunk = adapter.ParseStreamChunk(sse);
            if (chunk?.Type == GatewayChunkType.Text && !string.IsNullOrEmpty(chunk.Content))
                allText.Add(chunk.Content);
        }

        var assembled = string.Join("", allText);
        assembled.ShouldBe("## 分析结果\n1. 第一点\n2. 第二点\n");
    }

    #endregion
}
