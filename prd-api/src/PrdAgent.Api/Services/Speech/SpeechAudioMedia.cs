using System.Text;
using PrdAgent.Core.Services;

namespace PrdAgent.Api.Services.Speech;

/// <summary>将已授权读取的原始语音 PCM 封装为可探测、可合成的本地 WAV。</summary>
public static class SpeechAudioMedia
{
    public static byte[] WrapPcm16(byte[] pcm, int sampleRate, int channels)
    {
        if (sampleRate is < 8000 or > 48000 || channels is < 1 or > 2)
            throw new ArgumentOutOfRangeException(nameof(sampleRate));
        var blockAlign = channels * 2;
        if (pcm.Length == 0 || pcm.Length > SpeechCapabilityPolicy.MaxAudioBytes || pcm.Length % blockAlign != 0)
            throw new SpeechException("AUDIO_FORMAT_INVALID", "PCM 语音数据不完整，请更换已完成的语音结果。", 400);
        using var stream = new MemoryStream(pcm.Length + 44);
        using var writer = new BinaryWriter(stream, Encoding.ASCII, leaveOpen: true);
        writer.Write(Encoding.ASCII.GetBytes("RIFF"));writer.Write(36 + pcm.Length);
        writer.Write(Encoding.ASCII.GetBytes("WAVEfmt "));writer.Write(16);
        writer.Write((short)1);writer.Write((short)channels);writer.Write(sampleRate);
        writer.Write(sampleRate * blockAlign);writer.Write((short)blockAlign);writer.Write((short)16);
        writer.Write(Encoding.ASCII.GetBytes("data"));writer.Write(pcm.Length);writer.Write(pcm);
        return stream.ToArray();
    }
}
