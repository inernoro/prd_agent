using PrdAgent.Api.Services;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

/// <summary>
/// 说话人来源标注的守卫。
///
/// 背景：说话人有三条产出路径——上游 ASR 原生返回、多模态模型重听、本地声纹兜底。
/// 本地兜底的「分几个人」是真实声学结果，但「哪句话归谁」是按字数比例摊出来的估算。
/// 三者在界面上曾经长得一模一样，用户没有任何线索判断该不该信。
///
/// 这批用例锁住两件事：产出端真的盖了戳、笔记里真的写出了来源；
/// 以及不确定时（单人 / 来源混合）**不下结论**，而不是随便挑一个。
///
/// 本地声纹那条路径的盖戳断言放在 LocalSpeakerDiarizerTests：那里已有被证明
/// 能分出两个人的合成音频，判据该建在验证过的地基上，不另造一份声学素材。
/// </summary>
public class SubtitleSpeakerSourceTests
{
    [Fact]
    public void ModelDiarization_ShouldStampModelSource()
    {
        var parsed = SubtitleGenerationProcessor.ParseChatAudioSpeakerSegments(
            "[说话人1] 今天讨论合作项目。\n[说话人2] 我们的报价是合理的。");

        parsed.Count.ShouldBe(2);
        parsed.ShouldAllBe(segment => segment.SpeakerSource == SpeakerSources.Model);
    }

    [Fact]
    public void TranscriptNote_ShouldCarrySpeakerSourceLine_WhenMultipleSpeakersShareOneSource()
    {
        var note = SubtitleFormatter.FormatTranscriptNote(
            "周会录音.m4a",
            string.Empty,
            [
                new(0, 9, "甲方观点。", "说话人1", SpeakerSources.Local),
                new(10, 20, "乙方观点。", "说话人2", SpeakerSources.Local),
            ]);

        note.ShouldContain("> 说话人来源：local · ");
        // 估算这件事必须在笔记里说出口，不能只写个来源代号
        note.ShouldContain("按语速比例推算");
        // 来源行是引用行，不能污染逐句解析（前端按 **[mm:ss - mm:ss]** 取段）
        note.ShouldContain("**[00:00 - 00:09]** [说话人1] 甲方观点。");
    }

    [Fact]
    public void NativeSource_ShouldNotClaimEstimation()
    {
        var line = SubtitleFormatter.FormatSpeakerSourceNote(
            [
                new(0, 9, "甲。", "说话人1", SpeakerSources.Native),
                new(10, 20, "乙。", "说话人2", SpeakerSources.Native),
            ]);

        line.ShouldNotBeNull();
        line.ShouldStartWith("> 说话人来源：native · ");
        line.ShouldNotContain("推算");
    }

    [Fact]
    public void SingleSpeaker_ShouldNotEmitSourceLine()
    {
        // 单人录音谈不上「分得准不准」，写来源只会制造噪音
        SubtitleFormatter.FormatSpeakerSourceNote(
            [
                new(0, 9, "只有一个人在说。", "说话人1", SpeakerSources.Local),
                new(10, 20, "还是同一个人。", "说话人1", SpeakerSources.Local),
            ]).ShouldBeNull();
    }

    [Fact]
    public void MixedSources_ShouldRefuseToPickOne()
    {
        // 来源不一致 = 这批分段被混合改写过，此时任何单一结论都是编的。
        // 取第一条（形状 6：判据取了看起来对、但不是真正生效的那个值）会让这条变绿。
        SubtitleFormatter.FormatSpeakerSourceNote(
            [
                new(0, 9, "甲。", "说话人1", SpeakerSources.Native),
                new(10, 20, "乙。", "说话人2", SpeakerSources.Local),
            ]).ShouldBeNull();
    }

    [Fact]
    public void UnstampedSegments_ShouldNotInventSource()
    {
        SubtitleFormatter.FormatSpeakerSourceNote(
            [
                new(0, 9, "甲。", "说话人1"),
                new(10, 20, "乙。", "说话人2"),
            ]).ShouldBeNull();
    }
}
