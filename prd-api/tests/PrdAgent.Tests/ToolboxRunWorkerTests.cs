using Microsoft.Extensions.Configuration;
using PrdAgent.Api.Services.Toolbox;
using Xunit;

namespace PrdAgent.Tests;

/// <summary>
/// ToolboxRunWorker.ResolveRunKind regression tests.
/// RunKind is the queue isolation key: if two sandboxes accidentally share
/// the same key, they consume each other's toolbox tasks.
/// 
/// NOTE: AgentWorkspace.Resolve always provides defaults for GitRef ("main")
/// and GitHubRepository ("inernoro/prd_agent") when no env vars are set, so
/// the "toolbox-v3:local" fallback is unreachable unless both env vars are
/// explicitly unset AND the workspace root is missing.  The local-path tests
/// below therefore set AgentWorkspace:Root to a nonexistent directory, which
/// causes AgentWorkspace.Resolve to fall back to CWD but still retain the
/// hardcoded repo/branch defaults -- making the local fallback de facto dead
/// code.  This test documents that behaviour.
/// </summary>
public class ToolboxRunWorkerTests
{
    private static IConfiguration Config(params (string key, string value)[] pairs)
    {
        var dict = new Dictionary<string, string?>();
        foreach (var (k, v) in pairs)
            dict[k] = v;
        return new ConfigurationBuilder().AddInMemoryCollection(dict).Build();
    }

    [Fact]
    public void ResolveRunKind_FullBranchAndRepo_ReturnsProjectAndBranch()
    {
        var config = Config(
            ("VITE_GIT_BRANCH", "main"),
            ("AGENT_WORKSPACE_GITHUB_REPOSITORY", "inernoro/prd_agent"));

        var kind = ToolboxRunWorker.ResolveRunKind(config);

        Assert.Equal("toolbox-v3:prd-agent:main", kind);
    }

    [Fact]
    public void ResolveRunKind_ExplicitProjectSlug_WinsOverRepoDerived()
    {
        var config = Config(
            ("VITE_GIT_BRANCH", "main"),
            ("AGENT_WORKSPACE_GITHUB_REPOSITORY", "inernoro/prd_agent"),
            ("AGENT_WORKSPACE_PROJECT_SLUG", "my-project"));

        var kind = ToolboxRunWorker.ResolveRunKind(config);

        Assert.Equal("toolbox-v3:my-project:main", kind);
    }

    [Fact]
    public void ResolveRunKind_FeatureBranchWithSlash_IsSlugified()
    {
        var config = Config(
            ("VITE_GIT_BRANCH", "feat/auth/login"),
            ("AGENT_WORKSPACE_GITHUB_REPOSITORY", "inernoro/prd_agent"));

        var kind = ToolboxRunWorker.ResolveRunKind(config);

        Assert.Equal("toolbox-v3:prd-agent:feat-auth-login", kind);
    }

    [Fact]
    public void ResolveRunKind_MixedCaseBranch_IsLowered()
    {
        var config = Config(
            ("VITE_GIT_BRANCH", "Feature/NewLogin"),
            ("AGENT_WORKSPACE_GITHUB_REPOSITORY", "inernoro/prd_agent"));

        var kind = ToolboxRunWorker.ResolveRunKind(config);

        Assert.Equal("toolbox-v3:prd-agent:feature-newlogin", kind);
    }

    [Fact]
    public void ResolveRunKind_EmptyConfig_FallsBackToWorkspaceDefaults()
    {
        // AgentWorkspace.Resolve defaults to "main" / "inernoro/prd_agent"
        // when no env vars or config keys are set.
        var config = Config();

        var kind = ToolboxRunWorker.ResolveRunKind(config);

        Assert.Equal("toolbox-v3:prd-agent:main", kind);
    }

    [Fact]
    public void ResolveRunKind_NoBranchSpecified_StillFallsBackToWorkspaceDefault()
    {
        // Even when branch is absent from config, workspace.Resolve provides "main".
        var config = Config(
            ("AGENT_WORKSPACE_GITHUB_REPOSITORY", "inernoro/prd_agent"));

        var kind = ToolboxRunWorker.ResolveRunKind(config);

        Assert.Equal("toolbox-v3:prd-agent:main", kind);
    }

    [Fact]
    public void ResolveRunKind_NoRepositoryInConfig_StillFallsBackToWorkspaceDefault()
    {
        // Even when repo is absent from config, workspace.Resolve provides
        // the hardcoded fallback "inernoro/prd_agent".
        var config = Config(
            ("VITE_GIT_BRANCH", "main"));

        var kind = ToolboxRunWorker.ResolveRunKind(config);

        Assert.Equal("toolbox-v3:prd-agent:main", kind);
    }

    [Fact]
    public void ResolveRunKind_BranchWithSpecialChars_IsSlugified()
    {
        var config = Config(
            ("VITE_GIT_BRANCH", "fix/bug-123!@#"),
            ("AGENT_WORKSPACE_GITHUB_REPOSITORY", "inernoro/prd_agent"));

        var kind = ToolboxRunWorker.ResolveRunKind(config);

        // non-alphanumeric chars become dash; consecutive non-alnum collapse
        Assert.Equal("toolbox-v3:prd-agent:fix-bug-123", kind);
    }

    [Fact]
    public void ResolveRunKind_AlternativeConfigKeys_AreFallback()
    {
        // AGENT_WORKSPACE_GIT_REF should work when VITE_GIT_BRANCH is absent
        var config = Config(
            ("AGENT_WORKSPACE_GIT_REF", "develop"),
            ("GITHUB_REPOSITORY", "inernoro/prd_agent"));

        var kind = ToolboxRunWorker.ResolveRunKind(config);

        Assert.Equal("toolbox-v3:prd-agent:develop", kind);
    }

    [Fact]
    public void ResolveRunKind_DifferentReposProduceDifferentKinds()
    {
        var configA = Config(
            ("VITE_GIT_BRANCH", "main"),
            ("AGENT_WORKSPACE_GITHUB_REPOSITORY", "inernoro/prd_agent"));

        var configB = Config(
            ("VITE_GIT_BRANCH", "main"),
            ("AGENT_WORKSPACE_GITHUB_REPOSITORY", "inernoro/other_repo"));

        var kindA = ToolboxRunWorker.ResolveRunKind(configA);
        var kindB = ToolboxRunWorker.ResolveRunKind(configB);

        Assert.NotEqual(kindA, kindB);
        Assert.Equal("toolbox-v3:prd-agent:main", kindA);
        Assert.Equal("toolbox-v3:other-repo:main", kindB);
    }

    [Fact]
    public void ResolveRunKind_DifferentBranchesProduceDifferentKinds()
    {
        var configA = Config(
            ("VITE_GIT_BRANCH", "main"),
            ("AGENT_WORKSPACE_GITHUB_REPOSITORY", "inernoro/prd_agent"));

        var configB = Config(
            ("VITE_GIT_BRANCH", "feat/toolbox-v2"),
            ("AGENT_WORKSPACE_GITHUB_REPOSITORY", "inernoro/prd_agent"));

        var kindA = ToolboxRunWorker.ResolveRunKind(configA);
        var kindB = ToolboxRunWorker.ResolveRunKind(configB);

        Assert.NotEqual(kindA, kindB);
    }
}
