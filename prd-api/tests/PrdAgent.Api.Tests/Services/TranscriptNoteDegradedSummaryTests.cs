using PrdAgent.Api.Services;
using PrdAgent.Core.Models;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

/// <summary>
/// 「整理没生成」这件事必须留在笔记里。
///
/// 2026-08-29 用户当天两条录音都是这样丢的：点了整理，摘要生成失败，
/// 笔记照样落库、摘要那一节**整个不渲染**、页面上没有任何提示。
/// SSE 上那个 summaryError 事件只有此刻正盯着页面的人收得到；
/// 用户离开再回来，看到的就是一篇没有摘要、也没有任何解释的笔记——
/// 他只会以为「这功能就是这样」，而不知道自己点的那一下失败过。
/// </summary>
public class TranscriptNoteDegradedSummaryTests
{
    private static readonly IReadOnlyList<SubtitleSegment> Segments =
    [
        new SubtitleSegment(0, 2.5, "一开始就有那个协议。"),
    ];

    [Fact]
    public void SummaryFailed_ShouldExplainInsteadOfLeavingTheSectionOut()
    {
        var note = SubtitleFormatter.FormatTranscriptNote(
            "录音 2026-08-29 15-34.m4a",
            summary: "",
            Segments,
            summaryUnavailableNote: "这次整理没有生成出来。转录原文已完整保存，可以在这条笔记上重新整理。");

        note.ShouldContain(TranscribeNoteText.SummaryUnavailableMarker);
        note.ShouldContain("这次整理没有生成出来");
        note.ShouldContain("一开始就有那个协议。");
        // 关键：不能落进「## 摘要」——前端判「纪要已就绪」只看那一节非不非空，
        // 写进去就会让绿色完成卡和正文里的「没生成出来」互相打脸。
        note.ShouldNotContain("## 摘要");
    }

    /// <summary>
    /// 失败之后重新整理成功，笔记里不能同时挂着「整理未生成」和一份真摘要。
    /// </summary>
    [Fact]
    public void RestyleAfterFailure_ShouldClearTheUnavailableSection()
    {
        var failed = SubtitleFormatter.FormatTranscriptNote(
            "录音 2026-08-29 15-34.m4a",
            summary: "",
            Segments,
            summaryUnavailableNote: "这次整理没有生成出来。转录原文已完整保存，可以在这条笔记上重新整理。");

        var retried = TranscribeNoteText.ReplaceSummarySection(failed, "# 会议纪要\n\n## 关键结论\n- 共同遵循协议");

        retried.ShouldContain("## 摘要");
        retried.ShouldContain("关键结论");
        retried.ShouldNotContain(TranscribeNoteText.SummaryUnavailableMarker);
        retried.ShouldNotContain("这次整理没有生成出来");
        retried.ShouldContain("一开始就有那个协议。");
    }

    /// <summary>没点整理的录音（默认只转写）不该凭空多出一个摘要小节。</summary>
    [Fact]
    public void NoSummaryRequested_ShouldStillOmitTheSection()
    {
        var note = SubtitleFormatter.FormatTranscriptNote(
            "录音 2026-08-29 15-34.m4a",
            summary: "",
            Segments);

        note.ShouldNotContain("## 摘要");
    }

    /// <summary>整理成功时照旧渲染整理结果，解释文案不该挤进来。</summary>
    [Fact]
    public void SummarySucceeded_ShouldRenderTheSummary()
    {
        var note = SubtitleFormatter.FormatTranscriptNote(
            "录音 2026-08-29 15-34.m4a",
            summary: "# 会议纪要\n\n## 关键结论\n- 共同遵循协议",
            Segments,
            summaryUnavailableNote: "这次整理没有生成出来。");

        note.ShouldContain("关键结论");
        note.ShouldNotContain("这次整理没有生成出来");
    }
}
