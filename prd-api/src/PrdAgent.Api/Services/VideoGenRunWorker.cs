using System.Diagnostics;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.LlmGateway;

namespace PrdAgent.Api.Services;

/// <summary>
/// 视频生成后台执行器（交互式流程）
/// 两条处理路径：
///   1. Queued → Scripting → Editing（分镜生成完成，等待用户编辑）
///   2. Rendering → Completed（用户点击"导出"后触发渲染）
/// 同时轮询 Editing 状态中 Generating 的分镜，进行单条重试。
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

    /// <summary>推荐语速：3.7 字/秒</summary>
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
            try
            {
                // 路径 1: Queued → Scripting → Editing
                var queued = await ClaimQueuedRunAsync(stoppingToken);
                if (queued != null)
                {
                    try
                    {
                        await ProcessScriptingAsync(queued);
                    }
                    catch (Exception ex)
                    {
                        _logger.LogError(ex, "VideoGenRunWorker 分镜生成失败: runId={RunId}", queued.Id);
                        await FailRunAsync(queued, "SCRIPTING_ERROR", ex.Message);
                    }
                    continue;
                }

                // 路径 2: Rendering → Completed
                var rendering = await ClaimRenderingRunAsync(stoppingToken);
                if (rendering != null)
                {
                    try
                    {
                        await ProcessRenderingAsync(rendering);
                    }
                    catch (Exception ex)
                    {
                        _logger.LogError(ex, "VideoGenRunWorker 渲染失败: runId={RunId}", rendering.Id);
                        await FailRunAsync(rendering, "RENDER_ERROR", ex.Message);
                    }
                    continue;
                }

                // 路径 3: Editing 状态中有 Generating 分镜 → 单条重试
                var edited = await FindEditingRunWithGeneratingSceneAsync(stoppingToken);
                if (edited != null)
                {
                    try
                    {
                        await ProcessSceneRegenerationAsync(edited);
                    }
                    catch (Exception ex)
                    {
                        _logger.LogError(ex, "VideoGenRunWorker 分镜重试失败: runId={RunId}", edited.Id);
                    }
                    continue;
                }
            }
            catch (OperationCanceledException)
            {
                break;
            }

            await Task.Delay(2000, stoppingToken);
        }
    }

    // ─── Claim Methods ───

    private async Task<VideoGenRun?> ClaimQueuedRunAsync(CancellationToken ct)
    {
        var filter = Builders<VideoGenRun>.Filter.Eq(x => x.Status, VideoGenRunStatus.Queued);
        var update = Builders<VideoGenRun>.Update
            .Set(x => x.Status, VideoGenRunStatus.Scripting)
            .Set(x => x.StartedAt, DateTime.UtcNow)
            .Set(x => x.CurrentPhase, "scripting");

        return await _db.VideoGenRuns.FindOneAndUpdateAsync(filter, update,
            new FindOneAndUpdateOptions<VideoGenRun> { ReturnDocument = ReturnDocument.After }, ct);
    }

    private async Task<VideoGenRun?> ClaimRenderingRunAsync(CancellationToken ct)
    {
        // 只拾取 Rendering 状态 + PhaseProgress == 0（未开始的）
        var filter = Builders<VideoGenRun>.Filter.And(
            Builders<VideoGenRun>.Filter.Eq(x => x.Status, VideoGenRunStatus.Rendering),
            Builders<VideoGenRun>.Filter.Eq(x => x.PhaseProgress, 0));
        var update = Builders<VideoGenRun>.Update
            .Set(x => x.PhaseProgress, 1); // 标记为已领取

        return await _db.VideoGenRuns.FindOneAndUpdateAsync(filter, update,
            new FindOneAndUpdateOptions<VideoGenRun> { ReturnDocument = ReturnDocument.After }, ct);
    }

    private async Task<VideoGenRun?> FindEditingRunWithGeneratingSceneAsync(CancellationToken ct)
    {
        // 查找 Editing 状态中有 Generating 分镜的 Run
        var filter = Builders<VideoGenRun>.Filter.And(
            Builders<VideoGenRun>.Filter.Eq(x => x.Status, VideoGenRunStatus.Editing),
            Builders<VideoGenRun>.Filter.ElemMatch(x => x.Scenes,
                Builders<VideoGenScene>.Filter.Eq(s => s.Status, SceneItemStatus.Generating)));

        return await _db.VideoGenRuns.Find(filter).FirstOrDefaultAsync(ct);
    }

    // ─── 路径 1: 分镜生成（Queued → Scripting → Editing）───

    private async Task ProcessScriptingAsync(VideoGenRun run)
    {
        if (run.CancelRequested) { await CancelRunAsync(run); return; }

        _logger.LogInformation("VideoGen 分镜生成开始: runId={RunId}", run.Id);

        await UpdatePhaseAsync(run, "scripting", 10);
        await PublishEventAsync(run.Id, "phase.changed", new { phase = "scripting", progress = 10 });

        using var scope = _scopeFactory.CreateScope();
        var gateway = scope.ServiceProvider.GetRequiredService<ILlmGateway>();

        // 构建系统提示词（可能包含用户自定义系统提示词和风格描述）
        var systemPrompt = BuildScriptSystemPrompt(run.SystemPrompt, run.StyleDescription);
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

        await UpdatePhaseAsync(run, "scripting", 30);
        await PublishEventAsync(run.Id, "phase.changed", new { phase = "scripting", progress = 30 });

        var response = await gateway.SendAsync(request, CancellationToken.None);
        if (!response.Success)
        {
            throw new InvalidOperationException($"LLM 分镜生成失败: {response.ErrorMessage}");
        }

        await UpdatePhaseAsync(run, "scripting", 80);

        // 解析分镜
        var scenes = ParseScenesFromLlmResponse(response.Content);
        // 所有分镜初始状态为 Done（LLM 生成的默认即可用）
        foreach (var s in scenes)
        {
            s.Status = SceneItemStatus.Done;
        }

        var totalDuration = scenes.Sum(s => s.DurationSeconds);
        var scriptMd = GenerateScriptMarkdown(scenes, run.ArticleTitle);
        var narrationDoc = GenerateNarrationDoc(scenes, run.ArticleTitle);

        // 关键：状态切换为 Editing（等待用户交互）
        await _db.VideoGenRuns.UpdateOneAsync(
            x => x.Id == run.Id,
            Builders<VideoGenRun>.Update
                .Set(x => x.Status, VideoGenRunStatus.Editing)
                .Set(x => x.Scenes, scenes)
                .Set(x => x.TotalDurationSeconds, totalDuration)
                .Set(x => x.ScriptMarkdown, scriptMd)
                .Set(x => x.NarrationDoc, narrationDoc)
                .Set(x => x.CurrentPhase, "editing")
                .Set(x => x.PhaseProgress, 100),
            cancellationToken: CancellationToken.None);

        await PublishEventAsync(run.Id, "script.done", new
        {
            scenes,
            totalDuration,
            status = VideoGenRunStatus.Editing
        });

        _logger.LogInformation("VideoGen 分镜生成完成: runId={RunId}, scenes={Count}, duration={Duration}s → Editing",
            run.Id, scenes.Count, totalDuration);
    }

    // ─── 路径 2: 视频渲染（Rendering → Completed）───

    private async Task ProcessRenderingAsync(VideoGenRun run)
    {
        if (run.CancelRequested) { await CancelRunAsync(run); return; }

        _logger.LogInformation("VideoGen 渲染开始: runId={RunId}, scenes={Count}", run.Id, run.Scenes.Count);

        // 2a: 生成 Remotion 数据文件
        await UpdatePhaseAsync(run, "rendering", 5);
        await PublishEventAsync(run.Id, "phase.changed", new { phase = "rendering", progress = 5 });

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

        // 2b: 执行 Remotion 渲染
        var outDir = Path.Combine(videoProjectPath, "out");
        Directory.CreateDirectory(outDir);
        var outputMp4 = Path.Combine(outDir, $"{run.Id}.mp4");

        await UpdatePhaseAsync(run, "rendering", 10);
        await RunRemotionRenderAsync(run, videoProjectPath, dataFilePath, outputMp4);

        // 2c: 生成 SRT 字幕
        var srtContent = GenerateSrt(run.Scenes);
        var srtFilePath = Path.Combine(outDir, $"{run.Id}.srt");
        await File.WriteAllTextAsync(srtFilePath, srtContent, Encoding.UTF8, CancellationToken.None);

        // 2d: 重新生成文档（使用用户编辑后的最终分镜）
        var scriptMd = GenerateScriptMarkdown(run.Scenes, run.ArticleTitle);
        var narrationDoc = GenerateNarrationDoc(run.Scenes, run.ArticleTitle);

        // 2e: 完成
        await _db.VideoGenRuns.UpdateOneAsync(
            x => x.Id == run.Id,
            Builders<VideoGenRun>.Update
                .Set(x => x.Status, VideoGenRunStatus.Completed)
                .Set(x => x.VideoAssetUrl, outputMp4)
                .Set(x => x.SrtContent, srtContent)
                .Set(x => x.ScriptMarkdown, scriptMd)
                .Set(x => x.NarrationDoc, narrationDoc)
                .Set(x => x.CurrentPhase, "completed")
                .Set(x => x.PhaseProgress, 100)
                .Set(x => x.EndedAt, DateTime.UtcNow),
            cancellationToken: CancellationToken.None);

        await PublishEventAsync(run.Id, "run.completed", new
        {
            videoUrl = outputMp4,
            totalDuration = run.TotalDurationSeconds,
            scenesCount = run.Scenes.Count,
        });

        _logger.LogInformation("VideoGen 渲染完成: runId={RunId}", run.Id);
    }

    // ─── 路径 3: 单条分镜重新生成 ───

    private async Task ProcessSceneRegenerationAsync(VideoGenRun run)
    {
        // 找到第一个 Generating 状态的分镜
        var sceneIdx = run.Scenes.FindIndex(s => s.Status == SceneItemStatus.Generating);
        if (sceneIdx < 0) return;

        var scene = run.Scenes[sceneIdx];
        _logger.LogInformation("VideoGen 分镜重试: runId={RunId}, sceneIndex={Index}", run.Id, sceneIdx);

        try
        {
            using var scope = _scopeFactory.CreateScope();
            var gateway = scope.ServiceProvider.GetRequiredService<ILlmGateway>();

            var systemPrompt = BuildSceneRegeneratePrompt(run.SystemPrompt, run.StyleDescription);
            var userPrompt = $"""
                请重新生成以下分镜的内容。

                原始文章片段或上下文：
                {run.ArticleMarkdown[..Math.Min(run.ArticleMarkdown.Length, 2000)]}

                当前分镜信息：
                - 序号：{scene.Index + 1}/{run.Scenes.Count}
                - 主题：{scene.Topic}
                - 类型：{scene.SceneType}
                - 旁白：{scene.Narration}

                请优化此分镜，输出格式同标准分镜 JSON（单个对象，不是数组）。
                """;

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
                TimeoutSeconds = 60
            };

            var response = await gateway.SendAsync(request, CancellationToken.None);
            if (!response.Success)
            {
                throw new InvalidOperationException($"LLM 分镜重试失败: {response.ErrorMessage}");
            }

            // 解析单条分镜
            var newScene = ParseSingleSceneFromLlmResponse(response.Content);
            newScene.Index = sceneIdx;
            newScene.Status = SceneItemStatus.Done;

            run.Scenes[sceneIdx] = newScene;
            var totalDuration = run.Scenes.Sum(s => s.DurationSeconds);

            await _db.VideoGenRuns.UpdateOneAsync(
                x => x.Id == run.Id,
                Builders<VideoGenRun>.Update
                    .Set(x => x.Scenes, run.Scenes)
                    .Set(x => x.TotalDurationSeconds, totalDuration),
                cancellationToken: CancellationToken.None);

            await PublishEventAsync(run.Id, "scene.regenerated", new
            {
                sceneIndex = sceneIdx,
                scene = newScene,
                totalDuration
            });

            _logger.LogInformation("VideoGen 分镜重试完成: runId={RunId}, sceneIndex={Index}", run.Id, sceneIdx);
        }
        catch (Exception ex)
        {
            // 标记分镜为 Error，不影响其他分镜
            run.Scenes[sceneIdx].Status = SceneItemStatus.Error;
            run.Scenes[sceneIdx].ErrorMessage = ex.Message;

            await _db.VideoGenRuns.UpdateOneAsync(
                x => x.Id == run.Id,
                Builders<VideoGenRun>.Update.Set(x => x.Scenes, run.Scenes),
                cancellationToken: CancellationToken.None);

            await PublishEventAsync(run.Id, "scene.error", new
            {
                sceneIndex = sceneIdx,
                error = ex.Message
            });
        }
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

        // 必须并发消费 stdout 和 stderr，否则 OS 管道缓冲区满后进程会死锁
        var stderrBuilder = new StringBuilder();
        var stderrTask = Task.Run(async () =>
        {
            while (!process.StandardError.EndOfStream)
            {
                var line = await process.StandardError.ReadLineAsync();
                if (line != null) stderrBuilder.AppendLine(line);
            }
        });

        var lastProgress = 0;
        while (!process.StandardOutput.EndOfStream)
        {
            var line = await process.StandardOutput.ReadLineAsync();
            if (line == null) continue;

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
                        // 渲染进度映射到 10-95 区间
                        var mappedProgress = 10 + (int)(pct * 0.85);
                        await UpdatePhaseAsync(run, "rendering", mappedProgress);
                        await PublishEventAsync(run.Id, "render.progress", new { percent = mappedProgress });
                    }
                }
            }
        }

        await stderrTask;
        await process.WaitForExitAsync();

        if (process.ExitCode != 0)
        {
            throw new InvalidOperationException($"Remotion 渲染失败 (exit code {process.ExitCode}): {stderrBuilder}");
        }
    }

    private static string BuildScriptSystemPrompt(string? userSystemPrompt, string? styleDescription)
    {
        var sb = new StringBuilder();
        sb.AppendLine("""
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
            """);

        if (!string.IsNullOrWhiteSpace(userSystemPrompt))
        {
            sb.AppendLine();
            sb.AppendLine("额外指导要求：");
            sb.AppendLine(userSystemPrompt);
        }

        if (!string.IsNullOrWhiteSpace(styleDescription))
        {
            sb.AppendLine();
            sb.AppendLine("视觉风格要求：");
            sb.AppendLine(styleDescription);
        }

        return sb.ToString();
    }

    private static string BuildSceneRegeneratePrompt(string? userSystemPrompt, string? styleDescription)
    {
        var sb = new StringBuilder();
        sb.AppendLine("""
            你是一个专业的技术视频脚本编写者。请优化给定的分镜，改善旁白和画面描述。

            输出格式为单个 JSON 对象（不是数组）：
            ```json
            {
              "topic": "优化后的主题",
              "narration": "优化后的旁白",
              "visualDescription": "优化后的画面描述",
              "sceneType": "保持原类型或优化"
            }
            ```

            只输出 JSON，不要包含其他文字。
            """);

        if (!string.IsNullOrWhiteSpace(userSystemPrompt))
        {
            sb.AppendLine();
            sb.AppendLine("额外指导要求：");
            sb.AppendLine(userSystemPrompt);
        }

        if (!string.IsNullOrWhiteSpace(styleDescription))
        {
            sb.AppendLine();
            sb.AppendLine("视觉风格要求：");
            sb.AppendLine(styleDescription);
        }

        return sb.ToString();
    }

    /// <summary>
    /// 从 Gateway SendAsync 返回的原始 HTTP 响应体中提取 LLM 生成的文本内容。
    /// SendAsync 返回原始响应 JSON（如 OpenAI 格式 {"choices":[{"message":{"content":"..."}}]}），
    /// 需要先提取 message.content，再剥离 DeepSeek-R1 等推理模型的 &lt;think&gt; 标签。
    /// </summary>
    private static string ExtractLlmContent(string rawResponseBody)
    {
        var text = rawResponseBody.Trim();

        // 尝试从 OpenAI 格式 JSON 中提取 choices[0].message.content
        if (text.StartsWith("{"))
        {
            try
            {
                using var doc = JsonDocument.Parse(text);
                var root = doc.RootElement;
                if (root.TryGetProperty("choices", out var choices)
                    && choices.GetArrayLength() > 0)
                {
                    var firstChoice = choices[0];
                    if (firstChoice.TryGetProperty("message", out var message)
                        && message.TryGetProperty("content", out var content))
                    {
                        text = content.GetString() ?? "";
                    }
                }
            }
            catch (JsonException)
            {
                // 不是标准 OpenAI 格式，保持原样继续解析
            }
        }

        // 剥离 DeepSeek-R1 等模型的 <think>...</think> 推理标签
        text = Regex.Replace(text, @"<think>[\s\S]*?</think>", "", RegexOptions.IgnoreCase).Trim();

        return text;
    }

    private static List<VideoGenScene> ParseScenesFromLlmResponse(string content)
    {
        var jsonContent = ExtractLlmContent(content);

        if (jsonContent.StartsWith("```"))
        {
            var firstNewline = jsonContent.IndexOf('\n');
            if (firstNewline > 0) jsonContent = jsonContent[(firstNewline + 1)..];
            if (jsonContent.EndsWith("```")) jsonContent = jsonContent[..^3];
            jsonContent = jsonContent.Trim();
        }

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

        for (var i = 0; i < parsed.Count; i++)
        {
            parsed[i].Index = i;
            var charCount = parsed[i].Narration?.Length ?? 0;
            parsed[i].DurationSeconds = Math.Max(3, Math.Round(charCount / CharsPerSecond, 1));
        }

        return parsed;
    }

    private static VideoGenScene ParseSingleSceneFromLlmResponse(string content)
    {
        var jsonContent = ExtractLlmContent(content);

        if (jsonContent.StartsWith("```"))
        {
            var firstNewline = jsonContent.IndexOf('\n');
            if (firstNewline > 0) jsonContent = jsonContent[(firstNewline + 1)..];
            if (jsonContent.EndsWith("```")) jsonContent = jsonContent[..^3];
            jsonContent = jsonContent.Trim();
        }

        var startIdx = jsonContent.IndexOf('{');
        var endIdx = jsonContent.LastIndexOf('}');
        if (startIdx >= 0 && endIdx > startIdx)
        {
            jsonContent = jsonContent[startIdx..(endIdx + 1)];
        }

        var parsed = JsonSerializer.Deserialize<VideoGenScene>(jsonContent, new JsonSerializerOptions
        {
            PropertyNameCaseInsensitive = true
        });

        if (parsed == null)
        {
            throw new InvalidOperationException("LLM 返回的分镜格式无效");
        }

        var charCount = parsed.Narration?.Length ?? 0;
        parsed.DurationSeconds = Math.Max(3, Math.Round(charCount / CharsPerSecond, 1));

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

    private static string GenerateSrt(List<VideoGenScene> scenes)
    {
        var sb = new StringBuilder();
        var subtitleIndex = 1;
        double cumTime = 0;

        foreach (var scene in scenes)
        {
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
