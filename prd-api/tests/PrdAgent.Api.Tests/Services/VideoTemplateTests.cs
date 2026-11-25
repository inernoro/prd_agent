using PrdAgent.Api.Services;
using PrdAgent.Api.Services.BackgroundTasks;
using PrdAgent.Core.Models;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public sealed class VideoTemplateTests
{
    [Fact]
    public void Admission_AllowsOneScriptAndThreeSpeechCalls_WithoutExtendingOtherVideoActions()
    {
        const string controller = "PrdAgent.Api.Controllers.Api.VideoAgentController";
        var template = Assert.IsType<TaskAdmissionPolicy>(TaskAdmissionPolicies.Find(controller, "CreateTemplate"));
        Assert.Equal(new[] { AppCallerRegistry.VideoAgent.Script.Chat, AppCallerRegistry.McpSpeech.Synthesize }, template.AppCallers);
        Assert.Equal(4, template.InteractiveMaxCalls);
        Assert.Equal(4, template.AgentMaxCalls);
        Assert.DoesNotContain(AppCallerRegistry.McpSpeech.Synthesize, TaskAdmissionPolicies.Find(controller, "CreateRun")!.AppCallers);
        Assert.Null(TaskAdmissionPolicies.Find(controller, "PublishTemplate"));
    }

    [Fact]
    public void Ass_UsesTimedSpokenText_AndDoesNotInterpretModelContentAsTags()
    {
        var scene = new VideoTemplateScene("背景", "保留决策理由", @"原文 {\pos(0,0)}");
        var clips = new[] { new VideoTemplateClip(scene, new(scene.Narration, 1.24, 3.16, "voice"), 0.9) };
        var ass = VideoTemplateRenderer.BuildAss("架构决策记录", VideoTemplateCatalog.Find("sketchnote")!, clips, 4.1);
        Assert.Contains("Dialogue: 3,0:00:01.24,0:00:03.16,Caption", ass);
        Assert.Contains("原文 ｛＼pos(0,0)｝", ass);
        Assert.DoesNotContain(@"原文 {\pos(0,0)}", ass);
    }

    [Fact]
    public void Scenes_RequireExactlyThreeSingleLineCaptionsWithinTheVisualBudget()
    {
        const string scene = """{"heading":"决策","note":"每份只记录一个决定","narration":"写清当时的背景、做出的决定和后果。"}""";
        Assert.Equal(3, VideoTemplateRenderer.ParseScenes($$"""{"scenes":[{{scene}},{{scene}},{{scene}}]}""").Count);
        Assert.Throws<FormatException>(() => VideoTemplateRenderer.ParseScenes($$"""{"scenes":[{{scene}}]}"""));
        var multiline = scene.Replace("写清", "写清\\n");
        Assert.Throws<FormatException>(() => VideoTemplateRenderer.ParseScenes($$"""{"scenes":[{{multiline}},{{scene}},{{scene}}]}"""));
    }
}
