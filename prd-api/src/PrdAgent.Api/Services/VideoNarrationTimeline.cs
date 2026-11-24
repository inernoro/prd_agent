using PrdAgent.Core.Models;

namespace PrdAgent.Api.Services;

/// <summary>逐镜旁白按实际采用顺序排布，不使用原始分镜序号推算时间。</summary>
public static class VideoNarrationTimeline
{
    public static void ValidateDuration(double narrationDuration, double sceneDuration)
    {
        if (!double.IsFinite(narrationDuration) || narrationDuration <= 0
            || !double.IsFinite(sceneDuration) || sceneDuration <= 0)
            throw new InvalidOperationException("配音或画面的时长无效，请更换素材后重新导出。");
        if (narrationDuration > sceneDuration + 0.04)
            throw new InvalidOperationException("配音超过镜头可用时长，请缩短本段配音或采用更长的镜头后重新导出。");
    }

    public static IReadOnlyList<VideoTimelineClip> BuildSubtitles(
        IReadOnlyList<(VideoGenScene Scene, double EffectiveDuration)> orderedScenes)
    {
        var clips = new List<VideoTimelineClip>();
        double cursor = 0;
        foreach (var (scene, effectiveDuration) in orderedScenes)
        {
            if (scene.Narration is { } narration)
            {
                ValidateDuration(narration.DurationSeconds, effectiveDuration);
                clips.Add(new VideoTimelineClip
                {
                    SceneIndex = scene.Index,
                    StartSeconds = cursor,
                    DurationSeconds = narration.DurationSeconds,
                    Text = narration.Text,
                });
            }
            cursor += effectiveDuration;
        }
        return clips;
    }
}
