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
