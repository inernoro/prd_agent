using System.Text;
using System.Diagnostics;
using System.Reflection;
using PrdAgent.Core.Models;
using PrdAgent.Api.Services;
using PrdAgent.Api.Services.Speech;
using PrdAgent.Core.Services;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

/// <summary>点名运行的真实 ffprobe 回归，不读取外部素材或调用语音模型。</summary>
[Trait("Category", "Integration")]
public sealed class VideoNarrationMediaTests
{
    [Theory]
    [InlineData("First paragraph\n\nSecond paragraph")]
    [InlineData("第一段\r\n  \r\n第二段\r第三段")]
    public async Task ParagraphBreaks_SurviveRealSrtParsingWithoutChangingNarration(string text)
    {
        var tempDir = Path.Combine(Path.GetTempPath(), $"narration-srt-{Guid.NewGuid():N}");
        Directory.CreateDirectory(tempDir);
        try
        {
            var scene = new VideoGenScene { Narration = new() { Text = text, DurationSeconds = 2 } };
            var clips = VideoNarrationTimeline.BuildSubtitles([(scene, 3)]);
            var method = typeof(VideoGenRunWorker).GetMethod("WriteSubtitleFileAsync", BindingFlags.NonPublic | BindingFlags.Static)!;
            var path = await (Task<string?>)method.Invoke(null, [null, tempDir, clips])!;
            var output = Path.Combine(tempDir, "parsed.srt");
            var start = new ProcessStartInfo("ffmpeg") { RedirectStandardError = true, UseShellExecute = false };
            foreach (var argument in new[] { "-v", "error", "-i", path!, "-c:s", "srt", output }) start.ArgumentList.Add(argument);
            using var process = Process.Start(start)!;
            var error = await process.StandardError.ReadToEndAsync();
            await process.WaitForExitAsync();
            Assert.True(process.ExitCode == 0, error);
            var parsed = await File.ReadAllTextAsync(output);
            foreach (var paragraph in text.Replace('\r', '\n').Split('\n').Where(line => !string.IsNullOrWhiteSpace(line)))
                Assert.Contains(paragraph, parsed);
            Assert.Equal(text, scene.Narration.Text);
        }
        finally { Directory.Delete(tempDir, recursive: true); }
    }

    [Fact]
    public async Task RealWaveFile_ReportsFullVoiceDuration()
    {
        using var stream = new MemoryStream();
        using (var writer = new BinaryWriter(stream, Encoding.ASCII, leaveOpen: true))
        {
            const int samples = 12000;
            writer.Write(Encoding.ASCII.GetBytes("RIFF")); writer.Write(36 + samples * 2);
            writer.Write(Encoding.ASCII.GetBytes("WAVEfmt ")); writer.Write(16);
            writer.Write((short)1); writer.Write((short)1); writer.Write(8000); writer.Write(16000);
            writer.Write((short)2); writer.Write((short)16);
            writer.Write(Encoding.ASCII.GetBytes("data")); writer.Write(samples * 2);
            for (var index = 0; index < samples; index++) writer.Write((short)(Math.Sin(index * 2 * Math.PI * 440 / 8000) * 10000));
        }
        var duration = await VideoNarrationMedia.ProbeAudioDurationAsync(stream.ToArray());
        Assert.InRange(duration, 1.49, 1.51);
    }

    [Fact]
    public async Task RawPcmWithoutHeader_NormalizesToFullDecodableVoice()
    {
        var pcm = new byte[SpeechCapabilityPolicy.PcmSampleRate * 3]; // 1.5秒，16-bit单声道。
        for (var sample = 0; sample < pcm.Length / 2; sample++)
        {
            var value = (short)(Math.Sin(sample * 2 * Math.PI * 440 / SpeechCapabilityPolicy.PcmSampleRate) * 10000);
            pcm[sample * 2] = (byte)value;pcm[sample * 2 + 1] = (byte)(value >> 8);
        }
        var wave = SpeechAudioMedia.WrapPcm16(pcm, SpeechCapabilityPolicy.PcmSampleRate, channels: 1);
        Assert.Equal(pcm, wave.AsSpan(44).ToArray());
        Assert.InRange(await VideoNarrationMedia.ProbeAudioDurationAsync(wave), 1.49, 1.51);
    }

    [Fact]
    public async Task NonAudioBytes_AreRejectedWithRecoveryMessage()
    {
        var exception = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            VideoNarrationMedia.ProbeAudioDurationAsync(Encoding.UTF8.GetBytes("invalid local fixture")));
        Assert.Contains("更换语音结果", exception.Message);
        Assert.DoesNotContain("/tmp/", exception.Message);
    }
}
