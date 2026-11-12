using System.Text;
using PrdAgent.Api.Services;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

/// <summary>点名运行的真实 ffprobe 回归，不读取外部素材或调用语音模型。</summary>
[Trait("Category", "Integration")]
public sealed class VideoNarrationMediaTests
{
    [Fact]
    public async Task RealPcmFile_ReportsFullVoiceDuration()
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
    public async Task NonAudioBytes_AreRejectedWithRecoveryMessage()
    {
        var exception = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            VideoNarrationMedia.ProbeAudioDurationAsync(Encoding.UTF8.GetBytes("invalid local fixture")));
        Assert.Contains("更换语音结果", exception.Message);
        Assert.DoesNotContain("/tmp/", exception.Message);
    }
}
