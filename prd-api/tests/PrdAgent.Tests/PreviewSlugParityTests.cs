using PrdAgent.Infrastructure.Services.ClaudeSidecar;
using Xunit;

namespace PrdAgent.Tests;

/// <summary>
/// 防漂移：C# 端 <see cref="ClaudeSidecarRouter.ComputePreviewSlug"/> 是容器内
/// 兜底实现，**必须**与 TypeScript SSOT
/// (<c>cds/src/services/preview-slug.ts:computePreviewSlug</c>) 输出完全一致。
///
/// 用例与 <c>cds/tests/services/preview-slug.test.ts</c> 一一对齐；
/// 任何一边改公式但忘了同步另一边，CI 立刻 fail。
///
/// 历史踩坑：2026-05 用户反复反馈"预览总是生成错误"，根因之一就是没有这个守护，
/// .NET 端可以悄悄改 slug 公式而 CDS 不知道（反之亦然）。
/// </summary>
public class PreviewSlugParityTests
{
    [Theory]
    // —— TS 文件里 `computePreviewSlug — v3 格式` 描述块的每个 it() 都对应一行 ——
    [InlineData("claude/fix-refresh-error-handling-2Xayx", "prd-agent",
                "fix-refresh-error-handling-2xayx-claude-prd-agent")]
    [InlineData("claude/fix-foo", "prd-agent", "fix-foo-claude-prd-agent")]
    [InlineData("cursor/ui-tweak", "prd-agent", "ui-tweak-cursor-prd-agent")]
    [InlineData("feat/login", "demo", "login-feat-demo")]
    [InlineData("fix/null-deref", "demo", "null-deref-fix-demo")]
    [InlineData("refactor/auth-module", "demo", "auth-module-refactor-demo")]
    // 多级路径：第一个 / 切，后续 / 走 slugify 变 -
    [InlineData("feat/auth/login", "prd-agent", "auth-login-feat-prd-agent")]
    [InlineData("claude/agent/upgrade-x", "prd-agent", "agent-upgrade-x-claude-prd-agent")]
    // 无 prefix → 中段省略
    [InlineData("main", "prd-agent", "main-prd-agent")]
    [InlineData("develop", "demo", "develop-demo")]
    // 大小写归一
    [InlineData("CLAUDE/Fix-Foo", "PRD-Agent", "fix-foo-claude-prd-agent")]
    [InlineData("Feature/UI-Refactor", "My_Project", "ui-refactor-feature-my-project")]
    // 特殊字符 slug 化
    [InlineData("feat/foo_bar.baz", "my_proj", "foo-bar-baz-feat-my-proj")]
    [InlineData("feat/中文-test", "demo", "test-feat-demo")]
    public void ComputePreviewSlug_MatchesTypeScriptSSOT(
        string branch, string project, string expected)
    {
        var actual = ClaudeSidecarRouter.ComputePreviewSlug(branch, project);
        Assert.Equal(expected, actual);
    }

    [Theory]
    // 边界：分支名以 / 开头，无有效 prefix → tail-project
    [InlineData("/foo", "demo", "foo-demo")]
    // 边界：分支名以 / 结尾，无 tail → prefix-project
    [InlineData("foo/", "demo", "foo-demo")]
    public void ComputePreviewSlug_EdgeCases(string branch, string project, string expected)
    {
        var actual = ClaudeSidecarRouter.ComputePreviewSlug(branch, project);
        Assert.Equal(expected, actual);
    }

    [Theory]
    // 空 branch / 空 project → null（C# 不像 TS 返回 project，而是返回 null
    // 因为 callsite ResolveDerivedPreviewBaseUrl 用 null 作为"没法推算"的信号）
    [InlineData("", "demo")]
    [InlineData("main", "")]
    [InlineData(null, "demo")]
    [InlineData("main", null)]
    public void ComputePreviewSlug_NullOrEmpty_ReturnsNull(string? branch, string? project)
    {
        var actual = ClaudeSidecarRouter.ComputePreviewSlug(branch, project);
        Assert.Null(actual);
    }
}
