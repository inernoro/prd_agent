using PrdAgent.Core.LlmGateway;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.LlmGateway;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Gateway;

/// <summary>
/// 矩阵 C：故障域隔离。
///
/// 事故里最贵的部分不是「生图挂了」，而是「一个 appCaller 的配置问题被包装成全站 AI 不可用」。
/// 这组用例把「一个能力/一个池/一个 appCaller 出问题，故障只停留在它自己的范围内」
/// 变成可红可绿的判据。
/// </summary>
public sealed class GatewayFaultDomainIsolationTests
{
    private const string ImageCaller = "visual-agent.image.text2img::generation";
    private const string ChatCaller = "prd-agent.chat::chat";
    private const string AsrCaller = "visual-agent.audio.transcribe::asr";

    private static LLMPlatform Platform(string id) => new()
    {
        Id = id,
        Name = id,
        PlatformType = "openai",
        ApiUrl = "https://api.example.com",
        Enabled = true,
    };

    private static ModelGroup Pool(
        string id,
        string modelType,
        bool isDefault,
        params (string platformId, string modelId, ModelHealthStatus health)[] members)
        => new()
        {
            Id = id,
            Name = id,
            Code = id,
            ModelType = modelType,
            IsDefaultForType = isDefault,
            Models = members.Select((m, i) => new ModelGroupItem
            {
                PlatformId = m.platformId,
                ModelId = m.modelId,
                Priority = i,
                HealthStatus = m.health,
            }).ToList(),
        };

    private static LLMAppCaller Caller(string appCode, string modelType, params string[] poolIds)
        => new()
        {
            AppCode = appCode,
            DisplayName = appCode,
            ModelRequirements =
            [
                new AppModelRequirement { ModelType = modelType, ModelGroupIds = poolIds.ToList() },
            ],
        };

    /// <summary>
    /// 三条能力（生图 / 对话 / ASR）各自绑定自己的池，生图池被清空。
    /// C1：生图失败，对话与 ASR 必须照常可用。
    /// </summary>
    [Fact]
    public async Task 生图池为空时_对话与ASR仍可路由()
    {
        var resolver = new InMemoryModelResolver()
            .WithPlatform(Platform("plat-a"), "sk-test")
            .WithModelGroup(Pool("pool-image", "generation", false))
            .WithModelGroup(Pool("pool-chat", "chat", false, ("plat-a", "chat-model", ModelHealthStatus.Healthy)))
            .WithModelGroup(Pool("pool-asr", "asr", false, ("plat-a", "asr-model", ModelHealthStatus.Healthy)))
            .WithAppCaller(Caller(ImageCaller, "generation", "pool-image"))
            .WithAppCaller(Caller(ChatCaller, "chat", "pool-chat"))
            .WithAppCaller(Caller(AsrCaller, "asr", "pool-asr"));

        var image = await resolver.ResolveAsync(ImageCaller, "generation");
        var chat = await resolver.ResolveAsync(ChatCaller, "chat");
        var asr = await resolver.ResolveAsync(AsrCaller, "asr");

        image.Success.ShouldBeFalse();
        image.FailureCode.ShouldNotBeNull();
        chat.Success.ShouldBeTrue("生图配置问题不得外溢到对话");
        chat.ActualModel.ShouldBe("chat-model");
        asr.Success.ShouldBeTrue("生图配置问题不得外溢到 ASR");
        asr.ActualModel.ShouldBe("asr-model");
    }

    /// <summary>C2：反向——ASR 池全员熔断时，生图仍然可用。</summary>
    [Fact]
    public async Task ASR池全员熔断时_生图仍可路由()
    {
        var resolver = new InMemoryModelResolver()
            .WithPlatform(Platform("plat-a"), "sk-test")
            .WithModelGroup(Pool("pool-image", "generation", false, ("plat-a", "image-model", ModelHealthStatus.Healthy)))
            .WithModelGroup(Pool("pool-asr", "asr", false, ("plat-a", "asr-model", ModelHealthStatus.Unavailable)))
            .WithAppCaller(Caller(ImageCaller, "generation", "pool-image"))
            .WithAppCaller(Caller(AsrCaller, "asr", "pool-asr"));

        var asr = await resolver.ResolveAsync(AsrCaller, "asr");
        var image = await resolver.ResolveAsync(ImageCaller, "generation");

        asr.Success.ShouldBeFalse();
        asr.FailureCode.ShouldBe(GatewayRouteFailure.ModelPoolAllUnavailable);
        image.Success.ShouldBeTrue("ASR 池全员熔断不得污染生图池健康");
        image.ActualModel.ShouldBe("image-model");
    }

    /// <summary>C7：一个 appCaller 配错（绑到不存在的池）不影响同类型的另一个 appCaller。</summary>
    [Fact]
    public async Task 一个appCaller配错_不影响同类型的其它appCaller()
    {
        const string brokenCaller = "literary-agent.illustration.text2img::generation";
        var resolver = new InMemoryModelResolver()
            .WithPlatform(Platform("plat-a"), "sk-test")
            .WithModelGroup(Pool("pool-image", "generation", false, ("plat-a", "image-model", ModelHealthStatus.Healthy)))
            .WithAppCaller(Caller(ImageCaller, "generation", "pool-image"))
            .WithAppCaller(Caller(brokenCaller, "generation", "pool-does-not-exist"));

        var broken = await resolver.ResolveAsync(brokenCaller, "generation");
        var healthy = await resolver.ResolveAsync(ImageCaller, "generation");

        broken.Success.ShouldBeFalse();
        healthy.Success.ShouldBeTrue("同类型的另一个 appCaller 配错，不得让本 appCaller 一起失败");
        healthy.ActualModel.ShouldBe("image-model");
    }

    /// <summary>
    /// 单成员失败只影响该成员：池内还有健康成员时必须继续可路由，
    /// 且失败不得把整个池判成不可用（llm-gateway 规则第 4 条）。
    /// </summary>
    [Fact]
    public async Task 池内单成员不可用_其余成员接管()
    {
        var resolver = new InMemoryModelResolver()
            .WithPlatform(Platform("plat-a"), "sk-test")
            .WithModelGroup(Pool(
                "pool-image",
                "generation",
                false,
                ("plat-a", "broken-model", ModelHealthStatus.Unavailable),
                ("plat-a", "backup-model", ModelHealthStatus.Healthy)))
            .WithAppCaller(Caller(ImageCaller, "generation", "pool-image"));

        var result = await resolver.ResolveAsync(ImageCaller, "generation");

        result.Success.ShouldBeTrue();
        result.ActualModel.ShouldBe("backup-model");
    }

    /// <summary>
    /// 失败必须带结构化原因：空池与全员熔断是两种不同的处置动作，
    /// 混成一个错误码就等于让管理员从零复现。
    /// </summary>
    [Fact]
    public async Task 空池与全员熔断_返回不同的结构化原因()
    {
        var emptyPool = new InMemoryModelResolver()
            .WithPlatform(Platform("plat-a"), "sk-test")
            .WithModelGroup(Pool("pool-image", "generation", false))
            .WithAppCaller(Caller(ImageCaller, "generation", "pool-image"));
        var allDown = new InMemoryModelResolver()
            .WithPlatform(Platform("plat-a"), "sk-test")
            .WithModelGroup(Pool("pool-image", "generation", false, ("plat-a", "m", ModelHealthStatus.Unavailable)))
            .WithAppCaller(Caller(ImageCaller, "generation", "pool-image"));

        var empty = await emptyPool.ResolveAsync(ImageCaller, "generation");
        var down = await allDown.ResolveAsync(ImageCaller, "generation");

        empty.FailureCode.ShouldBe(GatewayRouteFailure.ModelPoolEmpty);
        down.FailureCode.ShouldBe(GatewayRouteFailure.ModelPoolAllUnavailable);
        empty.FailureCode.ShouldNotBe(down.FailureCode);
    }
}
