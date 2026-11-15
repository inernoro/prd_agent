using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using MongoDB.Bson;
using PrdAgent.Api.Services;
using PrdAgent.Api.Services.Speech;
using PrdAgent.Core.Models;
using PrdAgent.Core.Services;
using PrdAgent.Infrastructure.Services;

namespace PrdAgent.Api.Controllers.Api;

public partial class VideoAgentController
{
    public sealed class AdoptVideoNarrationRequest
    {
        public string SpeechRunId { get; set; } = string.Empty;
    }

    [HttpGet("runs/{runId}/narration")]
    public async Task<IActionResult> GetNarration(string runId)
    {
        var run = await _videoGenService.GetRunAsync(runId, GetAdminId(), AppKey, CancellationToken.None);
        if (run == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "视频任务不存在"));
        if (!VideoGenService.IsExportBranchScope(run.DeploymentSlug, ExportDeploymentScope, ExportDurableScope))
            return Conflict(ApiResponse<object>.Fail("NARRATION_DEPLOYMENT_MISMATCH", "请回到任务所属分支查看配音。"));
        return Ok(ApiResponse<object>.Ok(NarrationResult(run)));
    }

    [HttpPut("runs/{runId}/scenes/{sceneIndex:int}/narration")]
    public async Task<IActionResult> AdoptNarration(string runId, int sceneIndex,
        [FromBody] AdoptVideoNarrationRequest request, [FromServices] SpeechGenerationService speech)
    {
        var owner = GetAdminId();
        var run = await _videoGenService.GetRunAsync(runId, owner, AppKey, CancellationToken.None);
        if (run == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "视频任务不存在"));
        if (!VideoGenService.IsExportBranchScope(run.DeploymentSlug, ExportDeploymentScope, ExportDurableScope))
            return Conflict(ApiResponse<object>.Fail("NARRATION_DEPLOYMENT_MISMATCH", "请回到任务所属分支采用配音。"));
        if (run.Mode != VideoGenMode.Storyboard || run.Status is not (VideoGenRunStatus.Editing or VideoGenRunStatus.Completed)
            || run.CancelRequested || run.DeletionRequestedAt != null)
            return Conflict(ApiResponse<object>.Fail("NARRATION_NOT_EDITABLE", "请等待当前任务结束后再采用配音；导出过程中不能修改。"));
        if (sceneIndex < 0 || sceneIndex >= run.Scenes.Count || run.Scenes[sceneIndex].Status != SceneItemStatus.Done
            || string.IsNullOrWhiteSpace(run.Scenes[sceneIndex].VideoUrl))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "请先为这个镜头采用已完成的视频素材。"));
        var scene = run.Scenes[sceneIndex];
        var speechRun = await speech.GetRunAsync(owner, request.SpeechRunId);
        if (speechRun == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "当前环境中没有可用的本人语音任务。请刷新语音列表后重新选择。"));
        if (speechRun.Status != SpeechRunStatus.Completed || string.IsNullOrWhiteSpace(speechRun.Text) || speechRun.Text.Length > 2000)
            return Conflict(ApiResponse<object>.Fail("NARRATION_NOT_READY", "请选择已完成且正文不超过 2000 字的语音任务。"));
        try
        {
            var audio = await speech.ReadAudioAsync(owner, speechRun.Id, normalizeForMedia: true);
            var duration = await VideoNarrationMedia.ProbeAudioDurationAsync(audio.Bytes);
            var project = string.IsNullOrEmpty(run.ProjectId) ? null
                : await _videoGenService.GetProjectAsync(run.ProjectId, owner, AppKey, CancellationToken.None);
            if (project != null && project.LatestRunId != run.Id)
                return Conflict(ApiResponse<object>.Fail("NARRATION_PROJECT_CHANGED", "项目已有新的制作任务，请打开当前任务后再采用配音。"));
            var videoDuration = await ReadAdoptedVideoDurationAsync(scene);
            var clips = project?.TimelineTracks.FirstOrDefault(track => track.Type == VideoTrackType.Video)?.Clips
                .Where(item => item.SceneIndex == sceneIndex).ToList() ?? [];
            var effectiveDuration = clips.Count == 0 ? videoDuration : clips.Min(clip =>
                videoDuration - Math.Max(0, clip.TrimStartSeconds) - Math.Max(0, clip.TrimEndSeconds));
            VideoNarrationTimeline.ValidateDuration(duration, effectiveDuration);
            var narration = new VideoSceneNarration { SpeechRunId = speechRun.Id, Text = speechRun.Text, DurationSeconds = duration };
            if (scene.Narration?.SpeechRunId == speechRun.Id && scene.Narration.Text == narration.Text)
                return Ok(ApiResponse<object>.Ok(NarrationResult(run)));
            if (!await SaveNarrationAsync(run, sceneIndex, narration))
                return Conflict(ApiResponse<object>.Fail("NARRATION_CHANGED", "任务已被修改或正在导出，请刷新后重新采用；没有重新生成语音。"));
            scene.Narration = narration;
            return Ok(ApiResponse<object>.Ok(NarrationResult(run)));
        }
        catch (SpeechException ex)
        {
            return StatusCode(ex.StatusCode, ApiResponse<object>.Fail(ex.Code, ex.Message));
        }
        catch (InvalidOperationException ex)
        {
            return BadRequest(ApiResponse<object>.Fail("NARRATION_MEDIA_INVALID", ex.Message));
        }
        catch (System.ComponentModel.Win32Exception)
        {
            return StatusCode(503, ApiResponse<object>.Fail("NARRATION_TOOLS_UNAVAILABLE", "媒体探测工具不可用，请联系管理员后重新采用配音。"));
        }
        catch (HttpRequestException)
        {
            return StatusCode(503, ApiResponse<object>.Fail("NARRATION_VIDEO_UNAVAILABLE", "采用的视频素材暂不可读，请稍后重试或重新导入本镜素材。"));
        }
    }

    private async Task<double> ReadAdoptedVideoDurationAsync(VideoGenScene scene)
    {
        var directory = Path.Combine(Path.GetTempPath(), "prd-video-narration-check-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            var path = Path.Combine(directory, "video.mp4");
            using var client = _httpClientFactory.CreateClient("AssetStorageStream");
            await VideoSceneMedia.CopyToFileAsync(_assetStorage, client, scene, path, 1024L * 1024 * 1024, CancellationToken.None);
            return await VideoNarrationMedia.ProbeDurationAsync(path, requireAudio: false);
        }
        finally { try { Directory.Delete(directory, true); } catch (IOException) { } }
    }

    internal async Task<bool> SaveNarrationAsync(VideoGenRun run, int sceneIndex, VideoSceneNarration narration)
    {
        var scene = run.Scenes[sceneIndex];
        var f = Builders<VideoGenRun>.Filter;
        var identity = f.Eq(x => x.Id, run.Id) & f.Eq(x => x.OwnerAdminId, GetAdminId()) & f.Eq(x => x.AppKey, AppKey)
            & f.Eq(x => x.DeploymentSlug, run.DeploymentSlug) & f.Eq(x => x.ProjectId, run.ProjectId)
            & f.Eq(x => x.Status, run.Status) & f.Eq(x => x.LatestExportTaskId, run.LatestExportTaskId)
            & f.Eq(x => x.CancelRequested, false) & f.Eq(x => x.DeletionRequestedAt, null)
            & f.Eq($"Scenes.{sceneIndex}.VideoUrl", scene.VideoUrl)
            & (scene.ActiveVersionId == null
                ? f.Type($"Scenes.{sceneIndex}.ActiveVersionId", BsonType.Null) | f.Exists($"Scenes.{sceneIndex}.ActiveVersionId", false)
                : f.Eq($"Scenes.{sceneIndex}.ActiveVersionId", scene.ActiveVersionId))
            & f.Eq($"Scenes.{sceneIndex}.Status", SceneItemStatus.Done)
            // 数字数组路径上的 Eq(null) 还会匹配非空对象，不能充当首次采用的并发保护。
            & (scene.Narration == null
                ? f.Type($"Scenes.{sceneIndex}.Narration", BsonType.Null) | f.Exists($"Scenes.{sceneIndex}.Narration", false)
                : f.Eq($"Scenes.{sceneIndex}.Narration", scene.Narration));
        var changed = await _db.VideoGenRuns.UpdateOneAsync(identity,
            Builders<VideoGenRun>.Update.Set($"Scenes.{sceneIndex}.Narration", narration)
                .Set(x => x.Status, VideoGenRunStatus.Editing).Set(x => x.CurrentPhase, "editing").Set(x => x.PhaseProgress, 100)
                .Set(x => x.VideoAssetUrl, (string?)null).Set(x => x.ExportedAt, (DateTime?)null)
                .Set(x => x.ExportErrorMessage, (string?)null).Set(x => x.EndedAt, (DateTime?)null),
            cancellationToken: CancellationToken.None);
        return changed.MatchedCount == 1;
    }

    private static object NarrationResult(VideoGenRun run) => new
    {
        items = run.Scenes.Select((scene, index) => new
        {
            sceneIndex = index, text = scene.Narration?.Text ?? string.Empty,
            speechRunId = scene.Narration?.SpeechRunId,
            status = scene.Narration == null ? "empty" : "adopted",
            durationSeconds = scene.Narration?.DurationSeconds,
        }),
    };
}
