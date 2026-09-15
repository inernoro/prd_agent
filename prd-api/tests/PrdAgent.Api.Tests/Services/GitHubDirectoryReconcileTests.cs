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
}
