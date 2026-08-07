using PrdAgent.Api.Services;
using PrdAgent.Core.Models;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

/// <summary>
/// 分层任务在 Worker 里的执行语义。
///
/// 2026-08-07 用户实测：分层出来 4 张暗色、互相雷同、不透明的图，怀疑是模型不行。
/// 查容器日志才发现根本没调分层——两行紧挨着：
///   Run ...: AppCallerCode=visual-agent.image.layering::generation
///   Calling GenerateAsync with appCallerCode=visual-agent.image.img2img::generation
/// 「带一张参考图 → img2img」这条规则把分层 run 的 appCaller 覆盖掉了，于是那句
/// 「Decompose this image into ... RGBA layers」被当成创作提示词，模型照着重画了一张图。
///
/// 这类缺陷编译过、测试绿、通读也挑不出，只有翻日志才现形，所以必须有行为守卫钉住。
/// </summary>
public class LayeringRunExecutionTests
{
    private static ImageGenRun LayeringRun() => new()
    {
        AppKey = "visual-agent",
        AppCallerCode = AppCallerRegistry.VisualAgent.Image.Layering,
        LogicalModelPublicId = GatewayCapabilityIds.ImageLayering,
    };

    [Fact]
    public void 分层带参考图时不得被改写成图生图()
    {
        // 分层必然带一张输入图，正是这个条件把它误判成了 img2img。
        var resolved = ImageGenRunWorker.ResolveImageGenAppCallerCode(
            LayeringRun(), isVisionMode: false, imageRefCount: 1, hasInitImage: true);

        resolved.ShouldBe(AppCallerRegistry.VisualAgent.Image.Layering);
    }

    [Fact]
    public void appCaller已被改写时仍能靠逻辑模型认出是分层()
    {
        // Worker 会把 appCaller 回写进库；只认 appCaller 的话，改写之后这条 run
        // 就「不再是分层」，后续每一处判断都会跟着错。
        var run = LayeringRun();
        run.AppCallerCode = AppCallerRegistry.VisualAgent.Image.Img2Img;

        ImageGenRunWorker.IsLayeringRun(run).ShouldBeTrue();
        ImageGenRunWorker.ResolveImageGenAppCallerCode(run, false, 1, true)
            .ShouldBe(AppCallerRegistry.VisualAgent.Image.Layering);
    }

    [Fact]
    public void 普通图生图不受影响()
    {
        var run = new ImageGenRun
        {
            AppKey = "visual-agent",
            AppCallerCode = AppCallerRegistry.VisualAgent.Image.Text2Img,
        };

        ImageGenRunWorker.IsLayeringRun(run).ShouldBeFalse();
        ImageGenRunWorker.ResolveImageGenAppCallerCode(run, false, 1, true)
            .ShouldBe(AppCallerRegistry.VisualAgent.Image.Img2Img);
        ImageGenRunWorker.ResolveImageGenAppCallerCode(run, false, 0, false)
            .ShouldBe(AppCallerRegistry.VisualAgent.Image.Text2Img);
        ImageGenRunWorker.ResolveImageGenAppCallerCode(run, true, 3, true)
            .ShouldBe(AppCallerRegistry.VisualAgent.Image.VisionGen);
    }

    [Theory]
    [InlineData(4, 4)]
    [InlineData(0, 4)]    // 计划项没写就按默认 4 层
    [InlineData(99, 10)]  // 上限与网关一致
    [InlineData(-1, 4)]
    public void 层数取自计划项并夹在网关允许区间(int planned, int expected)
    {
        // 这个值最终会变成上游的 num_layers。取错就等于跟模型说「拆成 1 层」，
        // 而拆成一层的结果就是整张图本身——正是用户看到的那 4 张雷同整图。
        ImageGenRunWorker.ResolveLayerCount(new ImageGenRunPlanItem { Count = planned })
            .ShouldBe(expected);
    }
}
