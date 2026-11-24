using System;
using PrdAgent.Core.Models;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Mcp;

/// <summary>
/// 「这把钥匙还能不能用」的唯一判据。鉴权、接入台面板、密钥列表状态标签三处都读它 ——
/// 各判各的会让面板把一把每个请求都被拒的钥匙显示成「已连接、能力已授权」。
/// </summary>
public class AgentApiKeyUsabilityTests
{
    private static readonly DateTime Now = new(2026, 9, 3, 12, 0, 0, DateTimeKind.Utc);

    private static AgentApiKey Key(bool active = true, DateTime? expiresAt = null, DateTime? revokedAt = null, int grace = 7)
        => new() { IsActive = active, ExpiresAt = expiresAt, RevokedAt = revokedAt, GracePeriodDays = grace };

    [Fact]
    public void 没有过期时间的活跃钥匙_可用()
    {
        AgentApiKey.IsUsableAt(Key(), Now, out var inGrace).ShouldBeTrue();
        inGrace.ShouldBeFalse();
    }

    [Fact]
    public void 停用或撤销的钥匙_不可用()
    {
        AgentApiKey.IsUsableAt(Key(active: false), Now, out _).ShouldBeFalse();
        AgentApiKey.IsUsableAt(Key(revokedAt: Now.AddDays(-1)), Now, out _).ShouldBeFalse();
    }

    [Fact]
    public void 刚过期但还在宽限期内_可用且标记宽限()
    {
        AgentApiKey.IsUsableAt(Key(expiresAt: Now.AddDays(-2), grace: 7), Now, out var inGrace).ShouldBeTrue();
        inGrace.ShouldBeTrue();
    }

    [Fact]
    public void 过了宽限期_不可用_哪怕_IsActive_还是_true()
    {
        // 这条是本判据存在的理由：过期的钥匙 IsActive 仍是 true，
        // 面板照着 IsActive 判就会说「已连接」，而鉴权那边每个请求都在拒。
        var key = Key(active: true, expiresAt: Now.AddDays(-30), grace: 7);

        AgentApiKey.IsUsableAt(key, Now, out _).ShouldBeFalse();
        key.IsActive.ShouldBeTrue(customMessage: "IsActive 仍为 true —— 正是不能拿它当可用性判据的原因");
    }

    [Fact]
    public void 宽限期为零时_一过期就不可用()
    {
        AgentApiKey.IsUsableAt(Key(expiresAt: Now.AddMinutes(-1), grace: 0), Now, out _).ShouldBeFalse();
    }
}
