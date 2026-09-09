using System.Collections.Generic;
using System.Linq;
using PrdAgent.Infrastructure.GitHub;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

/// <summary>
/// 知识库 GitHub 同步向导的「默认勾哪些目录」判据（纯函数，无需网络/DB）。
///
/// 用户口径：登录 GitHub 后**递归**扫出仓库里所有 doc / docs 目录并默认预勾。
/// 这里把该口径钉成可打红的断言 —— 判据一旦被改窄（只认根目录 doc/）
/// 或改宽（把 node_modules 里的 docs 也勾上），下面的用例立刻变红。
/// </summary>
public class GitHubDocDirectoryPlannerTests
{
    private static GitHubDirectoryScan Scan(params (string path, string type)[] entries)
        => GitHubDocDirectoryPlanner.BuildDirectories(
            entries.Select(e => new GitHubTreeEntry(e.path, e.type)),
            owner: "acme", repo: "site", branch: "main");

    [Fact]
    public void 递归命中所有层级的doc目录()
    {
        var scan = Scan(
            ("doc", "tree"),
            ("doc/a.md", "blob"),
            ("packages/web/docs", "tree"),
            ("packages/web/docs/readme.md", "blob"),
            ("src", "tree"),
            ("src/main.ts", "blob"));

        // packages 在忽略名单里 —— 但这里要验的是"深层 docs 也能命中"，
        // 所以用 apps/ 这种普通目录再验一次（见下个用例）。
        Assert.Contains("doc", scan.RecommendedPaths);
        Assert.DoesNotContain("src", scan.RecommendedPaths);
    }

    [Fact]
    public void 深层docs目录同样预勾()
    {
        var scan = Scan(
            ("apps", "tree"),
            ("apps/web", "tree"),
            ("apps/web/docs", "tree"),
            ("apps/web/docs/guide.md", "blob"),
            ("apps/web/src/index.ts", "blob"));

        Assert.Contains("apps/web/docs", scan.RecommendedPaths);
        Assert.DoesNotContain("apps/web/src", scan.RecommendedPaths);
        Assert.DoesNotContain("apps/web", scan.RecommendedPaths);
    }

    [Fact]
    public void doc目录的子目录只要有markdown也预勾()
    {
        // 同步引擎是单层拉取的：只勾 doc/ 会漏掉 doc/guide 下的文件，
        // 所以 doc 的后代目录只要直属 .md 就一起预勾。
        var scan = Scan(
            ("doc", "tree"),
            ("doc/guide", "tree"),
            ("doc/guide/start.md", "blob"),
            ("doc/assets", "tree"),
            ("doc/assets/logo.png", "blob"));

        Assert.Contains("doc/guide", scan.RecommendedPaths);
        Assert.DoesNotContain("doc/assets", scan.RecommendedPaths);   // 没有 .md
        Assert.DoesNotContain("doc", scan.RecommendedPaths);          // 空壳容器，直属 0 个 .md
    }

    [Fact]
    public void 构建产物与依赖目录里的docs一律不预勾()
    {
        var scan = Scan(
            ("node_modules/pkg/docs/readme.md", "blob"),
            ("dist/docs/index.md", "blob"),
            ("vendor/lib/doc/api.md", "blob"),
            (".github/docs/ci.md", "blob"));

        Assert.Empty(scan.RecommendedPaths);
    }

    [Fact]
    public void 大小写与markdown扩展名都算数()
    {
        var scan = Scan(
            ("Docs/Intro.MD", "blob"),
            ("DOC/legacy.markdown", "blob"));

        Assert.Contains("Docs", scan.RecommendedPaths);
        Assert.Contains("DOC", scan.RecommendedPaths);
    }

    [Fact]
    public void 目录节点带父子关系与markdown计数()
    {
        var scan = Scan(
            ("doc", "tree"),
            ("doc/a.md", "blob"),
            ("doc/b.md", "blob"),
            ("doc/cover.png", "blob"));

        var node = scan.Directories.Single(d => d.Path == "doc");
        Assert.Equal("doc", node.Name);
        Assert.Equal(string.Empty, node.ParentPath);
        Assert.Equal(1, node.Depth);
        Assert.Equal(2, node.MarkdownCount);
        Assert.Equal(3, node.FileCount);
        Assert.True(node.Recommended);

        // 仓库根目录始终在列表里，作为树的根
        Assert.Contains(scan.Directories, d => d.Path == string.Empty && d.Name == "/");
    }

    [Fact]
    public void 空目录也会出现在可选清单里只是不预勾()
    {
        var scan = Scan(("empty", "tree"));

        Assert.Contains(scan.Directories, d => d.Path == "empty");
        Assert.Empty(scan.RecommendedPaths);
    }

    [Fact]
    public void 超出上限时优先保留推荐目录及其祖先()
    {
        var entries = new List<(string, string)>
        {
            ("deep", "tree"),
            ("deep/nested", "tree"),
            ("deep/nested/docs", "tree"),
            ("deep/nested/docs/a.md", "blob"),
        };
        for (var i = 0; i < 50; i++) entries.Add(($"noise{i}", "tree"));

        var scan = GitHubDocDirectoryPlanner.BuildDirectories(
            entries.Select(e => new GitHubTreeEntry(e.Item1, e.Item2)),
            "acme", "site", "main", maxDirectories: 6);

        Assert.True(scan.Truncated);
        Assert.Equal(54, scan.TotalDirectories);
        Assert.Contains("deep/nested/docs", scan.RecommendedPaths);
        // 祖先必须一起保留，否则前端的目录树会断链
        Assert.Contains(scan.Directories, d => d.Path == "deep");
        Assert.Contains(scan.Directories, d => d.Path == "deep/nested");
    }

    [Fact]
    public void 上游截断标记透传()
    {
        var scan = GitHubDocDirectoryPlanner.BuildDirectories(
            new[] { new GitHubTreeEntry("doc/a.md", "blob") },
            "acme", "site", "main", truncatedUpstream: true);

        Assert.True(scan.Truncated);
    }
}
