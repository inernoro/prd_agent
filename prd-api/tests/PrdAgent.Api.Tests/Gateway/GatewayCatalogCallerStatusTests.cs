using PrdAgent.Core.LlmGateway;
using PrdAgent.LlmGatewayHost;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Gateway;

/// <summary>
/// 对外模型清单要过「这个调用方现在还能不能调」那道门。
///
/// key 的鉴权只验到「这把 key 属于这个团队」；调用方自己的状态是另一道门，在运行时的
/// CheckAppCallerGovernanceAsync 里。清单端点此前没过它：调用方被停用或归档之后，
/// `/v1/models` 照样把授权范围内的模型全列出来，对方照着调一次立刻拿到 APP_CALLER_DISABLED
/// ——清单说能调、运行时说不能，两处各自为真（第 67 轮 review，形状 3）。
/// </summary>
public class GatewayCatalogCallerStatusTests
{
    private static GatewayAppCallerRecord Caller(string status)
        => new() { TenantId = "t1", AppCallerCode = "demo.app::chat", RequestType = "chat", Status = status };

    [Fact]
    public void 一条记录都没有时照运行时口径放行()
    {
        // 缺记录在运行时归一成 discovered、是放行的；清单不该比它严——
        // 严了的话，新接入的调用方第一次 client.models.list() 拿到空清单，无从下手。
        GatewayModelCatalogEndpoint.CallerMayList([]).ShouldBeTrue();
        GatewayModelCatalogEndpoint.CallerMayList([Caller("discovered")]).ShouldBeTrue();
        GatewayModelCatalogEndpoint.CallerMayList([Caller("configured")]).ShouldBeTrue();
        GatewayModelCatalogEndpoint.CallerMayList([Caller("active")]).ShouldBeTrue();
    }

    [Fact]
    public void 全部记录都不接流量时清单为空()
    {
        GatewayModelCatalogEndpoint.CallerMayList([Caller("disabled")]).ShouldBeFalse();
        GatewayModelCatalogEndpoint.CallerMayList([Caller("archived")]).ShouldBeFalse();
        GatewayModelCatalogEndpoint.CallerMayList([Caller("disabled"), Caller("archived")]).ShouldBeFalse();
    }

    [Fact]
    public void 还有一行接流量就照常列()
    {
        // 记录按 (租户, 调用方码, 请求类型) 存，一个码可能有多行，而清单跨用途、
        // 没有单一请求类型可比。宁可在部分停用时多列一点，也不要把一个还在正常工作的
        // 调用方的清单整个抹掉。
        GatewayModelCatalogEndpoint.CallerMayList([Caller("archived"), Caller("active")]).ShouldBeTrue();
    }

    [Fact]
    public void 判据与运行时那道治理闸同一份()
    {
        // 这里只决定「多行怎么合成一个答案」，放不放行本身必须问 GatewayAppCallerPolicy，
        // 不许在清单这一侧另写一张状态表。
        foreach (var status in new[] { "discovered", "configured", "active", "disabled", "archived", "", "ACTIVE" })
        {
            GatewayModelCatalogEndpoint.CallerMayList([Caller(status)])
                .ShouldBe(GatewayAppCallerPolicy.AllowsTraffic(status));
        }
    }
}
