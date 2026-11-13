using System.Diagnostics;
using System.Globalization;
using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Services;
using PrdAgent.Infrastructure.Services.AssetStorage;

namespace PrdAgent.Api.Controllers.Api;

public partial class VideoAgentController
{
    private const long MaxImportedClipBytes = 100L * 1024 * 1024;
    private const long MaxImportedProjectBytes = 300L * 1024 * 1024;
    internal static readonly SemaphoreSlim ImportMediaSlots = new(1, 1);

    /// <summary>采用用户已有素材，不创建模型任务或借用历史执行许可。</summary>
    [HttpPost("projects/{projectId}/import-scenes")]
    [RequestSizeLimit(MaxImportedProjectBytes + 1024 * 1024)]
    [RequestFormLimits(MultipartBodyLengthLimit = MaxImportedProjectBytes + 1024 * 1024)]
    [Consumes("multipart/form-data")]
    public async Task<IActionResult> ImportScenes(string projectId)
    {
        var ct = HttpContext.RequestAborted;
        if (!await ImportMediaSlots.WaitAsync(0, ct))
            return StatusCode(StatusCodes.Status429TooManyRequests,
                ApiResponse<object>.Fail(ErrorCodes.RATE_LIMITED, "已有视频素材正在处理，请稍后重试导入。"));
        try
        {
            // 在读取和缓存表单前限制全进程并发；同一账号也至多占用一个名额。
            var form = await Request.ReadFormAsync(ct);
            return await ImportScenesCoreAsync(projectId, form.Files.Where(file => file.Name == "files").ToList(), ct);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { return StatusCode(499); }
        catch (InvalidDataException)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "视频表单无效或超过限制，请减少素材后重新导入。"));
        }
        finally { ImportMediaSlots.Release(); }
    }

    internal async Task<IActionResult> ImportScenesCoreAsync(string projectId, List<IFormFile> files, CancellationToken ct = default)
    {
        if (files.Count is < 1 or > 16 || files.Any(file => file.Length is <= 0 or > MaxImportedClipBytes)
            || files.Sum(file => file.Length) > MaxImportedProjectBytes)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "请选择1至16个视频，每个不超过100MB，合计不超过300MB。"));

        var owner = GetAdminId();
        var project = await _videoGenService.GetProjectAsync(projectId, owner, AppKey, ct);
        if (project == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "视频项目不存在。"));
        if (project.Status is not (VideoProjectStatus.Draft or VideoProjectStatus.Editing or VideoProjectStatus.Completed))
            return Conflict(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "项目正在生成或导出，请完成或停止当前任务后再导入。"));
        if (await HasActiveImportTargetAsync(project, owner, ct))
            return Conflict(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "项目中仍有分镜生成或导出任务，请完成或停止后再导入。"));

        var directory = Path.Combine(Path.GetTempPath(), $"prd-video-import-{Guid.NewGuid():N}");
        Directory.CreateDirectory(directory);
        var held = new List<IAsyncDisposable>();
        try
        {
            var clips = new List<ImportedVideoClip>();
            long normalizedBytes = 0;
            for (var index = 0; index < files.Count; index++)
            {
                var freeBytes = new DriveInfo(directory).AvailableFreeSpace;
                var budget = Math.Min(MaxImportedClipBytes, Math.Min(MaxImportedProjectBytes - normalizedBytes,
                    freeBytes - files[index].Length - 64L * 1024 * 1024));
                if (budget <= 0) throw new InvalidDataException("素材处理空间不足，请减少镜头或降低素材分辨率后重新导入。");
                var clip = await PrepareImportedClipAsync(files[index], directory, index, ct, budget);
                normalizedBytes += new FileInfo(clip.FilePath).Length;
                clips.Add(clip);
            }

            if (await HasActiveImportTargetAsync(project, owner, ct))
                return Conflict(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "导入期间项目启动了生成或导出，请完成或停止后重新导入。"));

            foreach (var sha in clips.Select(clip => clip.Sha256).Distinct().Order(StringComparer.Ordinal))
                held.Add(await VideoAssetMutationLease.AcquireAsync(_db, $"generated-video:{sha}", ct));

            var stored = new List<StoredAsset>();
            foreach (var clip in clips)
            {
                var asset = await _assetStorage.SaveAsync(await System.IO.File.ReadAllBytesAsync(clip.FilePath, ct),
                    "video/mp4", ct, domain: AppDomainPaths.DomainVideoAgent,
                    type: AppDomainPaths.TypeVideo, extensionHint: ".mp4");
                if (!string.Equals(asset.Sha256, clip.Sha256, StringComparison.OrdinalIgnoreCase))
                    throw new InvalidOperationException("导入素材摘要校验失败，请重新导入。");
                stored.Add(asset);
            }
            held.Add(await VideoAssetMutationLease.AcquireReferencesAsync(_db, stored.Select(asset => asset.Url), ct));

            if (await HasActiveImportTargetAsync(project, owner, ct))
                return Conflict(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "导入期间项目启动了生成或导出，请完成或停止后重新导入。"));

            ct.ThrowIfCancellationRequested();
            var run = BuildImportedRun(project, owner, ExportDeploymentScope, clips, stored);
            await _db.VideoGenRuns.InsertOneAsync(run, cancellationToken: CancellationToken.None);
            var tracks = BuildImportedTimeline(clips, run.Scenes);
            var changed = await _db.VideoProjects.UpdateOneAsync(item => item.Id == project.Id && item.OwnerAdminId == owner
                    && item.AppKey == AppKey && item.LatestRunId == project.LatestRunId && item.Status == project.Status
                    && item.UpdatedAt == project.UpdatedAt,
                Builders<VideoProject>.Update.Set(item => item.LatestRunId, run.Id)
                    .Set(item => item.LatestExportTaskId, null).Set(item => item.ExportHolderLeaseId, null)
                    .Set(item => item.Status, VideoProjectStatus.Editing).Set(item => item.TimelineTracks, tracks)
                    .Set(item => item.UpdatedAt, DateTime.UtcNow), cancellationToken: CancellationToken.None);
            if (changed.MatchedCount != 1)
            {
                await _db.VideoGenRuns.UpdateOneAsync(item => item.Id == run.Id && item.OwnerAdminId == owner && item.AppKey == AppKey,
                    Builders<VideoGenRun>.Update.Set(item => item.Status, VideoGenRunStatus.Failed)
                        .Set(item => item.ErrorCode, "IMPORT_PROJECT_CHANGED")
                        .Set(item => item.ErrorMessage, "导入时项目已被修改，素材已保留，请返回项目后重新导入。"), cancellationToken: CancellationToken.None);
                return Conflict(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "导入时项目已被修改，请返回项目后重新导入。"));
            }
            return Ok(ApiResponse<object>.Ok(new { runId = run.Id }));
        }
        catch (Exception ex) when (ex is InvalidDataException or InvalidOperationException or TimeoutException)
        {
            _logger.LogWarning(ex, "视频素材导入失败，项目 {ProjectId}", projectId);
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT,
                ex is InvalidDataException ? ex.Message : "视频素材处理失败。请确认文件可正常播放后重新导入；原项目与素材不会被删除。"));
        }
        finally
        {
            for (var index = held.Count - 1; index >= 0; index--) await held[index].DisposeAsync();
            try { Directory.Delete(directory, recursive: true); }
            catch (IOException ex) { _logger.LogWarning(ex, "视频导入临时文件清理失败"); }
        }
    }

    internal sealed record ImportedVideoClip(string FilePath, string Sha256, double DurationSeconds, string Name);

    private async Task<bool> HasActiveImportTargetAsync(VideoProject project, string owner, CancellationToken ct)
    {
        var filter = Builders<VideoGenRun>.Filter;
        var activeRuns = filter.Eq(run => run.ProjectId, project.Id) & filter.Eq(run => run.OwnerAdminId, owner)
            & filter.Eq(run => run.AppKey, AppKey) & filter.Eq(run => run.DeletionRequestedAt, null)
            & (filter.In(run => run.Status, new[] { VideoGenRunStatus.Queued, VideoGenRunStatus.ScopedQueued,
                VideoGenRunStatus.Scripting, VideoGenRunStatus.Rendering })
                | filter.ElemMatch(run => run.Scenes, scene => scene.Status == SceneItemStatus.Generating
                    || scene.Status == SceneItemStatus.Submitting || scene.Status == SceneItemStatus.SubmittingClaimed
                    || scene.Status == SceneItemStatus.Polling || scene.Status == SceneItemStatus.PollingClaimed
                    || scene.Status == SceneItemStatus.Rendering));
        if (await _db.VideoGenRuns.Find(activeRuns).AnyAsync(ct)) return true;
        return await _db.VideoExportTasks.Find(task => task.ProjectId == project.Id && task.OwnerAdminId == owner
            && task.AppKey == AppKey && (task.Status == VideoExportTaskStatus.Queued || task.Status == VideoExportTaskStatus.ScopedQueued
                || task.Status == VideoExportTaskStatus.Processing)).AnyAsync(ct);
    }

    internal static async Task<ImportedVideoClip> PrepareImportedClipAsync(IFormFile file, string directory, int index,
        CancellationToken ct = default, long maxOutputBytes = MaxImportedClipBytes)
    {
        if (file.Length is <= 0 or > MaxImportedClipBytes) throw new InvalidDataException("视频文件必须大于0且不超过100MB。");
        ct.ThrowIfCancellationRequested();
        var input = Path.Combine(directory, $"input-{index:D2}.bin");
        try
        {
            await using (var output = System.IO.File.Create(input))
            await using (var source = file.OpenReadStream())
            {
                var buffer = new byte[81920];
                long copied = 0;
                int read;
                while ((read = await source.ReadAsync(buffer, ct)) > 0)
                {
                    copied += read;
                    if (copied > MaxImportedClipBytes) throw new InvalidDataException("视频文件超过100MB。");
                    await output.WriteAsync(buffer.AsMemory(0, read), ct);
                }
            }
            var header = new byte[12];
            await using (var stream = System.IO.File.OpenRead(input))
            {
                if (await stream.ReadAsync(header, ct) != header.Length
                    || !(header.AsSpan(4, 4).SequenceEqual("ftyp"u8) || header.AsSpan(0, 4).SequenceEqual(new byte[] { 0x1a, 0x45, 0xdf, 0xa3 })))
                    throw new InvalidDataException("素材必须是MP4、MOV或WebM视频容器，不能使用播放列表或网页。");
            }
            var probe = await RunImportProcessAsync("ffprobe", ["-v", "error", "-protocol_whitelist", "file,pipe", "-threads", "2", "-select_streams", "v:0", "-show_entries", "stream=codec_type,width,height:format=duration", "-of", "json", input], TimeSpan.FromSeconds(20), ct);
            double duration;
            using (var json = JsonDocument.Parse(probe))
            {
                if (!json.RootElement.GetProperty("streams").EnumerateArray().Any(stream => stream.TryGetProperty("codec_type", out var type)
                    && type.GetString() == "video" && stream.TryGetProperty("width", out var width) && width.GetInt32() is > 0 and <= 4096
                    && stream.TryGetProperty("height", out var height) && height.GetInt32() is > 0 and <= 4096))
                    throw new InvalidDataException("素材没有可用画面，或画面尺寸超过4096像素。");
                if (!json.RootElement.GetProperty("format").TryGetProperty("duration", out var value)
                    || !double.TryParse(value.GetString(), NumberStyles.Float, CultureInfo.InvariantCulture, out duration)
                    || !double.IsFinite(duration) || duration is < 0.1 or > 60)
                    throw new InvalidDataException("每段视频时长须为0.1至60秒。");
            }
            var normalized = Path.Combine(directory, $"clip-{index:D2}.mp4");
            await RunImportProcessAsync("ffmpeg", ["-v", "error", "-y", "-protocol_whitelist", "file,pipe", "-threads", "2", "-filter_threads", "1", "-i", input,
                "-map", "0:v:0", "-map", "0:a:0?", "-sn", "-dn", "-t", duration.ToString("0.######", CultureInfo.InvariantCulture),
                "-vf", $"scale=trunc(iw/2)*2:trunc(ih/2)*2,tpad=stop_mode=clone:stop_duration={duration.ToString("0.######", CultureInfo.InvariantCulture)}", "-c:v", "libx264", "-threads", "2", "-preset", "veryfast", "-crf", "20",
                "-pix_fmt", "yuv420p", "-c:a", "aac", "-fs", maxOutputBytes.ToString(CultureInfo.InvariantCulture), "-movflags", "+faststart", normalized], TimeSpan.FromMinutes(3), ct);
            if (new FileInfo(normalized).Length > maxOutputBytes)
                throw new InvalidDataException("兼容处理后的视频超过剩余大小或临时空间限制，请减少镜头、缩短或降低素材分辨率后重新导入。");
            var normalizedProbe = await RunImportProcessAsync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", normalized], TimeSpan.FromSeconds(20), ct);
            var normalizedDuration = double.Parse(normalizedProbe.Trim(), CultureInfo.InvariantCulture);
            if (normalizedDuration + 0.04 < duration)
                throw new InvalidDataException("素材处理达到大小限制，未保存截断镜头，请缩短或降低分辨率后重新导入。");
            duration = normalizedDuration;
            await using var normalizedStream = System.IO.File.OpenRead(normalized);
            var sha256 = Convert.ToHexString(await SHA256.HashDataAsync(normalizedStream, ct)).ToLowerInvariant();
            var name = Path.GetFileNameWithoutExtension(file.FileName.Replace('\\', '/'));
            name = new string(name.Where(character => !char.IsControl(character)).Take(80).ToArray()).Trim();
            return new(normalized, sha256, duration, string.IsNullOrWhiteSpace(name) ? $"镜头 {index + 1}" : name);
        }
        finally { System.IO.File.Delete(input); }
    }

    internal static VideoGenRun BuildImportedRun(VideoProject project, string owner, string? deployment,
        IReadOnlyList<ImportedVideoClip> clips, IReadOnlyList<StoredAsset> assets) => new()
    {
        AppKey = AppKey, OwnerAdminId = owner, ProjectId = project.Id, DeploymentSlug = deployment,
        Mode = VideoGenMode.Storyboard, Status = VideoGenRunStatus.Editing, CurrentPhase = "editing", PhaseProgress = 100,
        ArticleTitle = project.Title, ArticleMarkdown = project.SourceMarkdown, DirectAspectRatio = project.DefaultAspectRatio,
        DirectResolution = project.DefaultResolution, GenerateAudio = false, QueueEnteredAt = null,
        TotalDurationSeconds = clips.Sum(clip => clip.DurationSeconds),
        Scenes = clips.Select((clip, index) =>
        {
            var version = new VideoGenSceneVersion { VideoUrl = assets[index].Url, AssetSha256 = assets[index].Sha256,
                Duration = (int)Math.Ceiling(clip.DurationSeconds), Prompt = clip.Name };
            return new VideoGenScene { Index = index, Topic = clip.Name, Prompt = clip.Name, Status = SceneItemStatus.Done,
                VideoUrl = version.VideoUrl, Duration = version.Duration, ActiveVersionId = version.Id, Versions = [version] };
        }).ToList(),
    };

    internal static List<VideoTimelineTrack> BuildImportedTimeline(IReadOnlyList<ImportedVideoClip> clips, IReadOnlyList<VideoGenScene> scenes)
    {
        var tracks = new VideoProject().TimelineTracks;
        double start = 0;
        for (var index = 0; index < clips.Count; index++)
        {
            tracks[0].Clips.Add(new VideoTimelineClip { SceneIndex = index, StartSeconds = start,
                DurationSeconds = clips[index].DurationSeconds, AssetUrl = scenes[index].VideoUrl });
            start += clips[index].DurationSeconds;
        }
        return tracks;
    }

    internal static async Task<string> RunImportProcessAsync(string executable, IEnumerable<string> arguments, TimeSpan timeout, CancellationToken ct = default)
    {
        ct.ThrowIfCancellationRequested();
        var info = new ProcessStartInfo(executable) { RedirectStandardError = true, RedirectStandardOutput = true,
            UseShellExecute = false, CreateNoWindow = true };
        foreach (var argument in arguments) info.ArgumentList.Add(argument);
        using var process = Process.Start(info) ?? throw new InvalidOperationException("媒体处理工具不可用。");
        var output = process.StandardOutput.ReadToEndAsync();
        var error = process.StandardError.ReadToEndAsync();
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
        deadline.CancelAfter(timeout);
        try { await process.WaitForExitAsync(deadline.Token); }
        catch (OperationCanceledException)
        {
            try { process.Kill(entireProcessTree: true); } catch (InvalidOperationException) { }
            await process.WaitForExitAsync(CancellationToken.None);
            await Task.WhenAll(output, error);
            ct.ThrowIfCancellationRequested();
            throw new TimeoutException("媒体处理超时，请缩短素材后重新导入。");
        }
        _ = await error;
        if (process.ExitCode != 0) throw new InvalidDataException("媒体文件无法解码，请确认文件可播放后重新导入。");
        return await output;
    }
}
