using PrdAgent.Core.Models;
using Xunit;

namespace PrdAgent.Tests;

/// <summary>
/// OpenApi 对外网关注册守卫（CI 可运行，无需 DB）。
///
/// 守护「make-or-break」不变量：OpenApi 的两个伞形 appCallerCode 必须已在
/// <see cref="AppCallerRegistry"/> 静态注册。原因（见 doc/debt.open-platform.open-api.md）：
/// 1. MAP 自有调用点仍通过静态注册表获得编译期拼写守卫和展示元数据；
/// 2. <c>AppCallerRegistrySyncService</c> 启动时把已注册 code 同步成 llm_app_callers DB 记录，
///    没有这条记录，<c>ModelResolver.ResolveAsync</c> 会直接返回 NotFound，
///    未绑定的 Key 无法回落到 default:chat / default:image。
/// 外部系统和新 GW caller 不再受静态注册表硬门限制，运行时权威是 llm_gateway registry。
///
/// 一旦有人误删这两个常量，本测试立刻 fail，避免对外网关整体瘫痪。
/// </summary>
public class OpenApiRegistrationTests
{
    [Fact]
    public void OpenApiChatProxy_ShouldBeRegistered_WithChatModelType()
    {
        var def = AppCallerRegistrationService.FindByAppCode(AppCallerRegistry.OpenApi.Proxy.Chat);

        Assert.NotNull(def);
        Assert.Equal("open-api.proxy::chat", AppCallerRegistry.OpenApi.Proxy.Chat);
        Assert.Contains(ModelTypes.Chat, def!.ModelTypes);
    }

    [Fact]
    public void OpenApiImageProxy_ShouldBeRegistered_WithGenerationModelType()
    {
        var def = AppCallerRegistrationService.FindByAppCode(AppCallerRegistry.OpenApi.Proxy.Generation);

        Assert.NotNull(def);
        Assert.Equal("open-api.proxy::generation", AppCallerRegistry.OpenApi.Proxy.Generation);
        Assert.Contains(ModelTypes.ImageGen, def!.ModelTypes);
    }
}
