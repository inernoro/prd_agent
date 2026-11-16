using System.Diagnostics;
using System.Globalization;
using PrdAgent.Core.Models;
using SixLabors.Fonts;
using SixLabors.ImageSharp;
using SixLabors.ImageSharp.Drawing.Processing;
using SixLabors.ImageSharp.PixelFormats;
using SixLabors.ImageSharp.Processing;

namespace PrdAgent.Api.Services;

/// <summary>受控图文讲解。模型只提供文本，不生成虚构的产品操作画面。</summary>
public static class WritingTeachingRenderer
{
    public static void DrawFrame(WritingTeaching teaching, int index, bool portrait, string output)
    {
        var width = portrait ? 720 : 1280; var height = portrait ? 1280 : 720;
        var fonts = new FontCollection();
        var family = fonts.Add(Path.Combine(AppContext.BaseDirectory, "Assets", "Fonts", "default.ttf"));
        using var image = new Image<Rgba32>(width, height, Color.ParseHex("F7F8FA"));
        var scene = teaching.Scenes[index];
        var section = teaching.Source.Sections.Single(s => s.Id == scene.SectionId);
        var ink = Color.ParseHex("202738"); var accent = Color.ParseHex("4F56AC"); var muted = Color.ParseHex("526078");
        image.Mutate(ctx => {
            ctx.Fill(accent, new RectangleF(0, 0, width, 8));
            Write(ctx, $"{index + 1:00} / {teaching.Scenes.Count:00} · 图文讲解 · 来源文档 v{teaching.Source.Version}", 26, 46, 40, width - 92, 70, muted);
            var titleY = portrait ? 115 : 100;
            Write(ctx, scene.Title, portrait ? 46 : 44, 46, titleY, width - 92, portrait ? 190 : 100, ink);
            var y = portrait ? 350f : 240f;
            foreach (var highlight in scene.Highlights) {
                ctx.Fill(accent, new RectangleF(46, y + 8, 4, 28));
                y += Write(ctx, highlight, portrait ? 36 : 34, 70, y, width - 126, portrait ? 175 : 105, ink) + 30;
            }
            if (!string.IsNullOrWhiteSpace(section.Condition)) {
                var boxY = portrait ? 1010 : 590;
                ctx.Fill(Color.ParseHex("ECEEF8"), new RectangleF(30, boxY - 12, width - 60, portrait ? 160 : 85));
                Write(ctx, "条件：" + section.Condition, portrait ? 28 : 25, 46, boxY, width - 92, portrait ? 135 : 65, accent);
            }
            var citations = scene.ParagraphIds.SelectMany(id => teaching.Source.Sections.SelectMany(s => s.Paragraphs).Single(p => p.Id == id).Citations).Distinct().ToList();
            Write(ctx, "依据：" + section.Title + (citations.Count > 0 ? " · 来源 " + string.Join("、", citations) : " · 作者确认正文"), 22, 46, height - 56, width - 92, 45, muted);

            float Write(IImageProcessingContext c, string text, float size, float x, float top, float wrap, float limit, Color color) {
                var options = new RichTextOptions(family.CreateFont(size)) { Origin = new PointF(x, top), WrappingLength = wrap, LineSpacing = 1.3f, WordBreaking = WordBreaking.BreakAll };
                var measured = TextMeasurer.MeasureSize(text, options);
                if (measured.Height > limit) throw new InvalidOperationException("教学画面文字超出可读区域，请缩短本场景重点后重新编排");
                c.DrawText(options, text, color);
                return measured.Height;
            }
        });
        image.SaveAsPng(output);
    }

    public static async Task<string> SlowAudioAsync(string input, string output, Func<Task> ensureCurrent)
    {
        await RunAsync("ffmpeg", new[] { "-y", "-loglevel", "error", "-i", input, "-af", "atempo=0.8", "-ar", "48000", "-ac", "1", "-c:a", "pcm_s16le", output }, ensureCurrent, TimeSpan.FromMinutes(1));
        return output;
    }

    public static async Task<double> ProbeDurationAsync(string file, Func<Task> ensureCurrent)
    {
        var text = await RunAsync("ffprobe", new[] { "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", file }, ensureCurrent, TimeSpan.FromSeconds(30));
        if (!double.TryParse(text.Trim(), NumberStyles.Float, CultureInfo.InvariantCulture, out var duration) || !double.IsFinite(duration) || duration <= 0)
            throw new InvalidOperationException("媒体文件没有有效时长");
        return duration;
    }

    public static async Task<string> RenderAsync(WritingTeaching teaching, IReadOnlyList<string> audio, string folder, bool portrait, Func<Task> ensureCurrent)
    {
        var clips = new List<VideoExportClipSource>(); var voices = new List<VideoExportAudioSource>();
        var layout = portrait ? "portrait" : "landscape";
        for (var i = 0; i < teaching.Scenes.Count; i++) {
            await ensureCurrent();
            var scene = teaching.Scenes[i]; var frame = Path.Combine(folder, $"{layout}-{i}.png"); var clip = Path.Combine(folder, $"{layout}-{i}.mp4");
            DrawFrame(teaching, i, portrait, frame);
            await RunAsync("ffmpeg", new[] { "-y", "-loglevel", "error", "-loop", "1", "-framerate", "30", "-i", frame,
                "-t", scene.Duration.ToString("0.######", CultureInfo.InvariantCulture), "-c:v", "libx264", "-preset", "veryfast", "-tune", "stillimage", "-pix_fmt", "yuv420p", "-an", clip }, ensureCurrent, TimeSpan.FromMinutes(2));
            clips.Add(new VideoExportClipSource(clip, scene.Duration, false));
            voices.Add(new VideoExportAudioSource(audio[i], scene.Start, scene.Duration));
        }
        var srt = Path.Combine(folder, "captions.srt");
        static string Stamp(double value) => TimeSpan.FromMilliseconds(Math.Round(value * 1000)).ToString(@"hh\:mm\:ss\,fff", CultureInfo.InvariantCulture);
        await File.WriteAllTextAsync(srt, string.Join("\n\n", teaching.Scenes.Select((s, i) => $"{i + 1}\n{Stamp(s.Start)} --> {Stamp(s.Start + s.Duration)}\n{s.Narration}")));
        var output = Path.Combine(folder, layout + ".mp4");
        var args = VideoExportCommandBuilder.Build(clips, voices, srt, output, portrait ? "9:16" : "16:9");
        await RunAsync("ffmpeg", args, ensureCurrent, TimeSpan.FromMinutes(8));
        var actual = await ProbeDurationAsync(output, ensureCurrent);
        if (Math.Abs(actual - teaching.Duration) > 0.15) throw new InvalidOperationException("成片时长与旁白时间轴不一致，未提供预览");
        if (new FileInfo(output).Length > 64 * 1024 * 1024) throw new InvalidOperationException("教学成片超过64MB，请拆分文档后制作");
        return output;
    }

    private static async Task<string> RunAsync(string command, IReadOnlyList<string> args, Func<Task> ensureCurrent, TimeSpan timeout)
    {
        using var cancel = new CancellationTokenSource(timeout);
        using var process = new Process { StartInfo = new ProcessStartInfo(command) { RedirectStandardError = true, RedirectStandardOutput = true, UseShellExecute = false, CreateNoWindow = true } };
        foreach (var arg in args) process.StartInfo.ArgumentList.Add(arg);
        process.Start();
        var output = process.StandardOutput.ReadToEndAsync(); var error = process.StandardError.ReadToEndAsync();
        try {
            var wait = process.WaitForExitAsync(cancel.Token);
            while (!wait.IsCompleted) { await ensureCurrent(); await Task.WhenAny(wait, Task.Delay(2000, cancel.Token)); cancel.Token.ThrowIfCancellationRequested(); }
            await wait;
            if (process.ExitCode != 0) throw new InvalidOperationException($"教学媒体处理失败（{command}）：{(await error)[..Math.Min(500, (await error).Length)]}");
            return await output;
        } catch { if (!process.HasExited) process.Kill(entireProcessTree: true); throw; }
    }
}
