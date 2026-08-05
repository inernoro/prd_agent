using PrdAgent.Infrastructure.Services.ChatAgent;
using Xunit;

namespace PrdAgent.Tests;

/// <summary>
/// 通用对话工具卡的展示判据守卫（纯单元，CI 默认执行）。
///
/// 这三条判据的共同点：删掉之后功能不报错、编译不红、页面照样出卡，
/// 只是卡上的字全错——失败画成完成、每把工具都叫「工具」。
/// 所以必须有断言盯着，不能靠通读。
/// </summary>
public class ChatAgentToolPresentationTests
{
    /// <summary>
    /// 官方 SDK 通过内置 MCP server 暴露我们的工具，回传的名字带 mcp__map__ 前缀。
    /// 不剥前缀，标签与阶段就会全部落进兜底分支。
    /// </summary>
    [Theory]
    [InlineData("mcp__map__chat_generate_image", "chat_generate_image")]
    [InlineData("mcp__map__kb_search", "kb_search")]
    [InlineData("chat_save_note", "chat_save_note")]
    [InlineData("Read", "Read")]
    [InlineData(null, null)]
    public void NormalizeToolName_ShouldStripMcpServerPrefix(string? raw, string? expected)
    {
        Assert.Equal(expected, ChatAgentToolPresentation.NormalizeToolName(raw));
    }

    /// <summary>带前缀的名字也必须命中人话标签与多阶段，而不是「工具 · 执行」。</summary>
    [Fact]
    public void ToolLabelAndSteps_ShouldResolvePrefixedNames()
    {
        Assert.Equal("生成图片", ChatAgentToolPresentation.ToolLabel("mcp__map__chat_generate_image"));
        Assert.Equal("写入知识库", ChatAgentToolPresentation.ToolLabel("mcp__map__chat_save_note"));
        Assert.Equal(3, ChatAgentToolPresentation.ToolSteps("mcp__map__chat_generate_image").Length);
        Assert.Equal(new[] { "执行" }, ChatAgentToolPresentation.ToolSteps("mcp__map__unknown_tool"));
    }

    /// <summary>
    /// 工具桥失败时回传的是一句纯文本原因，不是带 success 字段的 JSON。
    /// 成败只能认运行时给的 is_error——嗅 content 的写法在这条用例上必红。
    /// </summary>
    [Fact]
    public void BuildToolCardPayload_ShouldMarkFailure_WhenRuntimeFlagsError()
    {
        var payload = ChatAgentToolPresentation.BuildToolCardPayload(
            "mcp__map__chat_save_note",
            "toolu_1",
            "callback HTTP 500: knowledge base unavailable",
            isError: true);

        Assert.False(payload.Ok);
        Assert.Equal("chat_save_note", payload.Tool);
        Assert.Equal("写入知识库", payload.Label);
        Assert.Equal("callback HTTP 500: knowledge base unavailable", payload.Message);
        Assert.Null(payload.EntryId);
    }

    /// <summary>成功时产物字段照常透出，失败标记为假不得误伤。</summary>
    [Fact]
    public void BuildToolCardPayload_ShouldCarryArtifacts_WhenSucceeded()
    {
        var payload = ChatAgentToolPresentation.BuildToolCardPayload(
            "mcp__map__chat_save_note",
            "toolu_2",
            """{"entryId":"e1","storeName":"对话笔记","openPath":"/document-store/e1","title":"会议纪要"}""",
            isError: false);

        Assert.True(payload.Ok);
        Assert.Equal("e1", payload.EntryId);
        Assert.Equal("对话笔记", payload.StoreName);
        Assert.Equal("/document-store/e1", payload.OpenPath);
        Assert.Equal("会议纪要", payload.Title);
    }

    /// <summary>检索命中数翻成人话，且 is_error 缺失时不臆造失败。</summary>
    [Fact]
    public void BuildToolCardPayload_ShouldSummarizeSearch_WhenErrorFlagMissing()
    {
        var payload = ChatAgentToolPresentation.BuildToolCardPayload(
            "mcp__map__kb_search", "toolu_3", """{"total":4,"items":[]}""", isError: null);

        Assert.True(payload.Ok);
        Assert.Equal("命中 4 条", payload.Message);
        Assert.Equal("检索知识库", payload.Label);
    }

    /// <summary>失败原因是长堆栈时截断，别把整段异常糊到卡上。</summary>
    [Fact]
    public void BuildToolCardPayload_ShouldTruncateLongFailureReason()
    {
        var payload = ChatAgentToolPresentation.BuildToolCardPayload(
            "chat_generate_image", "toolu_4", new string('x', 500), isError: true);

        Assert.False(payload.Ok);
        Assert.Equal(201, payload.Message!.Length);
        Assert.EndsWith("…", payload.Message);
    }
}
