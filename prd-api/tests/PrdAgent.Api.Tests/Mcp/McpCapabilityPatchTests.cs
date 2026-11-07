using System.Security.Claims;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Moq;
using PrdAgent.Api.Controllers.Api;
using PrdAgent.Api.Mcp;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Mcp;

public sealed class McpCapabilityPatchTests
{
    private static readonly string[] ReducedPermissions = ["access", "active-tasks.use"];
    private static AgentApiKey ManualKey() => new()
    {
        Id = "k", OwnerUserId = "u", IsActive = true, ScopeMode = AgentApiKeyScopeMode.Manual,
        Scopes = [McpCapabilityCatalog.ScopeVisualUse, McpCapabilityCatalog.ScopeTasksUse, "agent.example:invoke"]
    };

    [Fact]
    public void 临时降权修改其他能力保留隐藏授权_恢复账号权限后仍可用()
    {
        var key = ManualKey();
        AgentApiKeysController.TryApplyMcpCapabilityAccess(key, ReducedPermissions,
            new Dictionary<string, string> { ["tasks"] = "none" }, out var scopes, out _).ShouldBeTrue();
        scopes.ShouldBe([McpCapabilityCatalog.ScopeVisualUse, "agent.example:invoke"]);
        McpCapabilityCatalog.EffectiveScopesFor(key.ScopeMode, scopes, ReducedPermissions)
            .ShouldNotContain(McpCapabilityCatalog.ScopeVisualUse);
        McpCapabilityCatalog.EffectiveScopesFor(key.ScopeMode, scopes, [.. ReducedPermissions, "visual-agent.use"])
            .ShouldContain(McpCapabilityCatalog.ScopeVisualUse);
        key.Scopes.ShouldContain(McpCapabilityCatalog.ScopeTasksUse);
    }

    [Theory]
    [InlineData("visual", "write")]
    [InlineData("unknown", "read")]
    [InlineData("tasks", "invalid")]
    public void 拒绝新增无权授予的能力和非法档位(string capability, string level)
    {
        var key = ManualKey();
        var before = key.Scopes.ToArray();
        AgentApiKeysController.TryApplyMcpCapabilityAccess(key, ReducedPermissions,
            new Dictionary<string, string> { [capability] = level }, out _, out var error).ShouldBeFalse();
        error.ShouldNotBeNullOrWhiteSpace();
        key.Scopes.ShouldBe(before);
    }

    [Fact]
    public void 自动转手动快照当前能力且不签发派生发布scope()
    {
        var key = new AgentApiKey { ScopeMode = AgentApiKeyScopeMode.Auto, WebPublicExposureAllowed = true };
        string[] permissions = ["access", "web-pages.write", "active-tasks.use"];
        AgentApiKeysController.TryApplyMcpCapabilityAccess(key, permissions,
            new Dictionary<string, string>(), out var scopes, out _).ShouldBeTrue();
        scopes.ShouldBe(McpCapabilityCatalog.AutoScopesFor(permissions));
        scopes.ShouldContain(McpCapabilityCatalog.ScopeWebPagesWrite);
        scopes.ShouldNotContain(McpCapabilityCatalog.ScopeWebPagesPublish);
    }

    [Theory]
    [InlineData(false, false)]
    [InlineData(true, false)]
    [InlineData(false, true)]
    public async Task API保留未修改的存储授权且拒绝混用整表和自动模式(bool fullScopes, bool autoMode)
    {
        var key = ManualKey();
        var service = new Mock<IAgentApiKeyService>();
        service.Setup(x => x.GetByIdAsync("k", It.IsAny<CancellationToken>())).ReturnsAsync(key);
        var permissions = new Mock<IAdminPermissionService>();
        permissions.Setup(x => x.GetEffectivePermissionsAsync("u", false, It.IsAny<CancellationToken>()))
            .ReturnsAsync(ReducedPermissions);
        var controller = new AgentApiKeysController(service.Object, null!, permissions.Object, null!)
        {
            ControllerContext = new() { HttpContext = new DefaultHttpContext
            { User = new ClaimsPrincipal(new ClaimsIdentity([new("sub", "u")], "Bearer")) } }
        };
        var result = await controller.Update("k", new()
        {
            McpCapabilityAccess = new() { ["tasks"] = "none" },
            Scopes = fullScopes ? [] : null, ScopeMode = autoMode ? "auto" : "manual"
        }, CancellationToken.None);
        if (fullScopes || autoMode)
        {
            result.ShouldBeOfType<BadRequestObjectResult>();
            service.Verify(x => x.UpdateMetadataAsync(It.IsAny<string>(), It.IsAny<string?>(), It.IsAny<string?>(),
                It.IsAny<IEnumerable<string>?>(), It.IsAny<bool?>(), It.IsAny<CancellationToken>(),
                It.IsAny<AgentApiKeyQuotaPatch?>(), It.IsAny<AgentApiKeyScopeMode?>(),
                It.IsAny<AgentApiKeyLiteraryImageModelPatch?>(), It.IsAny<bool?>()), Times.Never());
        }
        else
        {
            result.ShouldBeOfType<OkObjectResult>();
            service.Verify(x => x.UpdateMetadataAsync("k", null, null,
                It.Is<IEnumerable<string>>(s => s.SequenceEqual(new[] { McpCapabilityCatalog.ScopeVisualUse, "agent.example:invoke" })),
                null, It.IsAny<CancellationToken>(), It.IsAny<AgentApiKeyQuotaPatch?>(),
                AgentApiKeyScopeMode.Manual, null, null), Times.Once());
        }
    }
}
