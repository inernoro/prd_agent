using System.Text.Json;
using PrdAgent.Api.Services.ReportAgent;
using PrdAgent.Core.Models;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

/// <summary>
/// Report Agent v2.0 单元测试：数据模型、Artifact 解析、统计拆分
/// </summary>
public class ReportAgentV2Tests
{
    #region 5.1 Data Model Tests

    [Fact]
    public void ReportTeam_NewFields_ShouldHaveDefaults()
    {
        var team = new ReportTeam();

        Assert.Null(team.DataCollectionWorkflowId);
        Assert.Null(team.WorkflowTemplateKey);
    }

    [Fact]
    public void ReportTeamMember_IdentityMappings_ShouldBeEmpty()
    {
        var member = new ReportTeamMember();

        Assert.NotNull(member.IdentityMappings);
        Assert.Empty(member.IdentityMappings);
    }

    [Fact]
    public void ReportTeamMember_IdentityMappings_ShouldStoreMultiplePlatforms()
    {
        var member = new ReportTeamMember
        {
            IdentityMappings = new Dictionary<string, string>
            {
                ["github"] = "zhangsan",
                ["tapd"] = "zhangsan@company.com",
                ["yuque"] = "zhangsan",
                ["gitlab"] = "zhangsan"
            }
        };

        Assert.Equal(4, member.IdentityMappings.Count);
        Assert.Equal("zhangsan", member.IdentityMappings["github"]);
        Assert.Equal("zhangsan@company.com", member.IdentityMappings["tapd"]);
    }

    [Fact]
    public void WeeklyReport_NewFields_ShouldHaveDefaults()
    {
        var report = new WeeklyReport();

        Assert.Null(report.WorkflowExecutionId);
        Assert.Null(report.StatsSnapshot);
    }

    [Fact]
    public void WeeklyReportStatus_ShouldIncludeViewed()
    {
        Assert.Equal("viewed", WeeklyReportStatus.Viewed);
        Assert.Contains(WeeklyReportStatus.Viewed, WeeklyReportStatus.All);
    }

    [Fact]
    public void PersonalSource_DefaultValues_ShouldBeCorrect()
    {
        var source = new PersonalSource();

        Assert.NotNull(source.Id);
        Assert.NotEmpty(source.Id);
        Assert.Equal(string.Empty, source.UserId);
        Assert.Equal(PersonalSourceType.GitHub, source.SourceType);
        Assert.Equal(string.Empty, source.DisplayName);
        Assert.NotNull(source.Config);
        Assert.True(source.Enabled);
        Assert.Null(source.LastSyncAt);
        Assert.Equal(PersonalSourceSyncStatus.Never, source.LastSyncStatus);
    }

    [Fact]
    public void PersonalSourceType_ShouldHaveAllTypes()
    {
        Assert.Contains("github", PersonalSourceType.All);
        Assert.Contains("yuque", PersonalSourceType.All);
        // gitlab 尚未实现 PersonalSource 连接器，待实现后再加入
        Assert.Equal(2, PersonalSourceType.All.Length);
    }

    #endregion

    #region 5.3 Artifact Stats Parser Tests

    [Fact]
    public void ParseArtifacts_SingleSource_ShouldExtractStats()
    {
        var artifactJson = JsonSerializer.Serialize(new[]
        {
            new
            {
                source = "github",
                collectedAt = "2026-03-06T18:00:00Z",
                summary = new Dictionary<string, int>
                {
                    ["commits"] = 23,
                    ["prs_merged"] = 3,
                    ["lines_added"] = 1204
                },
                details = new[]
                {
                    new { id = "abc123", title = "fix: login bug", type = "commit", assignee = "zhangsan" },
                    new { id = "def456", title = "feat: add search", type = "commit", assignee = "lisi" }
                }
            }
        });

        var artifacts = new List<ExecutionArtifact>
        {
            new()
            {
                Name = "merged-data",
                MimeType = "application/json",
                InlineContent = artifactJson
            }
        };

        var stats = ArtifactStatsParser.Parse(artifacts);

        Assert.Single(stats.Sources);
        var github = stats.GetSource("github");
        Assert.Equal(23, github.Summary["commits"]);
        Assert.Equal(3, github.Summary["prs_merged"]);
        Assert.Equal(2, github.Details.Count);
        Assert.Equal("zhangsan", github.Details[0].Assignee);
    }

    [Fact]
    public void ParseArtifacts_MultipleSources_ShouldExtractAll()
    {
        var artifactJson = JsonSerializer.Serialize(new object[]
        {
            new
            {
                source = "tapd",
                summary = new Dictionary<string, int> { ["bugs_fixed"] = 5, ["stories_done"] = 3 },
                details = new object[]
                {
                    new { id = "1001", title = "修复首页加载", type = "bug", assignee = "zhangsan@company.com" }
                }
            },
            new
            {
                source = "github",
                summary = new Dictionary<string, int> { ["commits"] = 10 },
                details = new object[]
                {
                    new { id = "aaa111", title = "refactor: clean up", type = "commit", assignee = "zhangsan" }
                }
            }
        });

        var artifacts = new List<ExecutionArtifact>
        {
            new() { Name = "merged", MimeType = "application/json", InlineContent = artifactJson }
        };

        var stats = ArtifactStatsParser.Parse(artifacts);

        Assert.Equal(2, stats.Sources.Count);
        Assert.Equal(5, stats.GetSource("tapd").Summary["bugs_fixed"]);
        Assert.Equal(10, stats.GetSource("github").Summary["commits"]);
    }

    [Fact]
    public void ParseArtifacts_EmptyArtifacts_ShouldReturnEmptyStats()
    {
        var stats = ArtifactStatsParser.Parse(new List<ExecutionArtifact>());
        Assert.Empty(stats.Sources);
    }

    [Fact]
    public void ParseArtifacts_InvalidJson_ShouldReturnEmptyStats()
    {
        var artifacts = new List<ExecutionArtifact>
        {
            new() { Name = "bad", MimeType = "application/json", InlineContent = "not json" }
        };

        var stats = ArtifactStatsParser.Parse(artifacts);
        Assert.Empty(stats.Sources);
    }

    [Fact]
    public void ParseArtifacts_NonJsonArtifact_ShouldSkip()
    {
        var artifacts = new List<ExecutionArtifact>
        {
            new() { Name = "text-output", MimeType = "text/plain", InlineContent = "some text" }
        };

        var stats = ArtifactStatsParser.Parse(artifacts);
        Assert.Empty(stats.Sources);
    }

    [Fact]
    public void SplitByMember_ShouldAttributeDetailsCorrectly()
    {
        var teamStats = new TeamCollectedStats
        {
            Sources = new List<SourceStats>
            {
                new()
                {
                    SourceType = "github",
                    Summary = new Dictionary<string, int> { ["commits"] = 3 },
                    Details = new List<StatsDetail>
                    {
                        new() { Id = "a1", Title = "fix A", Assignee = "zhangsan" },
                        new() { Id = "a2", Title = "fix B", Assignee = "zhangsan" },
                        new() { Id = "a3", Title = "fix C", Assignee = "lisi" }
                    }
                },
                new()
                {
                    SourceType = "tapd",
                    Summary = new Dictionary<string, int> { ["bugs_fixed"] = 2 },
                    Details = new List<StatsDetail>
                    {
                        new() { Id = "t1", Title = "Bug 1", Assignee = "zhangsan@company.com" },
                        new() { Id = "t2", Title = "Bug 2", Assignee = "lisi@company.com" }
                    }
                }
            }
        };

        var members = new List<ReportTeamMember>
        {
            new()
            {
                UserId = "user-001",
                IdentityMappings = new Dictionary<string, string>
                {
                    ["github"] = "zhangsan",
                    ["tapd"] = "zhangsan@company.com"
                }
            },
            new()
            {
                UserId = "user-002",
                IdentityMappings = new Dictionary<string, string>
                {
                    ["github"] = "lisi",
                    ["tapd"] = "lisi@company.com"
                }
            }
        };

        var result = ArtifactStatsParser.SplitByMember(teamStats, members);

        Assert.Equal(2, result.Count);

        var zhangsan = result.First(r => r.UserId == "user-001");
        var lisi = result.First(r => r.UserId == "user-002");

        // zhangsan: 2 github commits + 1 tapd bug
        var zsGithub = zhangsan.Sources.First(s => s.SourceType == "github");
        Assert.Equal(2, zsGithub.Details.Count);
        Assert.Equal(2, zsGithub.Summary["commits"]);

        var zsTapd = zhangsan.Sources.First(s => s.SourceType == "tapd");
        Assert.Single(zsTapd.Details);
        Assert.Equal(1, zsTapd.Summary["bugs_fixed"]);

        // lisi: 1 github commit + 1 tapd bug
        var lsGithub = lisi.Sources.First(s => s.SourceType == "github");
        Assert.Single(lsGithub.Details);
    }

    #endregion

    #region 5.1 MemberCollectedStats Snapshot Tests

    [Fact]
    public void MemberCollectedStats_ToSnapshot_ShouldProduceCorrectDict()
    {
        var memberStats = new MemberCollectedStats
        {
            UserId = "user-001",
            Sources = new List<SourceStats>
            {
                new()
                {
                    SourceType = "github",
                    Summary = new Dictionary<string, int> { ["commits"] = 23, ["prs_merged"] = 3 }
                },
                new()
                {
                    SourceType = "tapd",
                    Summary = new Dictionary<string, int> { ["bugs_fixed"] = 5 }
                }
            }
        };

        var snapshot = memberStats.ToSnapshot();

        Assert.Equal(2, snapshot.Count);
        Assert.True(snapshot.ContainsKey("github"));
        Assert.True(snapshot.ContainsKey("tapd"));
    }

    #endregion
}
