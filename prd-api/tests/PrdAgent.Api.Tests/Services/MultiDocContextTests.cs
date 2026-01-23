using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Prompts;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

/// <summary>
/// 多文档上下文注入测试：验证 PromptManager.BuildMultiDocContextMessage 正确拼接知识库文档内容。
/// </summary>
public class MultiDocContextTests
{
    private readonly PromptManager _promptManager;

    public MultiDocContextTests()
    {
        _promptManager = new PromptManager();
    }

    [Fact]
    public void BuildMultiDocContextMessage_EmptyDocList_ReturnsEmpty()
    {
        var result = _promptManager.BuildMultiDocContextMessage(new List<KbDocument>());
        Assert.Equal(string.Empty, result);
    }

    [Fact]
    public void BuildMultiDocContextMessage_SingleDocument_WrapsInKbMarkers()
    {
        var docs = new List<KbDocument>
        {
            new()
            {
                DocumentId = "doc1",
                FileName = "prd.md",
                TextContent = "# 产品需求文档\n\n## 概述\n\n这是一个测试文档。"
            }
        };

        var result = _promptManager.BuildMultiDocContextMessage(docs);

        Assert.Contains("[[CONTEXT:KB]]", result);
        Assert.Contains("[[/CONTEXT:KB]]", result);
        Assert.Contains("<KB_DOC name=\"prd.md\">", result);
        Assert.Contains("</KB_DOC>", result);
        Assert.Contains("# 产品需求文档", result);
        Assert.Contains("这是一个测试文档。", result);
    }

    [Fact]
    public void BuildMultiDocContextMessage_MultipleDocuments_IncludesAll()
    {
        var docs = new List<KbDocument>
        {
            new() { DocumentId = "doc1", FileName = "需求文档.md", TextContent = "# 需求\n\n核心需求描述" },
            new() { DocumentId = "doc2", FileName = "技术方案.pdf", TextContent = "# 技术方案\n\n架构设计" },
            new() { DocumentId = "doc3", FileName = "测试计划.md", TextContent = "# 测试计划\n\n测试用例" }
        };

        var result = _promptManager.BuildMultiDocContextMessage(docs);

        // 所有文档都应该被包含
        Assert.Contains("<KB_DOC name=\"需求文档.md\">", result);
        Assert.Contains("<KB_DOC name=\"技术方案.pdf\">", result);
        Assert.Contains("<KB_DOC name=\"测试计划.md\">", result);
        Assert.Contains("核心需求描述", result);
        Assert.Contains("架构设计", result);
        Assert.Contains("测试用例", result);

        // 只有一对外层标记
        Assert.Equal(1, CountOccurrences(result, "[[CONTEXT:KB]]"));
        Assert.Equal(1, CountOccurrences(result, "[[/CONTEXT:KB]]"));

        // 三个文档标记
        Assert.Equal(3, CountOccurrences(result, "<KB_DOC name="));
        Assert.Equal(3, CountOccurrences(result, "</KB_DOC>"));
    }

    [Fact]
    public void BuildMultiDocContextMessage_NullTextContent_SkipsDocument()
    {
        var docs = new List<KbDocument>
        {
            new() { DocumentId = "doc1", FileName = "valid.md", TextContent = "有效内容" },
            new() { DocumentId = "doc2", FileName = "empty.pdf", TextContent = null },
            new() { DocumentId = "doc3", FileName = "whitespace.md", TextContent = "   " }
        };

        var result = _promptManager.BuildMultiDocContextMessage(docs);

        // null TextContent 的文档应被跳过
        Assert.Contains("<KB_DOC name=\"valid.md\">", result);
        Assert.DoesNotContain("<KB_DOC name=\"empty.pdf\">", result);
        // 空白 TextContent 也应被跳过
        Assert.DoesNotContain("<KB_DOC name=\"whitespace.md\">", result);
    }

    [Fact]
    public void BuildMultiDocContextMessage_AllNullContent_ReturnsMarkersOnly()
    {
        var docs = new List<KbDocument>
        {
            new() { DocumentId = "doc1", FileName = "a.pdf", TextContent = null },
            new() { DocumentId = "doc2", FileName = "b.pdf", TextContent = null }
        };

        var result = _promptManager.BuildMultiDocContextMessage(docs);

        // 仍包含外层标记
        Assert.Contains("[[CONTEXT:KB]]", result);
        Assert.Contains("[[/CONTEXT:KB]]", result);
        // 但没有文档内容
        Assert.DoesNotContain("<KB_DOC", result);
    }

    [Fact]
    public void BuildMultiDocContextMessage_SpecialCharsInFileName_PreservedInOutput()
    {
        var docs = new List<KbDocument>
        {
            new()
            {
                DocumentId = "doc1",
                FileName = "2025-01-23_PRD v2.0 (修订).md",
                TextContent = "内容"
            }
        };

        var result = _promptManager.BuildMultiDocContextMessage(docs);

        Assert.Contains("2025-01-23_PRD v2.0 (修订).md", result);
    }

    [Fact]
    public void BuildMultiDocContextMessage_LargeDocument_PreservesFullContent()
    {
        // 模拟大文档（100k 字符）
        var largeContent = new string('测', 50000) + new string('试', 50000);
        var docs = new List<KbDocument>
        {
            new() { DocumentId = "doc1", FileName = "large.md", TextContent = largeContent }
        };

        var result = _promptManager.BuildMultiDocContextMessage(docs);

        // 完整内容应被保留（BuildMultiDocContextMessage 不做截断，截断由调用方控制）
        Assert.Contains(largeContent, result);
    }

    [Fact]
    public void BuildMultiDocContextMessage_OrderPreserved()
    {
        var docs = new List<KbDocument>
        {
            new() { DocumentId = "doc1", FileName = "first.md", TextContent = "FIRST_MARKER" },
            new() { DocumentId = "doc2", FileName = "second.md", TextContent = "SECOND_MARKER" },
            new() { DocumentId = "doc3", FileName = "third.md", TextContent = "THIRD_MARKER" }
        };

        var result = _promptManager.BuildMultiDocContextMessage(docs);

        var firstIdx = result.IndexOf("FIRST_MARKER", StringComparison.Ordinal);
        var secondIdx = result.IndexOf("SECOND_MARKER", StringComparison.Ordinal);
        var thirdIdx = result.IndexOf("THIRD_MARKER", StringComparison.Ordinal);

        Assert.True(firstIdx < secondIdx, "First document should appear before second");
        Assert.True(secondIdx < thirdIdx, "Second document should appear before third");
    }

    [Fact]
    public void BuildMultiDocContextMessage_StructureFormat()
    {
        var docs = new List<KbDocument>
        {
            new() { DocumentId = "doc1", FileName = "test.md", TextContent = "Hello World" }
        };

        var result = _promptManager.BuildMultiDocContextMessage(docs);
        var lines = result.Split('\n');

        // 第一行应该是 [[CONTEXT:KB]]
        Assert.Equal("[[CONTEXT:KB]]", lines[0]);
        // 最后非空行应该是 [[/CONTEXT:KB]]
        var lastNonEmpty = lines.Last(l => !string.IsNullOrWhiteSpace(l));
        Assert.Equal("[[/CONTEXT:KB]]", lastNonEmpty);
    }

    [Fact]
    public void CombinedContent_ForChatService_ConcatenatesTextContent()
    {
        // 测试 ChatService 中的 combinedContent 拼接逻辑
        var kbDocuments = new List<KbDocument>
        {
            new() { TextContent = "文档A的内容" },
            new() { TextContent = null }, // 应被过滤
            new() { TextContent = "文档B的内容" },
            new() { TextContent = "文档C的内容" }
        };

        // 模拟 ChatService 中的 combinedContent 计算
        var combinedContent = string.Join("\n", kbDocuments
            .Where(d => d.TextContent != null)
            .Select(d => d.TextContent!));

        Assert.Equal("文档A的内容\n文档B的内容\n文档C的内容", combinedContent);
        Assert.DoesNotContain("null", combinedContent);
    }

    [Fact]
    public void CombinedContent_ForPreviewAsk_JoinsWithDoubleNewline()
    {
        // 测试 PreviewAskService 中的 raw 拼接逻辑
        var kbDocs = new List<KbDocument>
        {
            new() { TextContent = "# 文档1\n\n第一段内容" },
            new() { TextContent = null },
            new() { TextContent = "# 文档2\n\n第二段内容" }
        };

        var raw = string.Join("\n\n", kbDocs
            .Where(d => d.TextContent != null)
            .Select(d => d.TextContent!));

        Assert.Equal("# 文档1\n\n第一段内容\n\n# 文档2\n\n第二段内容", raw);
    }

    #region Helpers

    private static int CountOccurrences(string source, string pattern)
    {
        int count = 0, index = 0;
        while ((index = source.IndexOf(pattern, index, StringComparison.Ordinal)) != -1)
        {
            count++;
            index += pattern.Length;
        }
        return count;
    }

    #endregion
}
