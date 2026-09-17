using PrdAgent.LlmGatewayHost;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Gateway;

/// <summary>
/// 清单不许替这把 key 列出它调不动的调用方。
///
/// 鉴权那一层对只读探针**刻意不匹配调用方**（预检本来就该放行），于是一把 route:read 的 key
/// 在请求头里点名任意调用方都能拿到它的清单，而随后那次 POST 会被拒——清单说能调、
/// 运行时说不能，正是这个端点反复在修的那件事（第 72 轮 review）。
/// </summary>
public class GatewayCatalogCallerScopeTests
{
    [Fact]
    public void 没点名时不判越权()
    {
        // 没带请求头 → 走 key 自己的身份，这条路不在本判据管辖范围内。
        GatewayHttpEndpoints.RequestedCallerOutsideKeyScope(null, ["a.b::chat"]).ShouldBeFalse();
        GatewayHttpEndpoints.RequestedCallerOutsideKeyScope("   ", ["a.b::chat"]).ShouldBeFalse();
    }

    [Fact]
    public void 授权集合为空等于不限调用方()
    {
        // 空集合是「不限」，不是「一个都不许」——判反了会把正常的 key 全部拒掉。
        GatewayHttpEndpoints.RequestedCallerOutsideKeyScope("a.b::chat", null).ShouldBeFalse();
        GatewayHttpEndpoints.RequestedCallerOutsideKeyScope("a.b::chat", []).ShouldBeFalse();
    }

    [Fact]
    public void 点名了授权范围内的照常放行()
    {
        GatewayHttpEndpoints.RequestedCallerOutsideKeyScope("a.b::chat", ["a.b::chat"]).ShouldBeFalse();
        // 调用方码一路都是不分大小写比的，这里也不能更严
        GatewayHttpEndpoints.RequestedCallerOutsideKeyScope("A.B::CHAT", ["a.b::chat"]).ShouldBeFalse();
        GatewayHttpEndpoints.RequestedCallerOutsideKeyScope(" a.b::chat ", ["a.b::chat"]).ShouldBeFalse();
        GatewayHttpEndpoints.RequestedCallerOutsideKeyScope("a.b::chat", ["x.y::generation", " a.b::chat "]).ShouldBeFalse();
    }

    [Fact]
    public void 点名了授权范围外的必须拒()
    {
        GatewayHttpEndpoints.RequestedCallerOutsideKeyScope("x.y::generation", ["a.b::chat"]).ShouldBeTrue();
        GatewayHttpEndpoints.RequestedCallerOutsideKeyScope("a.b::generation", ["a.b::chat"]).ShouldBeTrue();
    }
}
