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
}
