using System.Net;
using PrdAgent.Api.Services;
using PrdAgent.Core.Models;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

/// <summary>
/// 「远端已经没有了的子文档要跟着删」的判据（2026-09-15 对抗审查 P2）。
///
/// 旧实现在列目录拿到 0 篇 Markdown 时直接 return，跳过了整个删除环节：
/// 远端把 doc 目录清空，知识库里的旧文档会永远留着，而界面显示同步成功。
/// 所以「空」这个边界必须和「少了几篇」走同一条路径——判据在这里，调用方只管照着删。
/// </summary>
public class GitHubDirectoryReconcileTests
{
    private static DocumentEntry Child(string? githubPath, string? sourceUrl = null) => new()
    {
        Title = githubPath ?? sourceUrl ?? "未命名",
        SourceUrl = sourceUrl,
        Metadata = githubPath == null
            ? new Dictionary<string, string>()
            : new Dictionary<string, string> { ["github_path"] = githubPath },
    };

    [Fact]
    public void 远端一篇都不剩时旧子文档全部进删除清单()
    {
        var indexed = GitHubDirectorySyncService.IndexExistingChildren(new[]
        {
            Child("doc/a.md"),
            Child("doc/b.md"),
        });

        // 这一轮没认到任何一个亲——远端目录被清空了
        var stale = GitHubDirectorySyncService.SelectStaleChildren(indexed, new HashSet<string>());

        Assert.Equal(2, stale.Count);
    }

    [Fact]
    public void 远端还在的那几篇不进删除清单()
    {
        var indexed = GitHubDirectorySyncService.IndexExistingChildren(new[]
        {
            Child("doc/a.md"),
            Child("doc/b.md"),
        });

        var stale = GitHubDirectorySyncService.SelectStaleChildren(
            indexed, new HashSet<string> { "doc/a.md" });

        Assert.Single(stale);
        Assert.Equal("doc/b.md", stale[0].Metadata["github_path"]);
    }

    [Fact]
    public void 存量条目用SourceUrl认亲()
    {
        // 早期条目没有 github_path，只能靠 SourceUrl（当时存的是 download_url）认亲。
        var legacy = Child(null, "https://raw.githubusercontent.com/o/r/main/doc/a.md");
        var indexed = GitHubDirectorySyncService.IndexExistingChildren(new[] { legacy });

        Assert.True(indexed.ContainsKey("https://raw.githubusercontent.com/o/r/main/doc/a.md"));

        var kept = GitHubDirectorySyncService.SelectStaleChildren(
            indexed, new HashSet<string> { "https://raw.githubusercontent.com/o/r/main/doc/a.md" });
        Assert.Empty(kept);
    }

    [Fact]
    public void 两个键都没有的条目不进索引也就永远不会被删()
    {
        // 认不了亲的条目一律不碰：把它判成「远端已不存在」会删掉用户的东西。
        var indexed = GitHubDirectorySyncService.IndexExistingChildren(new[] { Child(null) });

        Assert.Empty(indexed);
        Assert.Empty(GitHubDirectorySyncService.SelectStaleChildren(indexed, new HashSet<string>()));
    }

    [Fact]
    public void 目录没了而仓库分支还够得着才算远端删光()
    {
        // Git 里没有空目录：删光最后一个文件，目录本身就不存在了，列目录拿到的是 404
        // 而不是「200 + 空清单」。这是最常见的一种删除，必须走调和。
        Assert.True(GitHubDirectorySyncService.ShouldReconcileAsEmpty(
            HttpStatusCode.NotFound, HttpStatusCode.OK));
    }

    [Fact]
    public void 仓库或分支也够不着时绝不当成删光()
    {
        // GitHub 对无权访问的私有仓、改名的仓库、被删的分支一律回 404，和「目录真没了」
        // 长得一模一样。只凭目录那一个 404 就动手删，等于把一次权限变动变成一次数据清空。
        Assert.False(GitHubDirectorySyncService.ShouldReconcileAsEmpty(
            HttpStatusCode.NotFound, HttpStatusCode.NotFound));
        Assert.False(GitHubDirectorySyncService.ShouldReconcileAsEmpty(
            HttpStatusCode.NotFound, HttpStatusCode.Unauthorized));
    }

    [Fact]
    public void 探测没问出结论时也不许删()
        // 网络抖动让探测失败（null）——不确定就不动手，这是破坏性动作的默认姿势
        => Assert.False(GitHubDirectorySyncService.ShouldReconcileAsEmpty(
            HttpStatusCode.NotFound, null));

    [Fact]
    public void 目录不是404时与本判据无关()
    {
        // 限额、权限不足、GitHub 故障各有各的处置，不能借道这条判据去删东西
        Assert.False(GitHubDirectorySyncService.ShouldReconcileAsEmpty(
            HttpStatusCode.Forbidden, HttpStatusCode.OK));
        Assert.False(GitHubDirectorySyncService.ShouldReconcileAsEmpty(
            HttpStatusCode.InternalServerError, HttpStatusCode.OK));
    }
}
