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
    private static GatewayAppCallerRecord Caller(string requestType, string status)
        => new() { TenantId = "t1", AppCallerCode = "demo.app::" + requestType, RequestType = requestType, Status = status };

    [Fact]
    public void 找不到对应那一行时照运行时口径放行()
    {
        // 缺记录在运行时归一成 discovered、是放行的；清单不该比它严——
        // 严了的话，新接入的调用方第一次 client.models.list() 拿到空清单，无从下手。
        GatewayModelCatalogEndpoint.CallerMayListModelType([], "chat").ShouldBeTrue();
        GatewayModelCatalogEndpoint.CallerMayListModelType([Caller("generation", "archived")], "chat").ShouldBeTrue();
        GatewayModelCatalogEndpoint.CallerMayListModelType([Caller("chat", "discovered")], "chat").ShouldBeTrue();
        GatewayModelCatalogEndpoint.CallerMayListModelType([Caller("chat", "configured")], "chat").ShouldBeTrue();
        GatewayModelCatalogEndpoint.CallerMayListModelType([Caller("chat", "active")], "chat").ShouldBeTrue();
    }

    [Fact]
    public void 这个用途那一行不接流量就不列这个用途的模型()
    {
        GatewayModelCatalogEndpoint.CallerMayListModelType([Caller("chat", "disabled")], "chat").ShouldBeFalse();
        GatewayModelCatalogEndpoint.CallerMayListModelType([Caller("chat", "archived")], "chat").ShouldBeFalse();
    }

    [Fact]
    public void 一个用途停了不连累另一个用途()
    {
        /*
          记录按 (租户, 调用方码, 请求类型) 存，一个码在 chat 上 active、在 generation 上
          被停用是常态。上一版把多行压成「有没有任何一行还允许」的一个布尔，于是这种配置下
          两个用途的模型会一起发出去，而运行时查的是精确那一行（第 68 轮 review）。
        */
        GatewayAppCallerRecord[] mixed = [Caller("chat", "active"), Caller("generation", "archived")];
        GatewayModelCatalogEndpoint.CallerMayListModelType(mixed, "chat").ShouldBeTrue();
        GatewayModelCatalogEndpoint.CallerMayListModelType(mixed, "generation").ShouldBeFalse();
        // 反过来也要成立，不许只对一个方向成立
        GatewayAppCallerRecord[] flipped = [Caller("chat", "disabled"), Caller("generation", "active")];
        GatewayModelCatalogEndpoint.CallerMayListModelType(flipped, "chat").ShouldBeFalse();
        GatewayModelCatalogEndpoint.CallerMayListModelType(flipped, "generation").ShouldBeTrue();
    }

    [Fact]
    public void 用途比对不分大小写与首尾空白()
    {
        GatewayAppCallerRecord[] records = [Caller(" CHAT ", "archived")];
        GatewayModelCatalogEndpoint.CallerMayListModelType(records, "chat").ShouldBeFalse();
    }

    [Fact]
    public void 判据与运行时那道治理闸同一份()
    {
        // 这里只负责「按用途挑出该问哪一行」，放不放行本身必须问 GatewayAppCallerPolicy，
        // 不许在清单这一侧另写一张状态表。
        foreach (var status in new[] { "discovered", "configured", "active", "disabled", "archived", "", "ACTIVE" })
        {
            GatewayModelCatalogEndpoint.CallerMayListModelType([Caller("chat", status)], "chat")
                .ShouldBe(GatewayAppCallerPolicy.AllowsTraffic(status));
        }
    }
}
