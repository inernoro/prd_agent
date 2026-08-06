using System.IO;
using PrdAgent.Core.Models;
using Xunit;

namespace PrdAgent.Api.Tests.Controllers;

/// <summary>
/// 分层走异步任务这条线的守卫。
///
/// 起因：分层原本只有同步端点，模型本身要二三十秒，真实调用稳定撞上边缘网关的 30 秒超时，
/// 用户永远拿不到结果。改走异步任务后，这几条接线一旦被删就会退回同步，而退回是静默的
/// ——编译过、测试绿、只有真实调用才会再次超时。所以用源码守卫钉住。
/// </summary>
public class LayeringRunCreationTests
{
    private static string ReadRepoFile(string relative)
    {
        var dir = new DirectoryInfo(Directory.GetCurrentDirectory());
        while (dir is not null && !Directory.Exists(Path.Combine(dir.FullName, "prd-api")))
            dir = dir.Parent;
        Assert.NotNull(dir);
        var full = Path.Combine(dir!.FullName, relative);
        Assert.True(File.Exists(full), $"找不到 {relative}");
        return File.ReadAllText(full);
    }

    [Fact]
    public void RunCreation_AcceptsLayeringOperationAndLayerCount()
    {
        var controller = ReadRepoFile("prd-api/src/PrdAgent.Api/Controllers/Api/ImageMasterController.cs");

        // 入参：没有这两个字段，前端就无法通过异步任务发起分层，只能退回同步端点。
        Assert.Contains("public string? Operation { get; set; }", controller);
        Assert.Contains("public int? LayerCount { get; set; }", controller);

        // 判定与接线：能力标识、调用方标识、层数落到任务计划里。
        Assert.Contains("\"layering\", StringComparison.OrdinalIgnoreCase)", controller);
        Assert.Contains("GatewayCapabilityIds.ImageLayering", controller);
        Assert.Contains("AppCallerRegistry.VisualAgent.Image.Layering", controller);
        Assert.Contains("Count = layerCount", controller);
        Assert.Contains("Total = layerCount", controller);
    }

    [Fact]
    public void LayeringRun_ClearsUpstreamPickerFieldsSoGatewayResolvesTheCapability()
    {
        var controller = ReadRepoFile("prd-api/src/PrdAgent.Api/Controllers/Api/ImageMasterController.cs");

        // MAP 不感知上游厂商与具体模型：分层必须清掉 picker 传来的平台/模型，
        // 否则会以「直连指定模型」的方式解析，绕开网关发布的能力。
        var idx = controller.IndexOf("var layerCount = isLayering", System.StringComparison.Ordinal);
        Assert.True(idx > 0, "找不到分层分支");
        var block = controller[System.Math.Max(0, idx - 400)..idx];
        Assert.Contains("cfgModelId = null;", block);
        Assert.Contains("platformId = null;", block);
        Assert.Contains("modelId = null;", block);
    }

    [Fact]
    public void CapabilityId_HasSingleSourceOfTruth()
    {
        // 这个标识已经有两个调用方（同步端点与异步任务创建）。各自抄一份私有常量迟早漂移，
        // 所以唯一定义在 Core，两处都引用它。
        Assert.Equal("image-layering", GatewayCapabilityIds.ImageLayering);

        var syncController = ReadRepoFile("prd-api/src/PrdAgent.Api/Controllers/Api/ImageGenController.cs");
        Assert.Contains("GatewayCapabilityIds.ImageLayering", syncController);
        Assert.DoesNotContain("ImageLayeringCapabilityId = \"image-layering\"", syncController);
    }
}
