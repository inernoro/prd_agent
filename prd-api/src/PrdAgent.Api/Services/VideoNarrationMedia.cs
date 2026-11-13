using System.Diagnostics;
using System.Globalization;
using System.Text.Json;

namespace PrdAgent.Api.Services;

public static class VideoNarrationMedia
{
    /// <summary>只探测已按归属读取的本地字节，不把用户提供的 URL 交给媒体进程。</summary>
    public static async Task<double> ProbeAudioDurationAsync(byte[] bytes)
    {
        var directory = Path.Combine(Path.GetTempPath(), "prd-video-narration-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            var path = Path.Combine(directory, "voice.bin");
            await File.WriteAllBytesAsync(path, bytes, CancellationToken.None);
            return await ProbeDurationAsync(path, requireAudio: true);
        }
        finally { try { Directory.Delete(directory, true); } catch (IOException) { } }
    }

    public static async Task<double> ProbeDurationAsync(string path, bool requireAudio)
    {
        var info = new ProcessStartInfo("ffprobe")
        {
            RedirectStandardOutput = true, RedirectStandardError = true,
            UseShellExecute = false, CreateNoWindow = true,
        };
        foreach (var argument in new[] { "-v", "error", "-show_entries", "format=duration:stream=codec_type", "-of", "json", path })
            info.ArgumentList.Add(argument);
        using var process = Process.Start(info) ?? throw new InvalidOperationException("媒体探测工具不可用，请联系管理员后重新采用配音。");
        var stdout = process.StandardOutput.ReadToEndAsync();
        var stderr = process.StandardError.ReadToEndAsync();
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(30));
        try { await process.WaitForExitAsync(timeout.Token); }
        catch (OperationCanceledException)
        {
            try { process.Kill(entireProcessTree: true); } catch (InvalidOperationException) { }
            await process.WaitForExitAsync(CancellationToken.None);
            throw new InvalidOperationException("配音媒体探测超时，请稍后重新采用。");
        }
        var output = await stdout;
        await stderr;
        if (process.ExitCode != 0) throw new InvalidOperationException(requireAudio
            ? "配音文件无法解码，请更换语音结果后重新采用。"
            : "采用的视频无法解码，请重新导入本镜素材后重试。");
        using var json = JsonDocument.Parse(output);
        var root = json.RootElement;
        if (!root.TryGetProperty("streams", out var streams)
            || !streams.EnumerateArray().Any(stream => stream.TryGetProperty("codec_type", out var type) && type.GetString() == (requireAudio ? "audio" : "video"))
            || !root.TryGetProperty("format", out var format) || !format.TryGetProperty("duration", out var value)
            || !double.TryParse(value.GetString(), NumberStyles.Float, CultureInfo.InvariantCulture, out var duration)
            || !double.IsFinite(duration) || duration <= 0)
            throw new InvalidOperationException(requireAudio
                ? "配音文件没有有效的音轨或时长，请更换语音结果后重新采用。"
                : "采用的视频没有有效画面或时长，请重新导入本镜素材后重试。");
        return duration;
    }
}
