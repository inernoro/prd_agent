using PrdAgent.Core.Models;
using Xunit;

namespace PrdAgent.Tests;

/// <summary>
/// 录音转笔记纯文本函数的单测：静音/拒答判定、摘要节替换、转录全文反解、风格化提示词组装。
/// 对应真实事故（2026-07-12）：静音录音喂给多模态转写模型，模型回答
/// "好的，请播放音频，我会逐字转写。"，该句被当成转录全文存进笔记。
/// </summary>
public class TranscribeNoteTextTests
{
    // ── LooksLikeNoSpeech ──

    [Theory]
    [InlineData("好的，请播放音频，我会逐字转写。")]
    [InlineData("NO_SPEECH")]
    [InlineData("好的，NO_SPEECH")]
    [InlineData("请提供音频文件。")]
    [InlineData("我没有听到任何内容")]
    [InlineData("谢谢观看")]
    public void LooksLikeNoSpeech_拒答与哨兵_判定为无语音(string transcript)
    {
        Assert.True(TranscribeNoteText.LooksLikeNoSpeech(transcript));
    }

    [Theory]
    [InlineData("明天上午十点开产品评审会，记得带上原型稿。")]
    [InlineData("买牛奶")]
    // 超过 40 字的真实内容即使包含敏感词也不误伤
    [InlineData("会上老板说请播放上次的演示视频，然后大家讨论了第三季度的目标和预算分配，最后定了三条待办。")]
    public void LooksLikeNoSpeech_真实语音_不误伤(string transcript)
    {
        Assert.False(TranscribeNoteText.LooksLikeNoSpeech(transcript));
    }

    // ── ReplaceSummarySection ──

    private const string Note =
        "# 录音 2026-07-12 · 转录笔记\n> 来源：录音 2026-07-12.webm · 生成时间：2026-07-12 10:00\n\n" +
        "## 摘要\n\n旧摘要内容。\n\n## 转录全文\n\n大家好，今天讨论三件事。\n";

    [Fact]
    public void ReplaceSummarySection_替换摘要_保留头部与全文()
    {
        var result = TranscribeNoteText.ReplaceSummarySection(Note, "新的会议纪要。");
        Assert.Contains("# 录音 2026-07-12 · 转录笔记", result);
        Assert.Contains("## 摘要\n\n新的会议纪要。", result);
        Assert.DoesNotContain("旧摘要内容", result);
        Assert.Contains("## 转录全文\n\n大家好，今天讨论三件事。", result);
    }

    [Fact]
    public void ReplaceSummarySection_原笔记无摘要节_插到全文之前()
    {
        var note = "# 标题\n\n## 转录全文\n\n正文。\n";
        var result = TranscribeNoteText.ReplaceSummarySection(note, "补上的摘要");
        var summaryIdx = result.IndexOf("## 摘要", System.StringComparison.Ordinal);
        var fullIdx = result.IndexOf("## 转录全文", System.StringComparison.Ordinal);
        Assert.True(summaryIdx >= 0 && fullIdx > summaryIdx);
        Assert.Contains("正文。", result);
    }

    [Fact]
    public void ReplaceSummarySection_结构被改动无全文标记_摘要前置不丢原文()
    {
        var note = "用户自己改过的自由内容";
        var result = TranscribeNoteText.ReplaceSummarySection(note, "新摘要");
        Assert.StartsWith("## 摘要", result);
        Assert.Contains("用户自己改过的自由内容", result);
    }

    // ── ExtractTranscriptFromNote ──

    [Fact]
    public void ExtractTranscriptFromNote_取出全文节正文()
    {
        Assert.Equal("大家好，今天讨论三件事。", TranscribeNoteText.ExtractTranscriptFromNote(Note));
    }

    [Fact]
    public void ExtractTranscriptFromNote_无标记返回null()
    {
        Assert.Null(TranscribeNoteText.ExtractTranscriptFromNote("没有标记的文本"));
    }

    // ── BuildSummarySystemPrompt ──

    [Fact]
    public void BuildSummarySystemPrompt_默认走智能摘要()
    {
        var prompt = TranscribeNoteText.BuildSummarySystemPrompt(new DocumentStoreAgentRun());
        Assert.Contains("结构化 Markdown 摘要", prompt);
        Assert.Contains("不得编造", prompt);
    }

    [Fact]
    public void BuildSummarySystemPrompt_会议纪要风格()
    {
        var prompt = TranscribeNoteText.BuildSummarySystemPrompt(new DocumentStoreAgentRun { TemplateKey = "meeting" });
        Assert.Contains("会议纪要", prompt);
        Assert.Contains("待办", prompt);
        Assert.Contains("不得编造", prompt);
    }

    [Fact]
    public void BuildSummarySystemPrompt_自定义用用户要求且保留硬约束()
    {
        var prompt = TranscribeNoteText.BuildSummarySystemPrompt(new DocumentStoreAgentRun
        {
            TemplateKey = "custom",
            CustomPrompt = "按时间线整理成流水记录",
        });
        Assert.Contains("按时间线整理成流水记录", prompt);
        Assert.Contains("不得编造", prompt);
        Assert.Contains("禁止使用 emoji", prompt);
    }

    [Fact]
    public void BuildSummarySystemPrompt_未知key回退默认()
    {
        var prompt = TranscribeNoteText.BuildSummarySystemPrompt(new DocumentStoreAgentRun { TemplateKey = "nonsense" });
        Assert.Contains("结构化 Markdown 摘要", prompt);
    }

    // ── TranscribeStyleRegistry ──

    [Fact]
    public void Registry_默认与自定义key存在_查找大小写不敏感()
    {
        Assert.NotNull(TranscribeStyleRegistry.Find(TranscribeStyleRegistry.DefaultKey));
        Assert.NotNull(TranscribeStyleRegistry.Find(" Meeting "));
        Assert.Null(TranscribeStyleRegistry.Find("nope"));
        Assert.Null(TranscribeStyleRegistry.Find(null));
    }
}
