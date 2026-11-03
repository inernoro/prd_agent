using PrdAgent.Api.Services.Mcp;
using PrdAgent.Core.Models;
using Shouldly;
using Xunit;
namespace PrdAgent.Api.Tests.Mcp;
public class McpCallAuthorizationTests
{
    private static readonly DateTime Now = new(2026, 11, 3, 0, 0, 0, DateTimeKind.Utc);
    private static AgentApiKey Key() => new() { Id = "key", OwnerUserId = "owner", ScopeMode = AgentApiKeyScopeMode.Manual, Scopes = new() { "document-store:read" } };
    private static McpCallLog Log() => new() { KeyId = "key", OwnerUserId = "owner", Status = "denied", ToolName = "map_tasks_mine" };
    [Fact]
    public void 仅返回当前缺失且本人有权授予的最小工具权限()
    {
        McpCallAuthorization.RequiredScope(Log(), Key(), new[] { "access", "active-tasks.use" }, Now).ShouldBe("active-tasks:use");
        McpCallAuthorization.RequiredScope(Log(), Key(), Array.Empty<string>(), Now).ShouldBeNull();
        var key = Key(); key.Scopes.Add("active-tasks:use");
        McpCallAuthorization.RequiredScope(Log(), key, new[] { "access", "active-tasks.use" }, Now).ShouldBeNull();
    }
    [Fact]
    public void 不恢复撤销凭证或改变自动授权也不跨所有者()
    {
        foreach (var mode in new[] { "revoked", "disabled", "auto", "owner", "expired" })
        {
            var key = Key();
            if (mode == "revoked") key.RevokedAt = Now;
            if (mode == "disabled") key.IsActive = false;
            if (mode == "auto") key.ScopeMode = AgentApiKeyScopeMode.Auto;
            if (mode == "owner") key.OwnerUserId = "other";
            if (mode == "expired") { key.ExpiresAt = Now.AddDays(-100); key.GracePeriodDays = 0; }
            McpCallAuthorization.RequiredScope(Log(), key, new[] { "access", "active-tasks.use" }, Now).ShouldBeNull();
        }
    }
}
