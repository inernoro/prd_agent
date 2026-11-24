using PrdAgent.Api.Controllers.Api;
using PrdAgent.Core.Models;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Controllers;

public sealed class HomeRecentWorkWorkspaceRoutingTests
{
    [Fact]
    public void NormalizeRecentOpens_同一文学工作区的历史视觉脚印合并为一条()
    {
        var newer = new DateTime(2026, 9, 24, 3, 0, 0, DateTimeKind.Utc);
        var opens = new[]
        {
            new UserRecentOpen
            {
                AgentKey = "literary-agent",
                EntityId = "workspace-1",
                LastOpenedAt = newer,
            },
            new UserRecentOpen
            {
                AgentKey = "visual-agent",
                EntityId = "workspace-1",
                LastOpenedAt = newer.AddMinutes(-10),
            },
        };
        var workspaces = new Dictionary<string, HomeRecentWorkController.WorkspaceRecentMetadata>
        {
            ["workspace-1"] = new("验收稿", "article-illustration"),
        };

        var result = HomeRecentWorkController.NormalizeRecentOpens(opens, workspaces);

        var item = result.ShouldHaveSingleItem();
        item.AgentKey.ShouldBe("literary-agent");
        item.EntityId.ShouldBe("workspace-1");
        item.LastOpenedAt.ShouldBe(newer);
    }

    [Fact]
    public void NormalizeRecentOpens_写错为视觉脚印的文学工作区按场景纠正()
    {
        var opens = new[]
        {
            new UserRecentOpen
            {
                AgentKey = "visual-agent",
                EntityId = "workspace-2",
                LastOpenedAt = DateTime.UtcNow,
            },
        };
        var workspaces = new Dictionary<string, HomeRecentWorkController.WorkspaceRecentMetadata>
        {
            ["workspace-2"] = new("验收稿", "article-illustration"),
        };

        var item = HomeRecentWorkController.NormalizeRecentOpens(opens, workspaces).ShouldHaveSingleItem();

        item.AgentKey.ShouldBe("literary-agent");
    }
}
