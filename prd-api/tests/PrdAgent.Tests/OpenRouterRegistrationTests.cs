using PrdAgent.Core.Models;
using Xunit;

namespace PrdAgent.Tests;

/// <summary>
/// OpenRouter 对外网关注册守卫（CI 可运行，无需 DB）。
///
/// 守护「make-or-break」不变量：OpenRouter 的两个伞形 appCallerCode 必须已在
/// <see cref="AppCallerRegistry"/> 静态注册。原因（见 doc/debt.open-router.md）：
/// 1. <c>LlmGateway.TryValidateAppCaller</c> 用静态注册表反射校验，未注册的 code 直接
///    APP_CALLER_INVALID（400），网关根本不会调度；
/// 2. <c>AppCallerRegistrySyncService</c> 启动时把已注册 code 同步成 llm_app_callers DB 记录，
///    没有这条记录，<c>ModelResolver.ResolveAsync</c> 会直接返回 NotFound，
///    未绑定的 Key 无法回落到 default:chat / default:image。
///
/// 一旦有人误删这两个常量，本测试立刻 fail，避免对外网关整体瘫痪。
/// </summary>
public class OpenRouterRegistrationTests
{
    [Fact]
    public void OpenRouterChatProxy_ShouldBeRegistered_WithChatModelType()
    {
        var def = AppCallerRegistrationService.FindByAppCode(AppCallerRegistry.OpenRouter.Proxy.Chat);

        Assert.NotNull(def);
        Assert.Equal("open-router.proxy::chat", AppCallerRegistry.OpenRouter.Proxy.Chat);
        Assert.Contains(ModelTypes.Chat, def!.ModelTypes);
    }

    [Fact]
    public void OpenRouterImageProxy_ShouldBeRegistered_WithGenerationModelType()
    {
        var def = AppCallerRegistrationService.FindByAppCode(AppCallerRegistry.OpenRouter.Proxy.Generation);

        Assert.NotNull(def);
        Assert.Equal("open-router.proxy::generation", AppCallerRegistry.OpenRouter.Proxy.Generation);
        Assert.Contains(ModelTypes.ImageGen, def!.ModelTypes);
    }
}
