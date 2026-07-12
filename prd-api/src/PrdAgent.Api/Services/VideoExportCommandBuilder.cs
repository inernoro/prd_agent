namespace PrdAgent.Api.Services;

/// <summary>构建分镜合成所需的 ffmpeg 参数，集中处理不同画幅和编码归一化。</summary>
public static class VideoExportCommandBuilder
{
    public static IReadOnlyList<string> Build(
        IReadOnlyList<string> inputFiles,
        string outputFile,
        string? aspectRatio)
    {
        if (inputFiles.Count == 0) throw new ArgumentException("至少需要一个分镜文件", nameof(inputFiles));
        var (width, height) = GetDimensions(aspectRatio);
        var filters = inputFiles.Select((_, index) =>
            $"[{index}:v]scale={width}:{height}:force_original_aspect_ratio=decrease," +
            $"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:color=black," +
            $"setsar=1,fps=30,format=yuv420p[v{index}]");
        var concatInputs = string.Concat(inputFiles.Select((_, index) => $"[v{index}]"));
        var filterComplex = string.Join(";", filters) +
                            $";{concatInputs}concat=n={inputFiles.Count}:v=1:a=0[outv]";

        var args = new List<string> { "-y" };
        foreach (var inputFile in inputFiles)
        {
            args.Add("-i");
            args.Add(inputFile);
        }

        args.AddRange([
            "-filter_complex", filterComplex,
            "-map", "[outv]",
            "-an",
            "-c:v", "libx264",
            "-preset", "medium",
            "-crf", "20",
            "-movflags", "+faststart",
            outputFile,
        ]);
        return args;
    }

    public static (int Width, int Height) GetDimensions(string? aspectRatio) => aspectRatio switch
    {
        "9:16" => (720, 1280),
        "1:1" => (720, 720),
        "4:3" => (960, 720),
        "3:4" => (720, 960),
        "21:9" => (1260, 540),
        "9:21" => (540, 1260),
        _ => (1280, 720),
    };
}
