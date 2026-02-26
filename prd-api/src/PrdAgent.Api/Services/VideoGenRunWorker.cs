using System.Diagnostics;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.LlmGateway;

namespace PrdAgent.Api.Services;

/// <summary>
/// 视频生成后台执行器：4 阶段流水线（脚本→Remotion→渲染→打包）
/// 遵循服务器权威性设计：核心处理使用 CancellationToken.None
/// </summary>
public class VideoGenRunWorker : BackgroundService
{
    private readonly MongoDbContext _db;
    private readonly IServiceScopeFactory _scopeFactory;
    private readonly IRunEventStore _runStore;
    private readonly ILogger<VideoGenRunWorker> _logger;
    private readonly IConfiguration _configuration;

    private static readonly JsonSerializerOptions JsonOpts = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

    /// <summary>
    /// 推荐语速：3.7 字/秒
    /// </summary>
    private const double CharsPerSecond = 3.7;

    public VideoGenRunWorker(
        MongoDbContext db,
        IServiceScopeFactory scopeFactory,
        IRunEventStore runStore,
        ILogger<VideoGenRunWorker> logger,
        IConfiguration configuration)
    {
        _db = db;
        _scopeFactory = scopeFactory;
        _runStore = runStore;
        _logger = logger;
        _configuration = configuration;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            VideoGenRun? run = null;
            try
            {
                run = await ClaimNextRunAsync(stoppingToken);
            }
            catch (OperationCanceledException)
            {
                break;
            }

            if (run == null)
            {
                await Task.Delay(2000, stoppingToken);
                continue;
            }

            try
            {
                await ProcessRunAsync(run);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "VideoGenRunWorker 执行失败: runId={RunId}", run.Id);
                await FailRunAsync(run, "WORKER_ERROR", ex.Message);
            }
        }
    }

    private async Task<VideoGenRun?> ClaimNextRunAsync(CancellationToken ct)
    {
        var filter = Builders<VideoGenRun>.Filter.Eq(x => x.Status, VideoGenRunStatus.Queued);
        var update = Builders<VideoGenRun>.Update
            .Set(x => x.Status, VideoGenRunStatus.Scripting)
            .Set(x => x.StartedAt, DateTime.UtcNow)
            .Set(x => x.CurrentPhase, "scripting");

        return await _db.VideoGenRuns.FindOneAndUpdateAsync(filter, update,
            new FindOneAndUpdateOptions<VideoGenRun> { ReturnDocument = ReturnDocument.After },
            ct);
    }

    private async Task ProcessRunAsync(VideoGenRun run)
    {
        // 检查取消
        if (run.CancelRequested)
        {
            await CancelRunAsync(run);
            return;
        }

        // 阶段一：内容分析与脚本规划
        await PhaseScriptingAsync(run);
        if (run.CancelRequested) { await CancelRunAsync(run); return; }

        // 阶段二：Remotion 数据生成
        await PhaseProducingAsync(run);
        if (run.CancelRequested) { await CancelRunAsync(run); return; }

        // 阶段三：渲染与字幕
        await PhaseRenderingAsync(run);
        if (run.CancelRequested) { await CancelRunAsync(run); return; }

        // 阶段四：打包交付
        await PhasePackagingAsync(run);
    }

    /// <summary>
    /// 阶段一：通过 LLM 将文章拆分为视频脚本
    /// </summary>
    private async Task PhaseScriptingAsync(VideoGenRun run)
    {
        _logger.LogInformation("VideoGen 阶段一开始: runId={RunId}", run.Id);

        await UpdatePhaseAsync(run, "scripting", 0);
        await PublishEventAsync(run.Id, "phase.changed", new { phase = "scripting", progress = 0 });

        using var scope = _scopeFactory.CreateScope();
        var gateway = scope.ServiceProvider.GetRequiredService<ILlmGateway>();

        var systemPrompt = BuildScriptSystemPrompt();
        var userPrompt = $"请将以下技术文章转化为视频脚本：\n\n{run.ArticleMarkdown}";

        var request = new GatewayRequest
        {
            AppCallerCode = AppCallerRegistry.VideoAgent.Script.Chat,
            ModelType = "chat",
            RequestBody = new JsonObject
            {
                ["messages"] = new JsonArray
                {
                    new JsonObject { ["role"] = "system", ["content"] = systemPrompt },
                    new JsonObject { ["role"] = "user", ["content"] = userPrompt }
                }
            },
            Stream = false,
            TimeoutSeconds = 120
        };

        var response = await gateway.SendAsync(request, CancellationToken.None);
        if (!response.Success)
        {
            throw new InvalidOperationException($"LLM 脚本生成失败: {response.ErrorMessage}");
        }

        // 解析 LLM 返回的 JSON
        var scenes = ParseScenesFromLlmResponse(response.Content);
        var totalDuration = scenes.Sum(s => s.DurationSeconds);

        // 生成脚本 Markdown 和台词文档
        var scriptMd = GenerateScriptMarkdown(scenes, run.ArticleTitle);
        var narrationDoc = GenerateNarrationDoc(scenes, run.ArticleTitle);

        // 更新 Run 记录
        await _db.VideoGenRuns.UpdateOneAsync(
            x => x.Id == run.Id,
            Builders<VideoGenRun>.Update
                .Set(x => x.Scenes, scenes)
                .Set(x => x.TotalDurationSeconds, totalDuration)
                .Set(x => x.ScriptMarkdown, scriptMd)
                .Set(x => x.NarrationDoc, narrationDoc)
                .Set(x => x.PhaseProgress, 100),
            cancellationToken: CancellationToken.None);

        run.Scenes = scenes;
        run.TotalDurationSeconds = totalDuration;
        run.ScriptMarkdown = scriptMd;
        run.NarrationDoc = narrationDoc;

        await PublishEventAsync(run.Id, "script.done", new { scenes, totalDuration });
        await RefreshCancelFlag(run);

        _logger.LogInformation("VideoGen 阶段一完成: runId={RunId}, scenes={Count}, duration={Duration}s",
            run.Id, scenes.Count, totalDuration);
    }

    /// <summary>
    /// 阶段二：生成 Remotion 数据文件
    /// </summary>
    private async Task PhaseProducingAsync(VideoGenRun run)
    {
        _logger.LogInformation("VideoGen 阶段二开始: runId={RunId}", run.Id);

        await UpdatePhaseAsync(run, "producing", 0);
        await PublishEventAsync(run.Id, "phase.changed", new { phase = "producing", progress = 0 });

        // 生成 video_data.json 供 Remotion 使用
        var videoProjectPath = GetVideoProjectPath();
        var dataDir = Path.Combine(videoProjectPath, "data");
        Directory.CreateDirectory(dataDir);

        var videoData = new
        {
            title = run.ArticleTitle ?? "技术教程",
            fps = 30,
            width = 1920,
            height = 1080,
            scenes = run.Scenes.Select(s => new
            {
                index = s.Index,
                topic = s.Topic,
                narration = s.Narration,
                visualDescription = s.VisualDescription,
                durationSeconds = s.DurationSeconds,
                durationInFrames = (int)Math.Ceiling(s.DurationSeconds * 30),
                sceneType = s.SceneType,
            }).ToList()
        };

        var dataJson = JsonSerializer.Serialize(videoData, new JsonSerializerOptions
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
            WriteIndented = true
        });

        var dataFilePath = Path.Combine(dataDir, $"{run.Id}.json");
        await File.WriteAllTextAsync(dataFilePath, dataJson, CancellationToken.None);

        await UpdatePhaseAsync(run, "producing", 100);
        await PublishEventAsync(run.Id, "production.done", new { dataFile = dataFilePath });
        await RefreshCancelFlag(run);

        _logger.LogInformation("VideoGen 阶段二完成: runId={RunId}, dataFile={DataFile}", run.Id, dataFilePath);
    }

    /// <summary>
    /// 阶段三：执行 Remotion 渲染 + SRT 字幕生成
    /// </summary>
    private async Task PhaseRenderingAsync(VideoGenRun run)
    {
        _logger.LogInformation("VideoGen 阶段三开始: runId={RunId}", run.Id);

        await UpdatePhaseAsync(run, "rendering", 0);
        await PublishEventAsync(run.Id, "phase.changed", new { phase = "rendering", progress = 0 });

        var videoProjectPath = GetVideoProjectPath();
        var outDir = Path.Combine(videoProjectPath, "out");
        Directory.CreateDirectory(outDir);

        var dataFilePath = Path.Combine(videoProjectPath, "data", $"{run.Id}.json");
        var outputMp4 = Path.Combine(outDir, $"{run.Id}.mp4");

        // 执行 Remotion 渲染
        await RunRemotionRenderAsync(run, videoProjectPath, dataFilePath, outputMp4);

        // 生成 SRT 字幕
        var srtContent = GenerateSrt(run.Scenes);

        var srtFilePath = Path.Combine(outDir, $"{run.Id}.srt");
        await File.WriteAllTextAsync(srtFilePath, srtContent, Encoding.UTF8, CancellationToken.None);

        // 更新 Run 记录
        await _db.VideoGenRuns.UpdateOneAsync(
            x => x.Id == run.Id,
            Builders<VideoGenRun>.Update
                .Set(x => x.SrtContent, srtContent)
                .Set(x => x.VideoAssetUrl, outputMp4)
                .Set(x => x.PhaseProgress, 100),
            cancellationToken: CancellationToken.None);

        run.SrtContent = srtContent;
        run.VideoAssetUrl = outputMp4;

        await PublishEventAsync(run.Id, "render.done", new { videoUrl = outputMp4 });
        await RefreshCancelFlag(run);

        _logger.LogInformation("VideoGen 阶段三完成: runId={RunId}, mp4={Mp4}, srt={Srt}",
            run.Id, outputMp4, srtFilePath);
    }

    /// <summary>
    /// 阶段四：打包交付
    /// </summary>
    private async Task PhasePackagingAsync(VideoGenRun run)
    {
        _logger.LogInformation("VideoGen 阶段四开始: runId={RunId}", run.Id);

        await UpdatePhaseAsync(run, "packaging", 0);
        await PublishEventAsync(run.Id, "phase.changed", new { phase = "packaging", progress = 0 });

        // 更新为完成状态
        await _db.VideoGenRuns.UpdateOneAsync(
            x => x.Id == run.Id,
            Builders<VideoGenRun>.Update
                .Set(x => x.Status, VideoGenRunStatus.Completed)
                .Set(x => x.CurrentPhase, "completed")
                .Set(x => x.PhaseProgress, 100)
                .Set(x => x.EndedAt, DateTime.UtcNow),
            cancellationToken: CancellationToken.None);

        await PublishEventAsync(run.Id, "run.completed", new
        {
            videoUrl = run.VideoAssetUrl,
            srtContent = run.SrtContent,
            narrationDoc = run.NarrationDoc,
            totalDuration = run.TotalDurationSeconds,
            scenesCount = run.Scenes.Count,
        });

        _logger.LogInformation("VideoGen 全部完成: runId={RunId}, totalDuration={Duration}s",
            run.Id, run.TotalDurationSeconds);
    }

    // ─── Helper Methods ───

    private async Task RunRemotionRenderAsync(VideoGenRun run, string projectPath, string dataFile, string outputMp4)
    {
        var psi = new ProcessStartInfo
        {
            FileName = "npx",
            Arguments = $"remotion render TutorialVideo \"{outputMp4}\" --props=\"{dataFile}\"",
            WorkingDirectory = projectPath,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
        };

        using var process = Process.Start(psi);
        if (process == null)
        {
            throw new InvalidOperationException("无法启动 Remotion 渲染进程");
        }

        var lastProgress = 0;
        // 读取 stdout 解析渲染进度
        while (!process.StandardOutput.EndOfStream)
        {
            var line = await process.StandardOutput.ReadLineAsync();
            if (line == null) continue;

            // Remotion 输出格式示例: "Rendered frame 150/300 (50%)"
            if (line.Contains('%'))
            {
                var pctIdx = line.IndexOf('%');
                if (pctIdx > 0)
                {
                    var start = pctIdx - 1;
                    while (start > 0 && char.IsDigit(line[start - 1])) start--;
                    if (int.TryParse(line[start..pctIdx], out var pct) && pct > lastProgress)
                    {
                        lastProgress = pct;
                        await UpdatePhaseAsync(run, "rendering", pct);
                        await PublishEventAsync(run.Id, "render.progress", new { percent = pct });
                    }
                }
            }
        }

        await process.WaitForExitAsync();

        if (process.ExitCode != 0)
        {
            var stderr = await process.StandardError.ReadToEndAsync();
            throw new InvalidOperationException($"Remotion 渲染失败 (exit code {process.ExitCode}): {stderr}");
        }
    }

    private static string BuildScriptSystemPrompt()
    {
        return """
            你是一个专业的技术视频脚本编写者。你的任务是将技术文章转化为8-10个视频镜头的脚本。

            请严格按照以下 JSON 格式输出，不要包含任何其他文字：

            ```json
            [
              {
                "index": 0,
                "topic": "镜头主题（一句话概括）",
                "narration": "旁白文本（朗读的台词）",
                "visualDescription": "画面描述（该镜头展示的视觉元素）",
                "sceneType": "intro"
              }
            ]
            ```

            sceneType 可选值：
            - intro: 开场介绍
            - concept: 概念解释
            - steps: 步骤演示
            - code: 代码展示
            - comparison: 对比说明
            - diagram: 图表/架构
            - summary: 总结回顾
            - outro: 结尾

            规则：
            1. 第一个镜头必须是 intro 类型，最后一个必须是 outro 类型
            2. 旁白文本要口语化、自然，适合朗读
            3. 每个镜头的旁白控制在 20-60 字之间
            4. 画面描述要具体，包含可视化的元素（标题、卡片、代码块、流程图等）
            5. 确保所有关键信息都被覆盖，不遗漏重要内容
            6. 只输出 JSON 数组，不要包含 markdown 代码块标记
            """;
    }

    private static List<VideoGenScene> ParseScenesFromLlmResponse(string content)
    {
        // 尝试提取 JSON 数组
        var jsonContent = content.Trim();

        // 移除 markdown 代码块标记
        if (jsonContent.StartsWith("```"))
        {
            var firstNewline = jsonContent.IndexOf('\n');
            if (firstNewline > 0) jsonContent = jsonContent[(firstNewline + 1)..];
            if (jsonContent.EndsWith("```")) jsonContent = jsonContent[..^3];
            jsonContent = jsonContent.Trim();
        }

        // 找到 JSON 数组边界
        var startIdx = jsonContent.IndexOf('[');
        var endIdx = jsonContent.LastIndexOf(']');
        if (startIdx >= 0 && endIdx > startIdx)
        {
            jsonContent = jsonContent[startIdx..(endIdx + 1)];
        }

        var parsed = JsonSerializer.Deserialize<List<VideoGenScene>>(jsonContent, new JsonSerializerOptions
        {
            PropertyNameCaseInsensitive = true
        });

        if (parsed == null || parsed.Count == 0)
        {
            throw new InvalidOperationException("LLM 返回的脚本格式无效：未解析到任何场景");
        }

        // 计算时长
        for (var i = 0; i < parsed.Count; i++)
        {
            parsed[i].Index = i;
            var charCount = parsed[i].Narration?.Length ?? 0;
            parsed[i].DurationSeconds = Math.Max(3, Math.Round(charCount / CharsPerSecond, 1));
        }

        return parsed;
    }

    private static string GenerateScriptMarkdown(List<VideoGenScene> scenes, string? title)
    {
        var sb = new StringBuilder();
        sb.AppendLine($"# 视频脚本：{title ?? "技术教程"}");
        sb.AppendLine();
        sb.AppendLine($"**总时长**：{scenes.Sum(s => s.DurationSeconds):F1} 秒 ({scenes.Sum(s => s.DurationSeconds) / 60:F1} 分钟)");
        sb.AppendLine($"**镜头数**：{scenes.Count}");
        sb.AppendLine();

        foreach (var scene in scenes)
        {
            sb.AppendLine($"## 镜头 {scene.Index + 1}：{scene.Topic}");
            sb.AppendLine();
            sb.AppendLine($"- **类型**：{scene.SceneType}");
            sb.AppendLine($"- **时长**：{scene.DurationSeconds:F1}s（{scene.Narration.Length} 字）");
            sb.AppendLine($"- **旁白**：{scene.Narration}");
            sb.AppendLine($"- **画面**：{scene.VisualDescription}");
            sb.AppendLine();
        }

        return sb.ToString();
    }

    private static string GenerateNarrationDoc(List<VideoGenScene> scenes, string? title)
    {
        var sb = new StringBuilder();
        sb.AppendLine($"# 剪映配音台词：{title ?? "技术教程"}");
        sb.AppendLine();
        sb.AppendLine("> 以下为每个镜头的配音台词和建议语气。总时长约 " +
            $"{scenes.Sum(s => s.DurationSeconds) / 60:F1} 分钟。");
        sb.AppendLine();

        double cumTime = 0;
        foreach (var scene in scenes)
        {
            var startTs = TimeSpan.FromSeconds(cumTime);
            var endTs = TimeSpan.FromSeconds(cumTime + scene.DurationSeconds);
            sb.AppendLine($"### [{startTs:mm\\:ss} - {endTs:mm\\:ss}] 镜头 {scene.Index + 1}：{scene.Topic}");
            sb.AppendLine();

            var tone = scene.SceneType switch
            {
                "intro" => "热情、引导性",
                "concept" => "平稳、解释性",
                "steps" => "清晰、条理性",
                "code" => "专注、技术性",
                "comparison" => "对比、强调差异",
                "diagram" => "描述性、指引性",
                "summary" => "总结、回顾性",
                "outro" => "收尾、鼓励性",
                _ => "自然"
            };

            sb.AppendLine($"**语气**：{tone}");
            sb.AppendLine();
            sb.AppendLine($"> {scene.Narration}");
            sb.AppendLine();
            cumTime += scene.DurationSeconds;
        }

        return sb.ToString();
    }

    /// <summary>
    /// 生成 SRT 字幕（内置实现，不依赖外部 Python 脚本）
    /// </summary>
    private static string GenerateSrt(List<VideoGenScene> scenes)
    {
        var sb = new StringBuilder();
        var subtitleIndex = 1;
        double cumTime = 0;

        foreach (var scene in scenes)
        {
            // 按标点拆分旁白为 ≤20 字的片段
            var segments = SplitNarration(scene.Narration, 20);
            var totalChars = segments.Sum(s => s.Length);

            foreach (var seg in segments)
            {
                var ratio = (double)seg.Length / Math.Max(totalChars, 1);
                var segDuration = scene.DurationSeconds * ratio;

                var startTs = TimeSpan.FromSeconds(cumTime);
                var endTs = TimeSpan.FromSeconds(cumTime + segDuration);

                sb.AppendLine(subtitleIndex.ToString());
                sb.AppendLine($"{FormatSrtTime(startTs)} --> {FormatSrtTime(endTs)}");
                sb.AppendLine(seg);
                sb.AppendLine();

                cumTime += segDuration;
                subtitleIndex++;
            }
        }

        return sb.ToString();
    }

    private static List<string> SplitNarration(string text, int maxLen)
    {
        var result = new List<string>();
        if (string.IsNullOrWhiteSpace(text)) return result;

        // 按标点分割
        var delimiters = new[] { '。', '，', '；', '！', '？', '、', '.', ',', ';', '!', '?' };
        var current = new StringBuilder();

        foreach (var ch in text)
        {
            current.Append(ch);
            if (delimiters.Contains(ch) && current.Length >= 5)
            {
                result.Add(current.ToString().Trim());
                current.Clear();
            }
            else if (current.Length >= maxLen)
            {
                result.Add(current.ToString().Trim());
                current.Clear();
            }
        }

        if (current.Length > 0)
        {
            if (result.Count > 0 && current.Length < 5)
            {
                result[^1] += current.ToString().Trim();
            }
            else
            {
                result.Add(current.ToString().Trim());
            }
        }

        return result.Where(s => !string.IsNullOrWhiteSpace(s)).ToList();
    }

    private static string FormatSrtTime(TimeSpan ts)
    {
        return $"{(int)ts.TotalHours:D2}:{ts.Minutes:D2}:{ts.Seconds:D2},{ts.Milliseconds:D3}";
    }

    private string GetVideoProjectPath()
    {
        var path = _configuration["VideoAgent:RemotionProjectPath"];
        if (string.IsNullOrWhiteSpace(path))
        {
            // 默认相对于应用程序目录向上找 prd-video
            var baseDir = AppContext.BaseDirectory;
            path = Path.GetFullPath(Path.Combine(baseDir, "..", "..", "..", "..", "..", "prd-video"));
        }
        return path;
    }

    private async Task UpdatePhaseAsync(VideoGenRun run, string phase, int progress)
    {
        await _db.VideoGenRuns.UpdateOneAsync(
            x => x.Id == run.Id,
            Builders<VideoGenRun>.Update
                .Set(x => x.CurrentPhase, phase)
                .Set(x => x.PhaseProgress, progress),
            cancellationToken: CancellationToken.None);
    }

    private async Task PublishEventAsync(string runId, string eventName, object payload)
    {
        try
        {
            await _runStore.AppendEventAsync(RunKinds.VideoGen, runId, eventName, payload,
                ttl: TimeSpan.FromHours(2), ct: CancellationToken.None);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "VideoGen 事件发布失败: runId={RunId}, event={Event}", runId, eventName);
        }
    }

    private async Task RefreshCancelFlag(VideoGenRun run)
    {
        var fresh = await _db.VideoGenRuns.Find(x => x.Id == run.Id).FirstOrDefaultAsync(CancellationToken.None);
        if (fresh != null) run.CancelRequested = fresh.CancelRequested;
    }

    private async Task FailRunAsync(VideoGenRun run, string errorCode, string errorMessage)
    {
        await _db.VideoGenRuns.UpdateOneAsync(
            x => x.Id == run.Id,
            Builders<VideoGenRun>.Update
                .Set(x => x.Status, VideoGenRunStatus.Failed)
                .Set(x => x.ErrorCode, errorCode)
                .Set(x => x.ErrorMessage, errorMessage)
                .Set(x => x.EndedAt, DateTime.UtcNow),
            cancellationToken: CancellationToken.None);

        await PublishEventAsync(run.Id, "run.error", new { code = errorCode, message = errorMessage });
    }

    private async Task CancelRunAsync(VideoGenRun run)
    {
        await _db.VideoGenRuns.UpdateOneAsync(
            x => x.Id == run.Id,
            Builders<VideoGenRun>.Update
                .Set(x => x.Status, VideoGenRunStatus.Cancelled)
                .Set(x => x.EndedAt, DateTime.UtcNow),
            cancellationToken: CancellationToken.None);

        await PublishEventAsync(run.Id, "run.cancelled", new { });
        _logger.LogInformation("VideoGen 已取消: runId={RunId}", run.Id);
    }
}
