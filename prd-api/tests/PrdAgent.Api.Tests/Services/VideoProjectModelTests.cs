using PrdAgent.Api.Services;
using PrdAgent.Core.Models;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public class VideoProjectModelTests
{
    [Fact]
    public void NewProject_ShouldExposeProfessionalTimelineTracks()
    {
        var project = new VideoProject();

        project.Id.Length.ShouldBe(32);
        project.Status.ShouldBe(VideoProjectStatus.Draft);
        project.TimelineTracks.Select(track => track.Type).ShouldBe([
            VideoTrackType.Video,
            VideoTrackType.Subtitle,
            VideoTrackType.Voice,
            VideoTrackType.Music,
        ]);
    }

    [Fact]
    public void Run_ShouldRemainSeparateFromProjectAggregate()
    {
        var project = new VideoProject();
        var run = new VideoGenRun { ProjectId = project.Id };

        run.Id.ShouldNotBe(project.Id);
        run.ProjectId.ShouldBe(project.Id);
        project.LatestRunId.ShouldBeNull();
        run.GenerateAudio.ShouldBeTrue();
    }

    [Fact]
    public void ExportTask_ShouldHaveIndependentIdentityAndProgress()
    {
        var task = new VideoExportTask { ProjectId = "project", RunId = "run" };

        task.Id.Length.ShouldBe(32);
        task.Status.ShouldBe(VideoExportTaskStatus.Queued);
        task.CurrentPhase.ShouldBe("queued");
    }

    [Fact]
    public void SceneActivity_ShouldKeepProjectRenderingUntilEverySceneIsTerminal()
    {
        VideoGenRunWorker.ResolveProjectStatusForScenes([
            new VideoGenScene { Status = SceneItemStatus.Done },
            new VideoGenScene { Status = SceneItemStatus.Rendering },
        ]).ShouldBe(VideoProjectStatus.Rendering);

        VideoGenRunWorker.ResolveProjectStatusForScenes([
            new VideoGenScene { Status = SceneItemStatus.Done },
            new VideoGenScene { Status = SceneItemStatus.Submitting },
        ]).ShouldBe(VideoProjectStatus.Rendering);

        VideoGenRunWorker.ResolveProjectStatusForScenes([
            new VideoGenScene { Status = SceneItemStatus.Done },
            new VideoGenScene { Status = SceneItemStatus.PollingClaimed },
        ]).ShouldBe(VideoProjectStatus.Rendering);

        VideoGenRunWorker.ResolveProjectStatusForScenes([
            new VideoGenScene { Status = SceneItemStatus.Done },
            new VideoGenScene { Status = SceneItemStatus.Error },
        ]).ShouldBe(VideoProjectStatus.Editing);
    }

    [Theory]
    [InlineData("alibaba/wan-2.6", 6, 5)]
    [InlineData("alibaba/wan-2.6", 8, 10)]
    [InlineData("seedance-2.0", 14, 15)]
    [InlineData("seedance-1.5", 7, 8)]
    public void Duration_ShouldMatchActualVideoModelCapabilities(
        string modelId,
        int requested,
        int expected)
    {
        VideoModelCapabilities.NormalizeDuration(modelId, requested).ShouldBe(expected);
    }
}
