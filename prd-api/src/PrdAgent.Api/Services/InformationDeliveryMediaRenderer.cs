using System.Diagnostics;
using System.Globalization;
using PrdAgent.Core.Models;
using SixLabors.Fonts;
using SixLabors.ImageSharp;
using SixLabors.ImageSharp.Drawing.Processing;
using SixLabors.ImageSharp.PixelFormats;
using SixLabors.ImageSharp.Processing;

namespace PrdAgent.Api.Services;

internal sealed record InformationDeliveryRenderedMedia(
    string Format, byte[] Bytes, List<InformationDeliveryChapterTime> Chapters);

internal static class InformationDeliveryMediaRenderer
{
    public static async Task<IReadOnlyList<InformationDeliveryRenderedMedia>> RenderAsync(
        IReadOnlyList<InformationDeliveryChapter> chapters, IReadOnlyList<byte[]> voices,
        IReadOnlyCollection<string> formats, CancellationToken ct)
    {
        var working = Directory.CreateTempSubdirectory("map-information-delivery-");
        try
        {
            var media = new List<InformationDeliveryRenderedMedia>();
            var audioNames = new List<string>();
            var videoNames = new List<string>();
            var audioChapters = new List<InformationDeliveryChapterTime>();
            var videoChapters = new List<InformationDeliveryChapterTime>();
            var audioStart = 0d;
            var videoStart = 0d;
            for (var i = 0; i < chapters.Count; i++)
            {
                var audio = $"voice-{i}.mp3";
                audioNames.Add(audio);
                await File.WriteAllBytesAsync(Path.Combine(working.FullName, audio), voices[i], ct);
                var duration = await DurationAsync(working.FullName, audio, ct);
                audioChapters.Add(new(chapters[i].Title, audioStart, duration));
                audioStart += duration;
                if (!formats.Contains("video")) continue;
                var frame = $"frame-{i}.png";
                DrawTitleCard(chapters[i], Path.Combine(working.FullName, frame));
                var video = $"chapter-{i}.mp4";
                videoNames.Add(video);
                await LaunchAsync(working.FullName, "ffmpeg", [
                    "-loglevel", "error", "-nostdin", "-protocol_whitelist", "file,pipe",
                    "-loop", "1", "-framerate", "12", "-i", frame,
                    "-protocol_whitelist", "file,pipe", "-f", "mp3", "-i", audio, "-map", "0:v:0", "-map", "1:a:0",
                    "-c:v", "libx264", "-preset", "ultrafast", "-tune", "stillimage", "-pix_fmt", "yuv420p",
                    "-c:a", "aac", "-ar", "48000", "-ac", "1", "-shortest", "-threads", "2", video,
                ], ct);
                var segmentDuration = await DurationAsync(working.FullName, video, ct);
                videoChapters.Add(new(chapters[i].Title, videoStart, segmentDuration));
                videoStart += segmentDuration;
            }
            if (formats.Contains("audio"))
                media.Add(new("audio", await JoinAsync(working.FullName, audioNames, "lesson.mp3", ["-map", "0:a:0", "-c:a", "copy"], ct), audioChapters));
            if (formats.Contains("video"))
                media.Add(new("video", await JoinAsync(working.FullName, videoNames, "lesson.mp4", ["-c", "copy", "-movflags", "+faststart"], ct), videoChapters));
            return media;
        }
        finally
        {
            try { working.Delete(recursive: true); } catch (IOException) { /* Temporary storage is reclaimed by the host. */ }
        }
    }

    private static void DrawTitleCard(InformationDeliveryChapter chapter, string destination)
    {
        var fonts = new FontCollection();
        var family = fonts.Add(Path.Combine(AppContext.BaseDirectory, "Assets", "Fonts", "default.ttf"));
        using var image = new Image<Rgba32>(1280, 720, Color.ParseHex("F7F8FC"));
        var ink = Color.ParseHex("182347");
        var secondary = Color.ParseHex("354D81");
        image.Mutate(canvas =>
        {
            canvas.Fill(Color.ParseHex("3157BB"), new RectangleF(0, 0, 1280, 12));
            canvas.DrawText(new RichTextOptions(family.CreateFont(46)) {
                Origin = new PointF(68, 100), WrappingLength = 1144, WordBreaking = WordBreaking.BreakAll,
            }, chapter.Title, ink);
            var text = chapter.Steps.FirstOrDefault();
            if (text?.Length is > 0 and <= 100)
            {
                canvas.DrawText(new RichTextOptions(family.CreateFont(36)) {
                    Origin = new PointF(68, 388), WrappingLength = 1144, WordBreaking = WordBreaking.BreakAll,
                }, text, secondary);
            }
        });
        image.SaveAsPng(destination);
    }

    private static async Task<byte[]> JoinAsync(
        string folder, IReadOnlyList<string> names, string destination, string[] options, CancellationToken ct)
    {
        var listPath = destination + ".list";
        await File.WriteAllLinesAsync(Path.Combine(folder, listPath), names.Select(name => $"file '{name}'"), ct);
        await LaunchAsync(folder, "ffmpeg", [
            "-loglevel", "error", "-nostdin", "-protocol_whitelist", "file,pipe",
            "-f", "concat", "-safe", "1", "-i", listPath, .. options, destination,
        ], ct);
        var output = new FileInfo(Path.Combine(folder, destination));
        if (output.Length is <= 0 or > 64 * 1024 * 1024)
            throw new InvalidOperationException("讲解产物过大或没有内容，请拆分课程后重试");
        return await File.ReadAllBytesAsync(output.FullName, ct);
    }

    private static async Task<double> DurationAsync(string folder, string name, CancellationToken ct)
    {
        var result = await LaunchAsync(folder, "ffprobe", [
            "-v", "error", "-protocol_whitelist", "file,pipe", "-f", name.EndsWith(".mp3", StringComparison.Ordinal) ? "mp3" : "mov",
            "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", name,
        ], ct);
        if (!double.TryParse(result.Trim(), NumberStyles.Float, CultureInfo.InvariantCulture, out var seconds)
            || !double.IsFinite(seconds) || seconds is <= 0 or > 300)
            throw new InvalidOperationException("讲解音轨没有可用的时长");
        return seconds;
    }

    private static async Task<string> LaunchAsync(
        string folder, string executable, IReadOnlyList<string> args, CancellationToken ct)
    {
        using var process = new Process {
            StartInfo = new ProcessStartInfo(executable) { WorkingDirectory = folder, UseShellExecute = false,
                RedirectStandardError = true, RedirectStandardOutput = true },
        };
        foreach (var arg in args) process.StartInfo.ArgumentList.Add(arg);
        process.Start();
        var output = process.StandardOutput.ReadToEndAsync(ct);
        var errors = process.StandardError.ReadToEndAsync(ct);
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(TimeSpan.FromMinutes(2));
        try
        {
            await process.WaitForExitAsync(timeout.Token);
            await errors;
            if (process.ExitCode != 0) throw new InvalidOperationException("讲解媒体合成失败");
            return await output;
        }
        catch
        {
            if (!process.HasExited) process.Kill(entireProcessTree: true);
            throw;
        }
    }
}
