using System.Buffers.Binary;
using PrdAgent.Api.Services;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public class LocalSpeakerDiarizerTests
{
    [Fact]
    public void DistinctVoices_ShouldProduceTwoEditableSpeakerSegments()
    {
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
        result.SpeakerCount.ShouldBe(2, $"confidence={result.Confidence:F3}, turns={result.VoiceTurnCount}");
        result.VoiceTurnCount.ShouldBe(2);
        result.Segments.Select(segment => segment.SpeakerId)
            .Distinct()
            .ShouldBe(["说话人1", "说话人2"]);
        result.Segments[0].StartSec.ShouldBeLessThan(result.Segments[^1].StartSec);
        string.Concat(result.Segments.Select(segment => segment.Text))
            .ShouldBe("米多有十年的行业经验和丰富的营销策略。只要交付质量达到标准，当前报价是合理的。希望通用功能优化不要额外收费。");
    }

    [Fact]
    public void SameVoiceAcrossPauses_ShouldNotInventAnotherSpeaker()
    {
        var wav = BuildWav(
            (0.30, 0, 0),
            (2.0, 165, 0.68),
            (0.60, 0, 0),
            (2.3, 165, 0.62),
            (0.25, 0, 0));

        var result = LocalSpeakerDiarizer.TryDiarize(wav, "第一段发言。第二段仍然是同一个人。");

        result.ShouldNotBeNull();
        result.SpeakerCount.ShouldBe(1);
        result.Segments.Count.ShouldBe(1);
        result.Segments[0].SpeakerId.ShouldBe("说话人1");
    }

    [Fact]
    public void ThreeDistinctVoices_ShouldProduceThreeEditableSpeakerSegments()
    {
        var wav = BuildWav(
            (0.30, 0, 0),
            (1.8, 105, 0.72),
            (0.60, 0, 0),
            (2.0, 205, 0.68),
            (0.60, 0, 0),
            (2.2, 335, 0.64),
            (0.30, 0, 0));

        var result = LocalSpeakerDiarizer.TryDiarize(
            wav,
            "第一位说明行业经验。第二位确认报价合理。第三位要求常规优化不要额外收费。");

        result.ShouldNotBeNull();
        result.SpeakerCount.ShouldBe(3, $"confidence={result.Confidence:F3}, turns={result.VoiceTurnCount}");
        result.Segments.Select(segment => segment.SpeakerId)
            .Distinct()
            .ShouldBe(["说话人1", "说话人2", "说话人3"]);
    }

    [Fact]
    public void SameVoiceAcrossThreePauses_ShouldNotInventThreeSpeakers()
    {
        var wav = BuildWav(
            (0.30, 0, 0),
            (1.6, 165, 0.72),
            (0.55, 0, 0),
            (1.8, 165, 0.64),
            (0.55, 0, 0),
            (2.0, 165, 0.68),
            (0.30, 0, 0));

        var result = LocalSpeakerDiarizer.TryDiarize(
            wav,
            "第一段发言。第二段仍是同一个人。第三段还是同一个人。");

        result.ShouldNotBeNull();
        result.SpeakerCount.ShouldBe(1);
        result.Segments.Select(segment => segment.SpeakerId).Distinct().ShouldBe(["说话人1"]);
    }

    [Fact]
    public void ThreeVoicesAcrossRepeatedTurns_ShouldReuseTheSameThreeSpeakerLabels()
    {
        var wav = BuildWav(
            (0.30, 0, 0),
            (1.0, 105, 0.72),
            (0.50, 0, 0),
            (1.0, 205, 0.68),
            (0.50, 0, 0),
            (1.0, 335, 0.64),
            (0.50, 0, 0),
            (1.0, 105, 0.66),
            (0.50, 0, 0),
            (1.0, 205, 0.74),
            (0.50, 0, 0),
            (1.0, 335, 0.60),
            (0.30, 0, 0));

        var result = LocalSpeakerDiarizer.TryDiarize(
            wav,
            "甲第一次发言。乙第一次发言。丙第一次发言。甲再次发言。乙再次发言。丙再次发言。");

        result.ShouldNotBeNull();
        result.SpeakerCount.ShouldBe(3, $"confidence={result.Confidence:F3}, turns={result.VoiceTurnCount}");
        result.Segments.Select(segment => segment.SpeakerId)
            .ShouldBe(["说话人1", "说话人2", "说话人3", "说话人1", "说话人2", "说话人3"]);
    }

    [Fact]
    public void ThreeLongSpeakerBlocks_WithNaturalPhrasePauses_ShouldKeepThreeBoundaries()
    {
        var wav = BuildWav(
            (0.30, 0, 0),
            (0.85, 105, 0.70), (0.30, 0, 0), (0.90, 118, 0.66), (0.30, 0, 0), (0.95, 110, 0.72),
            (1.20, 0, 0),
            (0.85, 205, 0.68), (0.30, 0, 0), (0.90, 218, 0.64), (0.30, 0, 0), (0.95, 210, 0.70),
            (1.20, 0, 0),
            (0.85, 335, 0.66), (0.30, 0, 0), (0.90, 348, 0.62), (0.30, 0, 0), (0.95, 340, 0.68),
            (0.30, 0, 0));

        var result = LocalSpeakerDiarizer.TryDiarize(
            wav,
            "第一位说明行业经验。第一位补充营销策略。第一位确认医药需求。第二位说明报价态度。第二位确认交付标准。第二位要求常规优化。第三位确认会议待办。第三位安排方案提交。第三位安排报价复核。");

        result.ShouldNotBeNull();
        result.SpeakerCount.ShouldBe(3, $"confidence={result.Confidence:F3}, turns={result.VoiceTurnCount}");
        result.VoiceTurnCount.ShouldBe(3);
        result.Segments.Select(segment => segment.SpeakerId)
            .Distinct()
            .ShouldBe(["说话人1", "说话人2", "说话人3"]);
    }

    [Fact]
    public void SameVoiceAcrossLongPauses_WithNaturalPitchVariation_ShouldRemainOneSpeaker()
    {
        var wav = BuildWav(
            (0.30, 0, 0),
            (1.10, 160, 0.70), (0.30, 0, 0), (1.10, 168, 0.66),
            (1.20, 0, 0),
            (1.10, 172, 0.68), (0.30, 0, 0), (1.10, 164, 0.64),
            (1.20, 0, 0),
            (1.10, 158, 0.72), (0.30, 0, 0), (1.10, 166, 0.68),
            (0.30, 0, 0));

        var result = LocalSpeakerDiarizer.TryDiarize(
            wav,
            "同一位发言人说明行业经验。同一位发言人补充营销策略。同一位发言人确认后续待办。");

        result.ShouldNotBeNull();
        result.SpeakerCount.ShouldBe(1, $"confidence={result.Confidence:F3}, turns={result.VoiceTurnCount}");
        result.Segments.Select(segment => segment.SpeakerId).Distinct().ShouldBe(["说话人1"]);
    }

    [Fact]
    public void UnusedAcousticCluster_ShouldNotLeaveGapInVisibleSpeakerNumbers()
    {
        var wav = BuildWav(
            (0.30, 0, 0),
            (1.5, 110, 0.72),
            (0.55, 0, 0),
            (1.5, 205, 0.68),
            (0.55, 0, 0),
            (1.5, 330, 0.64),
            (0.30, 0, 0));

        var result = LocalSpeakerDiarizer.TryDiarize(
            wav,
            "第一位发言人的完整观点。第三段声纹对应另一位发言人的观点。");

        result.ShouldNotBeNull();
        result.SpeakerCount.ShouldBe(2);
        result.Segments.Select(segment => segment.SpeakerId)
            .Distinct()
            .ShouldBe(["说话人1", "说话人2"]);
    }

    /// <summary>
    /// 本地兜底产出的每一句都必须盖上「声纹估算」的戳。
    ///
    /// 分出几个人是真实声学结果，但哪句话归谁是按字数比例摊出来的——
    /// 不盖戳，界面上它和上游原生识别长得一模一样，用户无从判断该不该信。
    /// 刻意复用上面那条用例的同一段合成音频：判据要建在已被证明能分出两个人的地基上，
    /// 另造一份声学素材等于给这条断言换了个没人验证过的前提。
    /// </summary>
    [Fact]
    public void LocalDiarization_ShouldStampEverySegmentAsEstimated()
    {
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
        result.SpeakerCount.ShouldBe(2);
        result.Segments.ShouldAllBe(segment => segment.SpeakerSource == SpeakerSources.Local);
    }

    [Fact]
    public void InvalidAudio_ShouldDeclineDiarization()
    {
        LocalSpeakerDiarizer.TryDiarize([1, 2, 3, 4], "存在原文").ShouldBeNull();
    }

    private static byte[] BuildWav(params (double Seconds, double Frequency, double Amplitude)[] parts)
    {
        const int sampleRate = 16000;
        var samples = new List<short>();
        foreach (var (seconds, frequency, amplitude) in parts)
        {
            var count = (int)Math.Round(seconds * sampleRate);
            for (var i = 0; i < count; i++)
            {
                var value = frequency <= 0
                    ? 0
                    : Math.Sin(2 * Math.PI * frequency * i / sampleRate)
                      + 0.22 * Math.Sin(2 * Math.PI * frequency * 2.15 * i / sampleRate);
                samples.Add((short)Math.Clamp(value * amplitude * 22000, short.MinValue, short.MaxValue));
            }
        }

        var dataBytes = samples.Count * 2;
        var bytes = new byte[44 + dataBytes];
        "RIFF"u8.CopyTo(bytes);
        BinaryPrimitives.WriteInt32LittleEndian(bytes.AsSpan(4, 4), 36 + dataBytes);
        "WAVE"u8.CopyTo(bytes.AsSpan(8));
        "fmt "u8.CopyTo(bytes.AsSpan(12));
        BinaryPrimitives.WriteInt32LittleEndian(bytes.AsSpan(16, 4), 16);
        BinaryPrimitives.WriteUInt16LittleEndian(bytes.AsSpan(20, 2), 1);
        BinaryPrimitives.WriteUInt16LittleEndian(bytes.AsSpan(22, 2), 1);
        BinaryPrimitives.WriteInt32LittleEndian(bytes.AsSpan(24, 4), sampleRate);
        BinaryPrimitives.WriteInt32LittleEndian(bytes.AsSpan(28, 4), sampleRate * 2);
        BinaryPrimitives.WriteUInt16LittleEndian(bytes.AsSpan(32, 2), 2);
        BinaryPrimitives.WriteUInt16LittleEndian(bytes.AsSpan(34, 2), 16);
        "data"u8.CopyTo(bytes.AsSpan(36));
        BinaryPrimitives.WriteInt32LittleEndian(bytes.AsSpan(40, 4), dataBytes);
        for (var i = 0; i < samples.Count; i++)
            BinaryPrimitives.WriteInt16LittleEndian(bytes.AsSpan(44 + i * 2, 2), samples[i]);
        return bytes;
    }
}
