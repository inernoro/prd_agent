using System.Buffers.Binary;
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
/// </summary>
public class SubtitleSpeakerSourceTests
{
    [Fact]
    public void LocalDiarizerOutput_ShouldStampLocalSource()
    {
        // 两种明显不同的声音 → 走本地声纹兜底，每一句都必须带上 local 戳。
        // 删掉产出端的盖戳，这条会红。
        var wav = BuildWav(
            (0.35, 0, 0),
            (2.2, 125, 0.70),
            (0.55, 0, 0),
            (2.8, 255, 0.65),
            (0.30, 0, 0));

        var result = LocalSpeakerDiarizer.TryDiarize(
            wav,
            "米多有十年的行业经验和丰富的营销策略。只要交付质量达到标准，当前报价是合理的。希望通用功能优化不要额外收费。");

        result.ShouldNotBeNull();
        result.SpeakerCount.ShouldBeGreaterThan(1);
        result.Segments.ShouldAllBe(segment => segment.SpeakerSource == SpeakerSources.Local);
    }

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

    /// <summary>合成 16k 单声道 PCM16 WAV：(秒数, 基频Hz, 幅度)，基频 0 表示静音。</summary>
    private static byte[] BuildWav(params (double Seconds, double Frequency, double Amplitude)[] parts)
    {
        const int sampleRate = 16000;
        var samples = new List<short>();
        foreach (var (seconds, frequency, amplitude) in parts)
        {
            var count = (int)(seconds * sampleRate);
            for (var i = 0; i < count; i++)
            {
                if (frequency <= 0)
                {
                    samples.Add(0);
                    continue;
                }
                var t = i / (double)sampleRate;
                var value = Math.Sin(2 * Math.PI * frequency * t)
                            + 0.45 * Math.Sin(2 * Math.PI * frequency * 2 * t)
                            + 0.25 * Math.Sin(2 * Math.PI * frequency * 3 * t);
                samples.Add((short)(value * amplitude * 9000));
            }
        }

        var dataBytes = samples.Count * 2;
        var buffer = new byte[44 + dataBytes];
        "RIFF"u8.CopyTo(buffer.AsSpan(0, 4));
        BinaryPrimitives.WriteInt32LittleEndian(buffer.AsSpan(4, 4), 36 + dataBytes);
        "WAVE"u8.CopyTo(buffer.AsSpan(8, 4));
        "fmt "u8.CopyTo(buffer.AsSpan(12, 4));
        BinaryPrimitives.WriteInt32LittleEndian(buffer.AsSpan(16, 4), 16);
        BinaryPrimitives.WriteUInt16LittleEndian(buffer.AsSpan(20, 2), 1);
        BinaryPrimitives.WriteUInt16LittleEndian(buffer.AsSpan(22, 2), 1);
        BinaryPrimitives.WriteInt32LittleEndian(buffer.AsSpan(24, 4), sampleRate);
        BinaryPrimitives.WriteInt32LittleEndian(buffer.AsSpan(28, 4), sampleRate * 2);
        BinaryPrimitives.WriteUInt16LittleEndian(buffer.AsSpan(32, 2), 2);
        BinaryPrimitives.WriteUInt16LittleEndian(buffer.AsSpan(34, 2), 16);
        "data"u8.CopyTo(buffer.AsSpan(36, 4));
        BinaryPrimitives.WriteInt32LittleEndian(buffer.AsSpan(40, 4), dataBytes);
        for (var i = 0; i < samples.Count; i++)
            BinaryPrimitives.WriteInt16LittleEndian(buffer.AsSpan(44 + i * 2, 2), samples[i]);
        return buffer;
    }
}
