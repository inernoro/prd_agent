using PrdAgent.Core.Models;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public class WritingTeachingPolicyTests
{
    private static WritingPublication Source() => new() {
        Version = 1, Title = "测试交接", IntentPoints = new() { "正式租户禁止执行" },
        IntentCoverage = new() { new WritingIntentCoverage { IntentIndex = 0, ParagraphIds = new() { "p1" }, Confirmed = true } },
        Sections = new() { new WritingSection { Id = "s1", Title = "执行条件", Condition = "仅测试租户", Paragraphs = new() {
            new WritingParagraph { Id = "p1", Text = "正式租户禁止执行", Confirmed = true }
        } }, new WritingSection { Id = "s2", Title = "概述", Paragraphs = new() { new WritingParagraph { Id = "p2", Text = "说明" } } } }
    };
    private static WritingTeachingScene Scene() => new() { Id = "scene-1", SectionId = "s1", ParagraphIds = new() { "p1" }, IntentIndexes = new() { 0 }, Title = "先确认执行范围", Highlights = new() { "正式租户禁止执行" }, Narration = "只有测试租户可执行，正式租户禁止执行。" };

    [Fact]
    public void ModelCannotAttachAnExistingSpeechOrInventTiming()
    {
        var scene = Scene(); scene.SpeechRunId = "another-audio"; scene.Start = 999; scene.Duration = 999;
        var prepared = WritingTeachingPolicy.PrepareGeneratedScript(Source(), new() { scene });
        Assert.Null(prepared[0].SpeechRunId); Assert.Equal(0, prepared[0].Start); Assert.Equal(0, prepared[0].Duration);
    }

    [Fact]
    public void MalformedModelArraysAreRejectedBeforeTheyCanBecomeResumableState()
    {
        Assert.Throws<InvalidOperationException>(() => WritingTeachingPolicy.PrepareGeneratedScript(Source(), new() { null! }));
        var scene = Scene(); scene.ParagraphIds = null!;
        Assert.Throws<InvalidOperationException>(() => WritingTeachingPolicy.PrepareGeneratedScript(Source(), new() { scene }));
    }

    [Fact]
    public void SceneCannotUseAnUnrelatedChapterToHideTheActualCondition()
    {
        var scene = Scene(); scene.SectionId = "s2";
        Assert.Throws<InvalidOperationException>(() => WritingTeachingPolicy.ValidateScript(Source(), new() { scene }));
    }

    [Fact]
    public void MissingAuthorPointOrAnOpenQuestionStopsProductionBeforeTts()
    {
        var scene = Scene(); scene.IntentIndexes.Clear();
        Assert.Throws<InvalidOperationException>(() => WritingTeachingPolicy.ValidateScript(Source(), new() { scene }));
        scene.IntentIndexes.Add(0); var source = Source(); source.OpenQuestions.Add(new WritingQuestion { ParagraphId = "p1" });
        Assert.Throws<InvalidOperationException>(() => WritingTeachingPolicy.ValidateScript(source, new() { scene }));
    }

    [Fact]
    public void RoundedFramesAreTheSingleClockForChaptersSubtitlesAndVideo()
    {
        var teaching = new WritingTeaching { Scenes = new() { Scene(), Scene() } };
        WritingTeachingPolicy.SetTiming(teaching, new[] { 7.824, 3.101 });
        Assert.Equal(235d / 30, teaching.Scenes[0].Duration, 10);
        Assert.Equal(teaching.Scenes[0].Duration, teaching.Scenes[1].Start, 10);
        Assert.Equal(teaching.Scenes.Sum(s => s.Duration), teaching.Duration, 10);
        Assert.Throws<InvalidOperationException>(() => WritingTeachingPolicy.SetTiming(teaching, new[] { double.NaN, 1d }));
    }

    [Fact]
    public void OldVideoCanOnlyBeReadForItsFrozenSourceVersion()
    {
        var source = Source(); var teaching = new WritingTeaching { Source = WritingTeachingPolicy.Freeze(source), SourceFingerprint = WritingTeachingPolicy.SourceFingerprint(source) };
        Assert.True(WritingTeachingPolicy.Matches(teaching, source));
        source.Version++; source.Sections[0].Condition = "另一个范围";
        Assert.False(WritingTeachingPolicy.Matches(teaching, source));
        Assert.Equal("仅测试租户", teaching.Source.Sections[0].Condition);
    }
    [Fact]
    public void SourceIdentitySurvivesMongoDateNormalizationWithoutDroppingMeaning()
    {
        var source = Source();
        var fingerprint = WritingTeachingPolicy.SourceFingerprint(source);
        var bytes = MongoDB.Bson.BsonExtensionMethods.ToBson(source);
        var restored = MongoDB.Bson.Serialization.BsonSerializer.Deserialize<WritingPublication>(bytes);
        Assert.Equal(fingerprint, WritingTeachingPolicy.SourceFingerprint(restored));
        restored.Sections[0].Condition = "正式租户也可执行";
        Assert.NotEqual(fingerprint, WritingTeachingPolicy.SourceFingerprint(restored));
    }

    [Fact]
    [Trait("Category", TestCategories.Integration)]
    public async Task RealNarrationRendersBothLayoutsWithoutTruncatingTheLastAudio()
    {
        var audio = Environment.GetEnvironmentVariable("WRITING_TTS_TEST_FILE") ?? throw new InvalidOperationException("Explicit real narration file required");
        var folder = Environment.GetEnvironmentVariable("WRITING_RENDER_EVIDENCE_DIR") ?? throw new InvalidOperationException("Explicit isolated output folder required");
        Directory.CreateDirectory(folder);
        var scene = Scene(); scene.Narration = "仅测试租户可执行。正式租户禁止执行。失败后立即停止，不得重复提交。";
        var teaching = new WritingTeaching { Source = Source(), Scenes = new() { scene } };
        var duration = await PrdAgent.Api.Services.WritingTeachingRenderer.ProbeDurationAsync(audio, () => Task.CompletedTask);
        var slow = await PrdAgent.Api.Services.WritingTeachingRenderer.SlowAudioAsync(audio, Path.Combine(folder, "slow-narration.wav"), () => Task.CompletedTask);
        var slowerDuration = await PrdAgent.Api.Services.WritingTeachingRenderer.ProbeDurationAsync(slow, () => Task.CompletedTask);
        Assert.InRange(slowerDuration / duration, 1.2, 1.3);
        WritingTeachingPolicy.SetTiming(teaching, new[] { duration });
        foreach (var portrait in new[] { false, true }) {
            var output = await PrdAgent.Api.Services.WritingTeachingRenderer.RenderAsync(teaching, new[] { audio }, folder, portrait, () => Task.CompletedTask);
            var actual = await PrdAgent.Api.Services.WritingTeachingRenderer.ProbeDurationAsync(output, () => Task.CompletedTask);
            Assert.InRange(actual - duration, -0.02, 0.15);
            Assert.True(new FileInfo(output).Length > 10000);
        }
    }
}
