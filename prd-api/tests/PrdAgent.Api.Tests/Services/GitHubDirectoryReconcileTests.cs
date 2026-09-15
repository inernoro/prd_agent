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
    public void 存量条目按路径认亲而不认地址里的ref()
    {
        // 早期条目没单独存路径，只存了地址，而地址里嵌着分支名。列目录改成按提交号列之后，
        // 上游给回的地址换成了带提交号的那种——逐字比对地址就认不出同一个文件，
        // 于是它被当成新文件建一遍、原来那条被当成「远端已不存在」删掉，历史版本一起没。
        var legacy = Child(null, "https://raw.githubusercontent.com/o/r/main/doc/a.md");
        var indexed = GitHubDirectorySyncService.IndexExistingChildren(new[] { legacy });

        // 路径这个键必须在：本轮按路径就能认上，与地址里那段 ref 无关
        Assert.True(indexed.ContainsKey("doc/a.md"));

        var kept = GitHubDirectorySyncService.SelectStaleChildren(
            indexed, new HashSet<string> { "doc/a.md" });
        Assert.Empty(kept);
    }

    [Fact]
    public void 认不出路径的存量地址仍退回用原地址当键()
    {
        var legacy = Child(null, "https://example.com/somewhere");
        var indexed = GitHubDirectorySyncService.IndexExistingChildren(new[] { legacy });

        Assert.True(indexed.ContainsKey("https://example.com/somewhere"));
    }

    [Fact]
    public void 一条条目挂在两个键上也只删一次()
    {
        // 存量条目同时挂在「抠出的路径」与「原地址」两个键上；两个键都没被认到时，
        // 它应当只出现一次——否则同一条会被删两遍、计数翻倍。
        var legacy = Child(null, "https://raw.githubusercontent.com/o/r/main/doc/a.md");
        var indexed = GitHubDirectorySyncService.IndexExistingChildren(new[] { legacy });

        Assert.Equal(2, indexed.Count);
        Assert.Single(GitHubDirectorySyncService.SelectStaleChildren(indexed, new HashSet<string>()));
    }

    [Theory]
    [InlineData("https://raw.githubusercontent.com/o/r/main/doc/a.md", "doc/a.md")]
    [InlineData("https://raw.githubusercontent.com/o/r/abc123/doc/sub/b.md", "doc/sub/b.md")]
    [InlineData("https://github.com/o/r/blob/main/doc/a.md", "doc/a.md")]
    [InlineData("https://github.com/o/r/blob/abc123/doc/sub/b.md", "doc/sub/b.md")]
    public void 从地址里抠路径要跳过那段会变的ref(string url, string expected)
        => Assert.Equal(expected, GitHubDirectorySyncService.ExtractRepoPathFromGitHubUrl(url));

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("not a url")]
    [InlineData("https://raw.githubusercontent.com/o/r")]
    public void 抠不出路径就如实回空(string? url)
        => Assert.Null(GitHubDirectorySyncService.ExtractRepoPathFromGitHubUrl(url));

    [Fact]
    public void 两个键都没有的条目不进索引也就永远不会被删()
    {
        // 认不了亲的条目一律不碰：把它判成「远端已不存在」会删掉用户的东西。
        var indexed = GitHubDirectorySyncService.IndexExistingChildren(new[] { Child(null) });

        Assert.Empty(indexed);
        Assert.Empty(GitHubDirectorySyncService.SelectStaleChildren(indexed, new HashSet<string>()));
    }

    [Fact]
    public void 按提交号列目录拿到404才算远端删光()
    {
        // Git 里没有空目录：删光最后一个文件，目录本身就不存在了，列目录拿到的是 404
        // 而不是「200 + 空清单」。这是最常见的一种删除，必须走调和。
        // 提交号不可变——在它上面拿到 404，就证明那一刻该目录确实不存在。
        Assert.True(GitHubDirectorySyncService.ShouldReconcileAsEmpty(
            HttpStatusCode.NotFound, listedAtResolvedCommit: true));
    }

    [Fact]
    public void 没解析出提交号时的404一律不许当真()
    {
        // 按分支名列目录的 404 有太多来路：无权访问的私有仓、改名的仓库、被删的分支。
        // 而且分支会变——两次请求之间可能先删掉目录又把它恢复回来，
        // 事后再探一次分支只会探到「好好的」，于是把刚恢复的文档连历史版本一起删掉。
        Assert.False(GitHubDirectorySyncService.ShouldReconcileAsEmpty(
            HttpStatusCode.NotFound, listedAtResolvedCommit: false));
    }

    [Fact]
    public void 目录不是404时与本判据无关()
    {
        // 限额、权限不足、GitHub 故障各有各的处置，不能借道这条判据去删东西
        Assert.False(GitHubDirectorySyncService.ShouldReconcileAsEmpty(
            HttpStatusCode.Forbidden, listedAtResolvedCommit: true));
        Assert.False(GitHubDirectorySyncService.ShouldReconcileAsEmpty(
            HttpStatusCode.InternalServerError, listedAtResolvedCommit: true));
        Assert.False(GitHubDirectorySyncService.ShouldReconcileAsEmpty(
            HttpStatusCode.OK, listedAtResolvedCommit: true));
    }

    [Fact]
    public void 原始条数没到上限时清单算完整()
    {
        Assert.True(GitHubDirectorySyncService.IsListingComplete(0));
        Assert.True(GitHubDirectorySyncService.IsListingComplete(42));
        Assert.True(GitHubDirectorySyncService.IsListingComplete(
            GitHubDirectorySyncService.ContentsApiDirectoryCap - 1));
    }

    [Fact]
    public void 原始条数顶到上限就不能当成完整清单()
    {
        // GitHub 一次最多回 1000 条且不明说截断。窗口之外的文件这一轮「没见到」，
        // 但它们在远端好好的——此时「没见到」不等于「没有了」，删除环节必须让路。
        Assert.False(GitHubDirectorySyncService.IsListingComplete(
            GitHubDirectorySyncService.ContentsApiDirectoryCap));
        Assert.False(GitHubDirectorySyncService.IsListingComplete(
            GitHubDirectorySyncService.ContentsApiDirectoryCap + 200));
    }

    [Fact]
    public void 完整性只看过滤前的原始条数()
    {
        // 过滤后的 0 篇有两种来路：真没有 Markdown、或 Markdown 全被挤出窗口。
        // 只有原始条数分得开——一个塞了一千多个非 Markdown 文件的目录，过滤后同样是 0 篇，
        // 但它一篇都没少，绝不能按「远端删光了」处理。
        Assert.False(GitHubDirectorySyncService.IsListingComplete(1200));
    }
}
