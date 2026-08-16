using PrdAgent.Core.Models;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Gateway;

/// <summary>
/// 「用户可挑的生图模型」与「只能被动作调用的能力」必须分得开。
///
/// 2026-08-07 用户实测撞上：分层被发布成 generation 类型的逻辑模型，
/// 于是混进视觉创作的「选择模型」下拉，选中后底部 chip 变成「图片分层」，
/// 旁边还挂着对它毫无意义的 1K·1:1。它需要一张输入图、不吃提示词、没有尺寸概念，
/// 根本不是能挑来生图的东西。
///
/// 这条判据写错了照样编译、照样跑、不报错——只有用户打开下拉才发现，所以必须钉住。
/// </summary>
public class OperationOnlyCapabilityTests
{
    [Fact]
    public void 分层能力不算可挑的生图模型()
    {
        GatewayCapabilityIds
            .IsOperationOnly(GatewayCapabilityIds.ImageLayering, ["image_generation", "image_layering"])
            .ShouldBeTrue();
    }

    [Theory]
    // Capabilities 数组用 snake_case，逻辑模型 PublicId 用 kebab-case：
    // 只认其中一种，换条数据来路就漏判。
    [InlineData("image_layering")]
    [InlineData("image-layering")]
    [InlineData("IMAGE_LAYERING")]
    public void 两种命名风格的能力标记都要认(string token)
    {
        GatewayCapabilityIds.IsOperationOnly(null, [token]).ShouldBeTrue();
    }

    [Fact]
    public void 只看得到PublicId时也判得出来()
    {
        // 某些数据来源不填 Capabilities，只有 PublicId。
        GatewayCapabilityIds.IsOperationOnly("image-layering", null).ShouldBeTrue();
        GatewayCapabilityIds.IsOperationOnly("image-layering", []).ShouldBeTrue();
    }

    [Fact]
    public void 正常生图模型不被误伤()
    {
        GatewayCapabilityIds.IsOperationOnly("gpt-image-2", ["image_generation"]).ShouldBeFalse();
        // 旧数据完全没有能力标签时不能一刀切当成动作能力，否则模型列表会整个空掉。
        GatewayCapabilityIds.IsOperationOnly("gpt-image-2", null).ShouldBeFalse();
        GatewayCapabilityIds.IsOperationOnly(null, null).ShouldBeFalse();
        GatewayCapabilityIds.IsOperationOnly("", []).ShouldBeFalse();
    }
}
