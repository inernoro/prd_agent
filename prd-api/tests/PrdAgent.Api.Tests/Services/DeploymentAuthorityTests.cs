using Microsoft.Extensions.Configuration;
using PrdAgent.Infrastructure.Security;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

/// <summary>
/// 守卫「只有权威部署才写共享库全局告警行」的判定逻辑（见 DeploymentAuthority）。
/// 这是「平台 API key 解密失败」告警反复出现的根因修复：CDS 分支预览容器共享同一个
/// Mongo 库，此前谁都能写那唯一的全局告警行，旧构建/异钥分支反复复活误报。
/// </summary>
public class DeploymentAuthorityTests
{
    private static IConfiguration Build(Dictionary<string, string?> values)
        => new ConfigurationBuilder().AddInMemoryCollection(values).Build();

    [Fact]
    public void ProductionWithoutCdsMarker_IsAuthoritative()
    {
        var config = Build(new());
        DeploymentAuthority.IsAuthoritativeDeployment(config).ShouldBeTrue();
    }

    [Fact]
    public void CdsBranchPreview_IsNotAuthoritative()
    {
        // CDS 给每个分支预览容器注入 CDS_PROJECT_ID（cds/src/routes/branches.ts）
        var config = Build(new() { ["CDS_PROJECT_ID"] = "50bf3eac3d02" });
        DeploymentAuthority.IsAuthoritativeDeployment(config).ShouldBeFalse();
    }

    [Fact]
    public void SharedScheduledWork_ProductionRuns_PreviewDoesNot()
    {
        DeploymentAuthority.CanRunSharedScheduledWork(Build(new())).ShouldBeTrue();
        DeploymentAuthority.CanRunSharedScheduledWork(
            Build(new() { ["CDS_PROJECT_ID"] = "50bf3eac3d02" })).ShouldBeFalse();
    }

    [Fact]
    public void SharedScheduledWork_NotificationTakeoverDoesNotUnlockPreview()
    {
        // ManageGlobalNotification=true 的语义是「让这个分支临时接管全局告警行」。
        // 它绝不该顺带把「对着共享库和 CDS 跑周期拉取」也解锁——同项目所有分支预览
        // 共用一个 Mongo，N 个分支同时跑同一个拉取任务，既是对上游的自我 DDoS，
        // 也让「这批文档是谁写的」变得不可追（Codex review P2）。
        //
        // 没有这一条，把判据换回 IsAuthoritativeDeployment 也全绿——那正是这次的缺陷。
        var previewTakingOverNotifications = Build(new()
        {
            ["CDS_PROJECT_ID"] = "50bf3eac3d02",
            ["PlatformKeyIntegrity:ManageGlobalNotification"] = "true",
        });
        DeploymentAuthority.IsAuthoritativeDeployment(previewTakingOverNotifications).ShouldBeTrue();
        DeploymentAuthority.CanRunSharedScheduledWork(previewTakingOverNotifications).ShouldBeFalse();
    }

    [Fact]
    public void SharedScheduledWork_ExplicitFalseIsAVeto()
    {
        // 软开关只能收紧：standby/canary 写 false 表示「我不拥有任何共享状态」，
        // 那么周期任务也不许跑。与 CanRotateSharedCiphertext 同一形状。
        DeploymentAuthority.CanRunSharedScheduledWork(Build(new()
        {
            ["PlatformKeyIntegrity:ManageGlobalNotification"] = "false",
        })).ShouldBeFalse();
    }

    [Fact]
    public void LegacyTranscriptAdoption_UsesOneBoundedAuthorityPerEnvironment()
    {
        var production = Build(new());
        DeploymentAuthority.CanAdoptLegacyTranscriptRuns(production).ShouldBeTrue();
        DeploymentAuthority.GetLegacyTranscriptCreatedBeforeUtc(production)
            .ShouldBe(DeploymentAuthority.LegacyTranscriptRolloutCreatedBeforeUtc);

        DeploymentAuthority.CanAdoptLegacyTranscriptRuns(Build(new()
        {
            ["Transcript:AdoptLegacyUnownedRuns"] = "false",
        })).ShouldBeFalse();
        DeploymentAuthority.CanAdoptLegacyTranscriptRuns(Build(new()
        {
            ["Transcript:AdoptLegacyUnownedRuns"] = "true",
        })).ShouldBeFalse();
        DeploymentAuthority.CanAdoptLegacyTranscriptRuns(Build(new()
        {
            ["Transcript:AdoptLegacyUnownedRuns"] = "true",
            ["Deployment:LegacyOwnerCreatedBeforeUtc"] = "2026-01-01T00:00:00Z",
        })).ShouldBeTrue();
        DeploymentAuthority.CanAdoptLegacyTranscriptRuns(Build(new()
        {
            ["CDS_PROJECT_ID"] = "50bf3eac3d02",
            ["Changelog:GitHubBranch"] = "main",
        })).ShouldBeTrue();
        DeploymentAuthority.CanAdoptLegacyTranscriptRuns(Build(new()
        {
            ["CDS_PROJECT_ID"] = "50bf3eac3d02",
            ["Changelog:GitHubBranch"] = "codex/self-avatar-edit",
        })).ShouldBeFalse();
    }

    [Fact]
    public void LegacyBranchOwnerAdoption_RequiresOneExplicitNonCdsAuthority()
    {
        DeploymentAuthority.CanAdoptLegacyBranchOwners(Build(new())).ShouldBeFalse();
        DeploymentAuthority.CanAdoptLegacyBranchOwners(Build(new()
        {
            ["Deployment:AdoptLegacyBranchOwners"] = "true",
        })).ShouldBeFalse();
        var authorized = Build(new()
        {
            ["Deployment:AdoptLegacyBranchOwners"] = "true",
            ["Deployment:RetiredLegacyBranchOwnerIds"] = "main,codex/retired-preview,main",
            ["Deployment:LegacyOwnerCreatedBeforeUtc"] = "2026-01-01T00:00:00Z",
        });
        DeploymentAuthority.CanAdoptLegacyBranchOwners(authorized).ShouldBeTrue();
        DeploymentAuthority.GetRetiredLegacyBranchOwnerIds(authorized)
            .ShouldBe(["main", "codex/retired-preview"]);
        DeploymentAuthority.GetRetiredLegacyBranchOwnerCreatedBeforeUtc(authorized)
            .ShouldBe(new DateTime(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc));
        DeploymentAuthority.CanAdoptLegacyBranchOwners(Build(new()
        {
            ["Deployment:AdoptLegacyBranchOwners"] = "true",
            ["Deployment:RetiredLegacyBranchOwnerIds"] = "main",
            ["Deployment:LegacyOwnerCreatedBeforeUtc"] = "2999-01-01T00:00:00Z",
        })).ShouldBeFalse();
        DeploymentAuthority.CanAdoptLegacyBranchOwners(Build(new()
        {
            ["Deployment:AdoptLegacyBranchOwners"] = "true",
            ["Deployment:RetiredLegacyBranchOwnerIds"] = "main",
            ["Deployment:LegacyOwnerCreatedBeforeUtc"] = "2026-01-01T00:00:00Z",
            ["CDS_PROJECT_ID"] = "50bf3eac3d02",
        })).ShouldBeFalse();
    }

    [Fact]
    public void ExplicitFalse_OverridesProductionAuthority()
    {
        var config = Build(new() { ["PlatformKeyIntegrity:ManageGlobalNotification"] = "false" });
        DeploymentAuthority.IsAuthoritativeDeployment(config).ShouldBeFalse();
    }

    [Fact]
    public void ExplicitTrue_OverridesBranchPreview()
    {
        // 某个分支想临时接管全局告警的逃生阀
        var config = Build(new()
        {
            ["CDS_PROJECT_ID"] = "50bf3eac3d02",
            ["PlatformKeyIntegrity:ManageGlobalNotification"] = "true",
        });
        DeploymentAuthority.IsAuthoritativeDeployment(config).ShouldBeTrue();
    }

    [Fact]
    public void ProductionCanRotateSharedCiphertext()
    {
        var config = Build(new());
        DeploymentAuthority.CanRotateSharedCiphertext(config).ShouldBeTrue();
    }

    [Fact]
    public void CdsBranchPreview_CannotRotateSharedCiphertext()
    {
        var config = Build(new() { ["CDS_PROJECT_ID"] = "50bf3eac3d02" });
        DeploymentAuthority.CanRotateSharedCiphertext(config).ShouldBeFalse();
    }

    [Fact]
    public void DisabledStandbyOnProduction_CannotRotate()
    {
        // P2 回归（Codex review r3580192158）：无 CDS 标记但显式 ManageGlobalNotification=false
        // 的 standby/canary 已退出共享状态归属，绝不可改写共享库密文（哪怕它有专属 primary）。
        var config = Build(new() { ["PlatformKeyIntegrity:ManageGlobalNotification"] = "false" });

        DeploymentAuthority.IsAuthoritativeDeployment(config).ShouldBeFalse();
        DeploymentAuthority.CanRotateSharedCiphertext(config).ShouldBeFalse();
    }

    [Fact]
    public void BranchPreviewTakingOverNotification_StillCannotRotate()
    {
        // P2 回归（Codex review r3580140302）：接管通知的开关绝不解锁密文重加密。
        // 否则异钥预览分支会用本分支密钥改写共享库密文、打哑生产。
        var config = Build(new()
        {
            ["CDS_PROJECT_ID"] = "50bf3eac3d02",
            ["PlatformKeyIntegrity:ManageGlobalNotification"] = "true",
        });

        DeploymentAuthority.IsAuthoritativeDeployment(config).ShouldBeTrue();   // 可写通知
        DeploymentAuthority.CanRotateSharedCiphertext(config).ShouldBeFalse();  // 但绝不 rotate
    }

    [Fact]
    public void DescribeSource_IncludesShortCommitAndBranch()
    {
        var config = Build(new()
        {
            ["GIT_COMMIT"] = "abcdef1234567890",
            ["CDS_BRANCH_SLUG"] = "codex-cds-managed-delivery-readme",
        });

        var source = DeploymentAuthority.DescribeSource(config);

        source.ShouldContain("abcdef12");           // 前 8 位
        source.ShouldNotContain("abcdef1234");      // 已截断
        source.ShouldContain("codex-cds-managed-delivery-readme");
    }

    [Fact]
    public void DescribeSource_FallsBackToUnknownCommit()
    {
        var config = Build(new());
        DeploymentAuthority.DescribeSource(config).ShouldContain("unknown");
    }
}
