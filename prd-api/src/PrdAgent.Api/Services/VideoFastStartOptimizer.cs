using System.Diagnostics;

namespace PrdAgent.Api.Services;

/// <summary>
/// 将模型返回的 MP4 索引移动到文件头，避免浏览器下载完整文件后才能开始播放。
/// 优化失败时保留原始视频，不能让播放优化反过来导致生成任务失败。
/// </summary>
public static class VideoFastStartOptimizer
{
    public static IReadOnlyList<string> BuildArguments(string inputFile, string outputFile) =>
    [
        "-y",
        "-i", inputFile,
        "-map", "0",
        "-c", "copy",
        "-movflags", "+faststart",
        outputFile,
    ];

    public static async Task<byte[]> OptimizeAsync(byte[] source, ILogger logger)
    {
        if (source.Length == 0) return source;

        var tempDir = Path.Combine(Path.GetTempPath(), $"prd-video-faststart-{Guid.NewGuid():N}");
        Directory.CreateDirectory(tempDir);
        var inputFile = Path.Combine(tempDir, "input.mp4");
        var outputFile = Path.Combine(tempDir, "output.mp4");

        try
        {
            await File.WriteAllBytesAsync(inputFile, source, CancellationToken.None);
            var startInfo = new ProcessStartInfo
            {
                FileName = "ffmpeg",
                RedirectStandardError = true,
                RedirectStandardOutput = true,
                UseShellExecute = false,
                CreateNoWindow = true,
            };
            foreach (var argument in BuildArguments(inputFile, outputFile))
                startInfo.ArgumentList.Add(argument);

            using var process = Process.Start(startInfo)
                                ?? throw new InvalidOperationException("ffmpeg 进程启动失败");
            var stderrTask = process.StandardError.ReadToEndAsync();
            var stdoutTask = process.StandardOutput.ReadToEndAsync();
            var exitTask = process.WaitForExitAsync(CancellationToken.None);
            var completed = await Task.WhenAny(exitTask, Task.Delay(TimeSpan.FromMinutes(2), CancellationToken.None));
            if (completed != exitTask)
            {
                try { process.Kill(entireProcessTree: true); } catch { }
                throw new TimeoutException("MP4 fast-start 优化超过 2 分钟");
            }

            await exitTask;
            var stderr = await stderrTask;
            _ = await stdoutTask;
            if (process.ExitCode != 0 || !File.Exists(outputFile))
            {
                var detail = stderr.Length > 800 ? stderr[^800..] : stderr;
                throw new InvalidOperationException($"ffmpeg fast-start 失败 (exit={process.ExitCode}): {detail}");
            }

            var optimized = await File.ReadAllBytesAsync(outputFile, CancellationToken.None);
            if (optimized.Length == 0) throw new InvalidOperationException("fast-start 输出为空");
            return optimized;
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "视频 fast-start 优化失败，回退上传原始文件");
            return source;
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); }
            catch (Exception ex) { logger.LogWarning(ex, "视频 fast-start 临时目录清理失败: {Path}", tempDir); }
        }
    }
}
