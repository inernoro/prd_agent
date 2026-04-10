using PrdAgent.Infrastructure.Services.DocumentStore;
using Xunit;

namespace PrdAgent.Tests;

/// <summary>
/// 划词评论重锚定（rebinding）算法单元测试。
///
/// 算法在 <see cref="InlineCommentRebinder"/>：当文档正文被编辑后，
/// 基于 SelectedText + ContextBefore/After 把评论锚点重新定位到新文档。
///
/// 场景矩阵：
///   1) 文本未变     → 唯一命中，offset 不变
///   2) 前后加段落   → 唯一命中，offset 更新
///   3) 同一片段重复出现 → 用 context 消歧选正确那一个
///   4) 原片段被删除 → 返回 null（调用方标记为 orphaned）
///   5) 空输入防御
///   6) SliceAround 边界
///   7) CountMatchingChars 基本正确性
/// </summary>
public class InlineCommentRebinderTests
{
    // ─────────────────────────────────────────────
    // TryRebind 场景
    // ─────────────────────────────────────────────

    [Fact]
    public void TryRebind_UnchangedContent_ReturnsOriginalPosition()
    {
        const string content = "Hello world, this is a test document.";
        const string selected = "this is a test";
        var before = content.Substring(0, content.IndexOf(selected));
        var after = content.Substring(content.IndexOf(selected) + selected.Length);

        var result = InlineCommentRebinder.TryRebind(content, selected, before, after);

        Assert.NotNull(result);
        Assert.Equal(content.IndexOf(selected), result!.StartOffset);
        Assert.Equal(content.IndexOf(selected) + selected.Length, result.EndOffset);
    }

    [Fact]
    public void TryRebind_PrefixAdded_StillLocatesText()
    {
        // 原文：evaluate the approach
        // 新文：前面插入了一段导语
        const string selected = "evaluate the approach";
        const string origBefore = "Let us ";
        const string origAfter = " together.";
        const string newContent = "Preface paragraph inserted. Let us evaluate the approach together. More text.";

        var result = InlineCommentRebinder.TryRebind(newContent, selected, origBefore, origAfter);

        Assert.NotNull(result);
        Assert.Equal(newContent.IndexOf(selected), result!.StartOffset);
        Assert.Equal(newContent.IndexOf(selected) + selected.Length, result.EndOffset);
    }

    [Fact]
    public void TryRebind_MultipleOccurrences_PicksByContext()
    {
        // 同一片段 "critical" 出现两次：一次在代码块前，一次在代码块后
        // 原评论上下文是第二处（后面跟着 "for performance"）
        const string newContent = "This is critical. Later we say critical for performance.";
        const string selected = "critical";
        // 模拟原评论的上下文（指向第二处）
        const string origBefore = " we say ";
        const string origAfter = " for performance";

        var result = InlineCommentRebinder.TryRebind(newContent, selected, origBefore, origAfter);

        Assert.NotNull(result);
        // 第二处位置（应命中 "critical for performance" 的那个）
        var expectedStart = newContent.IndexOf("critical for performance");
        Assert.Equal(expectedStart, result!.StartOffset);
    }

    [Fact]
    public void TryRebind_MultipleOccurrences_FirstWhenContextTied()
    {
        // 两处出现，上下文都完全不匹配 → 打分都是 0，ChooseBest 选第一个（正向兜底）
        const string newContent = "aaa XYZ bbb XYZ ccc";
        const string selected = "XYZ";

        var result = InlineCommentRebinder.TryRebind(newContent, selected, "unrelated", "context");

        Assert.NotNull(result);
        Assert.Equal(newContent.IndexOf(selected), result!.StartOffset);
    }

    [Fact]
    public void TryRebind_SelectedTextDeleted_ReturnsNull()
    {
        const string newContent = "The original quote has been completely rewritten.";
        const string selected = "this quote no longer exists in the new content";

        var result = InlineCommentRebinder.TryRebind(newContent, selected, "before", "after");

        Assert.Null(result);
    }

    [Fact]
    public void TryRebind_EmptySelectedText_ReturnsNull()
    {
        var result = InlineCommentRebinder.TryRebind("any content", "", "b", "a");
        Assert.Null(result);
    }

    [Fact]
    public void TryRebind_EmptyContent_ReturnsNull()
    {
        var result = InlineCommentRebinder.TryRebind("", "anything", "b", "a");
        Assert.Null(result);
    }

    [Fact]
    public void TryRebind_ContextAtDocumentEdge_DoesNotCrash()
    {
        // selected 在文档开头：前文只有空串
        const string content = "HEAD middle tail";
        const string selected = "HEAD";

        var result = InlineCommentRebinder.TryRebind(content, selected, "", " middle");

        Assert.NotNull(result);
        Assert.Equal(0, result!.StartOffset);
        Assert.Equal(4, result.EndOffset);
        Assert.Equal("", result.ContextBefore); // 文档开头前无字符
    }

    // ─────────────────────────────────────────────
    // FindAllPositions
    // ─────────────────────────────────────────────

    [Fact]
    public void FindAllPositions_NoMatch_ReturnsEmpty()
    {
        Assert.Empty(InlineCommentRebinder.FindAllPositions("abcdef", "xyz"));
    }

    [Fact]
    public void FindAllPositions_MultipleMatches_ReturnsAll()
    {
        var positions = InlineCommentRebinder.FindAllPositions("ababab", "ab");
        Assert.Equal(new[] { 0, 2, 4 }, positions);
    }

    [Fact]
    public void FindAllPositions_OverlappingMatches_StepsByOne()
    {
        // "aaa" 中找 "aa" → 应命中位置 0 和 1
        var positions = InlineCommentRebinder.FindAllPositions("aaa", "aa");
        Assert.Equal(new[] { 0, 1 }, positions);
    }

    // ─────────────────────────────────────────────
    // SliceAround
    // ─────────────────────────────────────────────

    [Fact]
    public void SliceAround_Forward_TakesNextNChars()
    {
        Assert.Equal("world", InlineCommentRebinder.SliceAround("hello world foo", 6, 5));
    }

    [Fact]
    public void SliceAround_Backward_TakesPreviousNChars()
    {
        // 从 pos=6（"world" 前的空格位置）往前 5 字符 → "hello"
        Assert.Equal("hello", InlineCommentRebinder.SliceAround("hello world", 5, -5));
    }

    [Fact]
    public void SliceAround_ClampsToBoundaries()
    {
        // 文档很短但请求很长的切片 → 自动 clamp
        Assert.Equal("hi", InlineCommentRebinder.SliceAround("hi", 0, 100));
        Assert.Equal("hi", InlineCommentRebinder.SliceAround("hi", 2, -100));
    }

    [Fact]
    public void SliceAround_NullContent_ReturnsEmpty()
    {
        Assert.Equal("", InlineCommentRebinder.SliceAround(null!, 0, 10));
    }

    // ─────────────────────────────────────────────
    // CountMatchingChars
    // ─────────────────────────────────────────────

    [Fact]
    public void CountMatchingChars_IdenticalStrings_FullScore()
    {
        Assert.Equal(5, InlineCommentRebinder.CountMatchingChars("hello", "hello"));
    }

    [Fact]
    public void CountMatchingChars_TotallyDifferent_ZeroScore()
    {
        Assert.Equal(0, InlineCommentRebinder.CountMatchingChars("abcde", "fghij"));
    }

    [Fact]
    public void CountMatchingChars_PartialMatch_CountsAligned()
    {
        // "hello" vs "heXXo" → h(✓) e(✓) l(✗) l(✗) o(✓) = 3
        Assert.Equal(3, InlineCommentRebinder.CountMatchingChars("hello", "heXXo"));
    }

    [Fact]
    public void CountMatchingChars_DifferentLengths_UsesShorter()
    {
        // 只比较前 3 个字符
        Assert.Equal(3, InlineCommentRebinder.CountMatchingChars("abc", "abcxyz"));
    }

    [Fact]
    public void CountMatchingChars_Null_ReturnsZero()
    {
        Assert.Equal(0, InlineCommentRebinder.CountMatchingChars(null!, "abc"));
        Assert.Equal(0, InlineCommentRebinder.CountMatchingChars("abc", null!));
    }
}
