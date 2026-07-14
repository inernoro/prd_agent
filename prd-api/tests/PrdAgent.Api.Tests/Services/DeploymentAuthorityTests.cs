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
