using System.Diagnostics;
using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using PrdAgent.Core.Models;

namespace PrdAgent.Api.Services;

internal sealed record VideoTemplateScene(string Heading, string Note, string Narration);
internal sealed record VideoTemplateClip(VideoTemplateScene Scene, VideoTemplateCaption Caption, double AudioOffset);

internal static class VideoTemplateRenderer
{
    private const int Width = 1280;
    private const int Height = 720;

    internal static IReadOnlyList<VideoTemplateScene> ParseScenes(string text)
    {
        if (text.Trim().StartsWith("```", StringComparison.Ordinal))
        {
            var lines = text.Trim().Split('\n', 2);
            if (lines.Length != 2) throw new FormatException("分镜返回缺少正文。");
            text = lines[1].TrimEnd().TrimEnd('`').Trim();
        }
        using var json = JsonDocument.Parse(text);
        var items = json.RootElement.GetProperty("scenes");
        if (items.GetArrayLength() != VideoTemplateCatalog.SceneCount) throw new FormatException("模板需要三段分镜。");
        var result = new List<VideoTemplateScene>(VideoTemplateCatalog.SceneCount);
        foreach (var item in items.EnumerateArray())
        {
            var heading = ReadLine(item, "heading", 9);
            var note = ReadLine(item, "note", 24);
            var narration = ReadLine(item, "narration", 42);
            result.Add(new(heading, note, narration));
        }
        return result;
    }

    private static string ReadLine(JsonElement item, string key, int maxLength)
    {
        var value = item.GetProperty(key).GetString()?.Trim();
        if (value == null || value.Length == 0 || value.Length > maxLength || value.Any(char.IsControl))
            throw new FormatException($"无效分镜字段 {key}");
        return value;
    }

    internal static async Task<(double Duration, double FirstVoice, double LastVoice)> MeasureSpeechAsync(string directory, string file, CancellationToken ct)
    {
        var output = await RunAsync("ffprobe", directory,
            ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file], ct);
        if (!double.TryParse(output.Output.Trim(), CultureInfo.InvariantCulture, out var duration) || duration is < 0.25 or > 40 || !double.IsFinite(duration))
            throw new InvalidDataException("配音时长异常。");

        var measured = await RunAsync("ffmpeg", directory,
            ["-nostdin", "-hide_banner", "-i", file, "-af", "silencedetect=n=-42dB:d=0.08", "-f", "null", "-"], ct);
        var silence = Regex.Matches(measured.Diagnostics, @"silence_(start|end): (-?\d+(?:\.\d+)?)")
            .Select(match => (Kind: match.Groups[1].Value, Time: double.Parse(match.Groups[2].Value, CultureInfo.InvariantCulture))).ToArray();
        var first = silence.Length >= 2 && silence[0].Kind == "start" && silence[0].Time < 0.06 ? silence[1].Time : 0;
        var last = silence.Length >= 2 && silence[^1].Kind == "end" && silence[^1].Time >= duration - 0.06 ? silence[^2].Time : duration;
        if (last - first < 0.2) throw new InvalidDataException("配音缺少可听语音。");
        return (duration, Math.Max(0, first), Math.Min(duration, last));
    }

    internal static async Task RenderAsync(string directory, string title, VideoTemplateDefinition template, IReadOnlyList<VideoTemplateClip> clips,
        double duration, CancellationToken ct)
    {
        var fonts = Path.Combine(directory, "fonts");
        Directory.CreateDirectory(fonts);
        File.Copy(Path.Combine(AppContext.BaseDirectory, "Assets", "Fonts", "default.ttf"), Path.Combine(fonts, "default.ttf"));
        await File.WriteAllTextAsync(Path.Combine(directory, "timeline.ass"), BuildAss(title, template, clips, duration),
            new UTF8Encoding(encoderShouldEmitUTF8Identifier: true), ct);

        var args = new List<string> { "-nostdin", "-v", "error", "-f", "lavfi", "-i", $"color=c=0x{template.Paper}:s={Width}x{Height}:r=24:d={Number(duration)}" };
        var audioFilters = new StringBuilder();
        var inputs = new StringBuilder();
        for (var i = 0; i < clips.Count; i++)
        {
            args.AddRange(["-i", $"voice-{i}.mp3"]);
            var delay = (int)Math.Round(clips[i].AudioOffset * 1000);
            audioFilters.Append($"[{i + 1}:a]adelay={delay}:all=1[a{i}];");
            inputs.Append($"[a{i}]");
        }
        audioFilters.Append($"{inputs}amix=inputs={clips.Count}:normalize=0,apad[audio]");
        args.AddRange(["-vf", "ass=timeline.ass:fontsdir=fonts",
            "-filter_complex", audioFilters.ToString(), "-map", "0:v", "-map", "[audio]",
            "-t", Number(duration), "-c:v", "libx264", "-preset", "veryfast", "-threads", "2",
            "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", "video.mp4"]);
        await RunAsync("ffmpeg", directory, args, ct);

        var result = await RunAsync("ffprobe", directory,
            ["-v", "error", "-show_entries", "stream=codec_type,duration", "-of", "json", "video.mp4"], ct);
        using var inspection = JsonDocument.Parse(result.Output);
        var streams = inspection.RootElement.GetProperty("streams").EnumerateArray()
            .ToDictionary(stream => stream.GetProperty("codec_type").GetString()!,
                stream => double.Parse(stream.GetProperty("duration").GetString()!, CultureInfo.InvariantCulture));
        if (!streams.TryGetValue("video", out var video) || !streams.TryGetValue("audio", out var audio)
            || Math.Abs(video - duration) > 0.1 || Math.Abs(video - audio) > 0.1)
            throw new InvalidDataException("成片音画时长未对齐。");
    }

    internal static string BuildAss(string title, VideoTemplateDefinition template, IReadOnlyList<VideoTemplateClip> clips, double duration)
    {
        var ink = AssColor(template.Ink);
        var accent = AssColor(template.Accent);
        const string font = "Zhuque Fangsong (technical preview)";
        var ass = new StringBuilder($"""
            [Script Info]
            ScriptType: v4.00+
            PlayResX: {Width}
            PlayResY: {Height}
            WrapStyle: 2
            ScaledBorderAndShadow: yes

            [V4+ Styles]
            Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding
            Style: Ink,{font},34,{ink},{ink},{ink},{ink},0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1
            Style: Caption,{font},28,&H00FFFFFF,&H00FFFFFF,{ink},{ink},0,0,0,0,100,100,0,0,1,0,0,2,0,0,0,1

            [Events]
            Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text
            """).AppendLine();
        var dots = new StringBuilder();
        for (var y = 16; y < Height; y += 24)
        for (var x = 16; x < Width; x += 24)
            dots.Append($"m {x} {y} l {x+1} {y} {x+1} {y+1} {x} {y+1} ");
        Shape(0, duration, AssColor("C9C0AD"), dots.ToString(), 0);
        Add(1, 0, duration, "Ink", @"{\pos(89,62)\fs23}", template.Name);
        Add(1, 0, duration, "Ink", @"{\pos(86,92)\fs47}", title.Length > 22 ? title[..21] + "…" : title);
        Shape(0, duration, accent, "m 89 155 l 505 150 553 153 391 162 90 161", 0);
        for (var i = 0; i < clips.Count; i++)
        {
            var clip = clips[i];
            var start = Math.Max(0, clip.Caption.StartSeconds - 0.18);
            var end = clip.Caption.EndSeconds;
            var (x, y, w) = i switch
            {
                0 => (89, 210, 442),
                1 => (610, 190, 565),
                _ => (244, 420, 748),
            };
            var bottom = y + 145;
            Shape(start, duration, ink,
                $"m {x} {y} l {x+w} {y-3} {x+w+3} {bottom-2} {x-3} {bottom} {x} {y} " +
                $"m {x+3} {y+3} l {x} {bottom-3} {x+w} {bottom-5} {x+w-3} {y} {x+3} {y+3}", 0);
            Shape(start, end, accent, $"m {x+62} {y+61} l {x+354} {y+58} {x+316} {y+70} {x+62} {y+68}", 0);
            Add(1, start, duration, "Ink", $@"{{\pos({x+23},{y+23})\fs22}}", $"0{i+1}");
            Add(1, start, duration, "Ink", $@"{{\pos({x+63},{y+15})\fs34\fad(160,0)}}", clip.Scene.Heading);
            var note = i == 0 && clip.Scene.Note.Length > 15 ? clip.Scene.Note.Insert(15, "\n") : clip.Scene.Note;
            var noteLines = note.Split('\n');
            for (var line = 0; line < noteLines.Length; line++)
                Add(1, start + 0.11, duration, "Ink", $@"{{\pos({x+25},{y+78+line*27})\fs27\fad(200,0)}}", noteLines[line]);
            if (i == 1)
                Shape(start, duration, ink, "m 545 278 l 593 263 575 253 578 251 601 262 585 281 582 279 594 266 546 281", 0);
            if (i == 2)
                Shape(start, duration, ink, "m 1031 349 l 1035 401 1010 451 1008 443 1004 444 1007 461 1025 453 1024 449 1012 455 1039 401 1035 349", 0);
            Shape(clip.Caption.StartSeconds, end, ink, "m 32 638 l 1248 638 1248 704 32 704", 2);
            Add(3, clip.Caption.StartSeconds, end, "Caption", @"{\pos(640,686)}", clip.Caption.Text);
        }
        return ass.ToString();

        void Add(int layer, double start, double end, string style, string tags, string value)
        {
            ass.AppendLine($"Dialogue: {layer},{Time(start)},{Time(end)},{style},,0,0,0,,{tags}{Escape(value)}");
        }

        void Shape(double start, double end, string color, string path, int layer)
        {
            ass.AppendLine($@"Dialogue: {layer},{Time(start)},{Time(end)},Ink,,0,0,0,,{{\pos(0,0)\1c{color}\p1}}{path}{{\p0}}");
        }
    }

    private static string Escape(string text) => new(text.Select(c => c switch
    {
        '\\' => '＼', '{' => '｛', '}' => '｝', '\n' or '\r' => ' ', _ => c,
    }).ToArray());

    private static string AssColor(string rgb) => $"&H00{rgb[4..6]}{rgb[2..4]}{rgb[..2]}";
    private static string Time(double seconds) => TimeSpan.FromMilliseconds(Math.Round(seconds * 100) * 10).ToString(@"h\:mm\:ss\.ff", CultureInfo.InvariantCulture);
    private static string Number(double value) => value.ToString("0.###", CultureInfo.InvariantCulture);

    private static async Task<(string Output, string Diagnostics)> RunAsync(string command, string directory,
        IReadOnlyList<string> arguments, CancellationToken ct)
    {
        var info = new ProcessStartInfo(command) { WorkingDirectory = directory, RedirectStandardOutput = true,
            RedirectStandardError = true, UseShellExecute = false };
        foreach (var argument in arguments) info.ArgumentList.Add(argument);
        ct.ThrowIfCancellationRequested();
        using var process = Process.Start(info) ?? throw new InvalidOperationException("云端渲染器未启动。");
        var output = process.StandardOutput.ReadToEndAsync(ct);
        var diagnostics = process.StandardError.ReadToEndAsync(ct);
        try
        {
            await process.WaitForExitAsync(ct);
            var detail = await diagnostics;
            if (process.ExitCode != 0) throw new InvalidOperationException($"{command} 退出 {process.ExitCode}: {detail[..Math.Min(2048, detail.Length)]}");
            return (await output, detail);
        }
        catch (OperationCanceledException)
        {
            if (!process.HasExited) process.Kill(entireProcessTree: true);
            await process.WaitForExitAsync(CancellationToken.None);
            throw;
        }
    }
}
