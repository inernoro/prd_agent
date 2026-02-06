using System.Text.Json;
using PrdAgent.Infrastructure.LLM;
using PrdAgent.Infrastructure.LlmGateway;
using PrdAgent.Infrastructure.LlmGateway.Adapters;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

/// <summary>
/// 思考内容过滤测试
/// 验证 Claude thinking_delta 和 DeepSeek reasoning_content 不会泄漏到用户输出
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
        // Arrange - 正常的 text_delta 事件
        var adapter = new ClaudeGatewayAdapter();
        var sseData = """
        {
            "type": "content_block_delta",
            "index": 0,
            "delta": { "type": "text_delta", "text": "你好世界" }
        }
        """;

        // Act
        var chunk = adapter.ParseStreamChunk(sseData);

        // Assert
        chunk.ShouldNotBeNull();
        chunk.Type.ShouldBe(GatewayChunkType.Text);
        chunk.Content.ShouldBe("你好世界");
    }

    [Fact]
    public void Claude_ThinkingDelta_ShouldBeFiltered()
    {
        // Arrange - thinking_delta 事件（必须被过滤）
        var adapter = new ClaudeGatewayAdapter();
        var sseData = """
        {
            "type": "content_block_delta",
            "index": 0,
            "delta": { "type": "thinking_delta", "thinking": "让我分析一下这个问题..." }
        }
        """;

        // Act
        var chunk = adapter.ParseStreamChunk(sseData);

        // Assert - thinking 内容不应产生任何输出
        chunk.ShouldBeNull();
    }

    [Fact]
    public void Claude_ThinkingDelta_WithTextFieldToo_ShouldBeFiltered()
    {
        // Arrange - 某些代理可能在 thinking_delta 中也带 text 字段
        var adapter = new ClaudeGatewayAdapter();
        var sseData = """
        {
            "type": "content_block_delta",
            "index": 0,
            "delta": { "type": "thinking_delta", "text": "这不应该输出", "thinking": "思考过程..." }
        }
        """;

        // Act
        var chunk = adapter.ParseStreamChunk(sseData);

        // Assert - 即使有 text 字段，thinking_delta 也不应产生输出
        chunk.ShouldBeNull();
    }

    [Fact]
    public void Claude_DeltaWithoutType_ShouldBeFiltered()
    {
        // Arrange - delta 缺少 type 字段
        var adapter = new ClaudeGatewayAdapter();
        var sseData = """
        {
            "type": "content_block_delta",
            "index": 0,
            "delta": { "text": "缺少 type 的 delta" }
        }
        """;

        // Act
        var chunk = adapter.ParseStreamChunk(sseData);

        // Assert - 缺少 type 字段应该被过滤（安全优先）
        chunk.ShouldBeNull();
    }

    [Fact]
    public void Claude_MessageStop_ShouldStillWork()
    {
        // Arrange - 回归：确保非 delta 事件不受影响
        var adapter = new ClaudeGatewayAdapter();
        var sseData = """{ "type": "message_stop" }""";

        // Act
        var chunk = adapter.ParseStreamChunk(sseData);

        // Assert
        chunk.ShouldNotBeNull();
        chunk.Type.ShouldBe(GatewayChunkType.Done);
    }

    [Fact]
    public void Claude_MessageDelta_WithUsage_ShouldStillWork()
    {
        // Arrange - 回归：message_delta 带 usage 和 stop_reason
        var adapter = new ClaudeGatewayAdapter();
        var sseData = """
        {
            "type": "message_delta",
            "delta": { "stop_reason": "end_turn" },
            "usage": { "output_tokens": 150 }
        }
        """;

        // Act
        var chunk = adapter.ParseStreamChunk(sseData);

        // Assert
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
        // Arrange - 其他非 text_delta 类型也不应泄漏
        var adapter = new ClaudeGatewayAdapter();
        var sseData = $$"""
        {
            "type": "content_block_delta",
            "index": 0,
            "delta": { "type": "{{deltaType}}", "text": "不应该输出" }
        }
        """;

        // Act
        var chunk = adapter.ParseStreamChunk(sseData);

        // Assert
        chunk.ShouldBeNull();
    }

    #endregion

    #region OpenAIGatewayAdapter Tests

    [Fact]
    public void OpenAI_NormalContent_ShouldReturnContent()
    {
        // Arrange - 正常的 content 字段
        var adapter = new OpenAIGatewayAdapter();
        var sseData = """
        {
            "choices": [{
                "delta": { "content": "正常回复内容" }
            }]
        }
        """;

        // Act
        var chunk = adapter.ParseStreamChunk(sseData);

        // Assert
        chunk.ShouldNotBeNull();
        chunk.Type.ShouldBe(GatewayChunkType.Text);
        chunk.Content.ShouldBe("正常回复内容");
    }

    [Fact]
    public void OpenAI_ReasoningContent_ShouldBeFiltered()
    {
        // Arrange - DeepSeek 的 reasoning_content（思考过程，不应输出）
        var adapter = new OpenAIGatewayAdapter();
        var sseData = """
        {
            "choices": [{
                "delta": { "reasoning_content": "让我仔细想想这个问题的解法..." }
            }]
        }
        """;

        // Act
        var chunk = adapter.ParseStreamChunk(sseData);

        // Assert - reasoning_content 不应产生输出
        chunk.ShouldBeNull();
    }

    [Fact]
    public void OpenAI_ReasoningContentOnly_NoContent_ShouldBeFiltered()
    {
        // Arrange - DeepSeek R1 典型场景：只有 reasoning_content，没有 content
        var adapter = new OpenAIGatewayAdapter();
        var sseData = """
        {
            "choices": [{
                "delta": { "reasoning_content": "step 1: 分析问题\nstep 2: 推理过程" }
            }]
        }
        """;

        // Act
        var chunk = adapter.ParseStreamChunk(sseData);

        // Assert
        chunk.ShouldBeNull();
    }

    [Fact]
    public void OpenAI_ContentAndReasoning_ShouldOnlyReturnContent()
    {
        // Arrange - 同时有 content 和 reasoning_content
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

        // Act
        var chunk = adapter.ParseStreamChunk(sseData);

        // Assert - 只返回正式 content
        chunk.ShouldNotBeNull();
        chunk.Content.ShouldBe("最终答案");
    }

    [Fact]
    public void OpenAI_EmptyContentWithReasoning_ShouldBeFiltered()
    {
        // Arrange - content 为空字符串 + reasoning_content 有值
        // 修复前这里会回退到 reasoning_content
        var adapter = new OpenAIGatewayAdapter();
        var sseData = """
        {
            "choices": [{
                "delta": {
                    "content": "",
                    "reasoning_content": "不应该被当作正文"
                }
            }]
        }
        """;

        // Act
        var chunk = adapter.ParseStreamChunk(sseData);

        // Assert - 空 content 不应回退到 reasoning_content
        chunk.ShouldBeNull();
    }

    [Fact]
    public void OpenAI_FinishReason_ShouldStillWork()
    {
        // Arrange - 回归：finish_reason 事件不受影响
        var adapter = new OpenAIGatewayAdapter();
        var sseData = """
        {
            "choices": [{
                "finish_reason": "stop",
                "delta": {}
            }]
        }
        """;

        // Act
        var chunk = adapter.ParseStreamChunk(sseData);

        // Assert
        chunk.ShouldNotBeNull();
        chunk.Type.ShouldBe(GatewayChunkType.Done);
        chunk.FinishReason.ShouldBe("stop");
    }

    [Fact]
    public void OpenAI_UsageChunk_ShouldStillWork()
    {
        // Arrange - 回归：usage 事件不受影响
        var adapter = new OpenAIGatewayAdapter();
        var sseData = """
        {
            "usage": { "prompt_tokens": 100, "completion_tokens": 200 }
        }
        """;

        // Act
        var chunk = adapter.ParseStreamChunk(sseData);

        // Assert
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
        // Arrange - 验证 ClaudeDelta 的 Type 字段能正确反序列化
        var json = """
        {
            "type": "content_block_delta",
            "delta": { "type": "text_delta", "text": "hello" }
        }
        """;

        // Act
        var evt = JsonSerializer.Deserialize(json, LLMJsonContext.Default.ClaudeStreamEvent);

        // Assert
        evt.ShouldNotBeNull();
        evt!.Type.ShouldBe("content_block_delta");
        evt.Delta.ShouldNotBeNull();
        evt.Delta!.Type.ShouldBe("text_delta");
        evt.Delta.Text.ShouldBe("hello");
    }

    [Fact]
    public void ClaudeDelta_ThinkingDelta_ShouldDeserializeWithNullText()
    {
        // Arrange - thinking_delta 没有 text 字段，只有 thinking 字段
        var json = """
        {
            "type": "content_block_delta",
            "delta": { "type": "thinking_delta", "thinking": "let me think..." }
        }
        """;

        // Act
        var evt = JsonSerializer.Deserialize(json, LLMJsonContext.Default.ClaudeStreamEvent);

        // Assert
        evt.ShouldNotBeNull();
        evt!.Delta.ShouldNotBeNull();
        evt.Delta!.Type.ShouldBe("thinking_delta");
        evt.Delta.Text.ShouldBeNull(); // thinking 字段不映射到 Text
    }

    [Fact]
    public void ClaudeDelta_TextDelta_TypeCheckPreventsThinkingLeak()
    {
        // Arrange - 模拟 ClaudeClient 中的过滤逻辑
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

        // Act - 模拟 ClaudeClient.StreamGenerateAsync 中的过滤条件
        var textEvt = JsonSerializer.Deserialize(textJson, LLMJsonContext.Default.ClaudeStreamEvent);
        var thinkingEvt = JsonSerializer.Deserialize(thinkingJson, LLMJsonContext.Default.ClaudeStreamEvent);

        bool textPasses = textEvt?.Type == "content_block_delta"
                          && textEvt.Delta?.Type == "text_delta"
                          && textEvt.Delta?.Text != null;

        bool thinkingPasses = thinkingEvt?.Type == "content_block_delta"
                              && thinkingEvt.Delta?.Type == "text_delta"
                              && thinkingEvt.Delta?.Text != null;

        // Assert
        textPasses.ShouldBeTrue("text_delta 应该通过过滤");
        thinkingPasses.ShouldBeFalse("thinking_delta 不应通过过滤");
    }

    #endregion

    #region End-to-End Simulation: Claude Extended Thinking

    [Fact]
    public void Claude_ExtendedThinking_FullStream_OnlyTextShouldPass()
    {
        // 模拟完整的 Claude Extended Thinking 流
        // 真实场景：先输出 thinking blocks，再输出 text blocks
        var adapter = new ClaudeGatewayAdapter();

        var sseEvents = new[]
        {
            // 1. message_start
            """{ "type": "message_start", "message": { "usage": { "input_tokens": 50 } } }""",

            // 2. content_block_start (thinking)
            """{ "type": "content_block_start", "index": 0, "content_block": { "type": "thinking", "thinking": "" } }""",

            // 3. thinking_delta chunks (思考过程)
            """{ "type": "content_block_delta", "index": 0, "delta": { "type": "thinking_delta", "thinking": "首先分析问题的要求，" } }""",
            """{ "type": "content_block_delta", "index": 0, "delta": { "type": "thinking_delta", "thinking": "然后逐步推理出解决方案..." } }""",

            // 4. content_block_stop (thinking)
            """{ "type": "content_block_stop", "index": 0 }""",

            // 5. content_block_start (text)
            """{ "type": "content_block_start", "index": 1, "content_block": { "type": "text", "text": "" } }""",

            // 6. text_delta chunks (正文 — 只有这些应该输出)
            """{ "type": "content_block_delta", "index": 1, "delta": { "type": "text_delta", "text": "根据分析，" } }""",
            """{ "type": "content_block_delta", "index": 1, "delta": { "type": "text_delta", "text": "答案是42。" } }""",

            // 7. content_block_stop (text)
            """{ "type": "content_block_stop", "index": 1 }""",

            // 8. message_delta (done)
            """{ "type": "message_delta", "delta": { "stop_reason": "end_turn" }, "usage": { "output_tokens": 200 } }""",

            // 9. message_stop
            """{ "type": "message_stop" }""",
        };

        // Act - 收集所有 Text 类型的 chunk
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

        // Assert
        var assembled = string.Join("", textChunks);
        assembled.ShouldBe("根据分析，答案是42。");

        // 确保没有思考内容泄漏
        assembled.ShouldNotContain("首先分析");
        assembled.ShouldNotContain("逐步推理");

        // 确保 Done 事件正常
        allChunks.ShouldContain(c => c.Type == GatewayChunkType.Done);
    }

    #endregion

    #region End-to-End Simulation: DeepSeek R1

    [Fact]
    public void DeepSeek_R1_FullStream_OnlyContentShouldPass()
    {
        // 模拟完整的 DeepSeek R1 流
        // 真实场景：先输出 reasoning_content，再输出 content
        var adapter = new OpenAIGatewayAdapter();

        var sseEvents = new[]
        {
            // 1. reasoning_content 阶段（思考过程）
            """{ "choices": [{ "delta": { "reasoning_content": "好的，让我分析一下这个问题。" } }] }""",
            """{ "choices": [{ "delta": { "reasoning_content": "首先需要考虑边界条件..." } }] }""",
            """{ "choices": [{ "delta": { "reasoning_content": "综合以上分析，结论是..." } }] }""",

            // 2. content 阶段（正文 — 只有这些应该输出）
            """{ "choices": [{ "delta": { "content": "经过分析，" } }] }""",
            """{ "choices": [{ "delta": { "content": "最终结论是：可行。" } }] }""",

            // 3. 结束
            """{ "choices": [{ "finish_reason": "stop", "delta": {} }] }""",
        };

        // Act
        var textChunks = new List<string>();

        foreach (var sse in sseEvents)
        {
            var chunk = adapter.ParseStreamChunk(sse);
            if (chunk?.Type == GatewayChunkType.Text && !string.IsNullOrEmpty(chunk.Content))
            {
                textChunks.Add(chunk.Content);
            }
        }

        // Assert
        var assembled = string.Join("", textChunks);
        assembled.ShouldBe("经过分析，最终结论是：可行。");

        // 确保没有思考内容泄漏
        assembled.ShouldNotContain("让我分析");
        assembled.ShouldNotContain("边界条件");
        assembled.ShouldNotContain("综合以上");
    }

    #endregion
}
