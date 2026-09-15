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
    public void 列目录404且上级清单里没有它才算远端删光()
    {
        // Git 里没有空目录：删光最后一个文件，目录本身就不存在了，列目录拿到的是 404
        // 而不是「200 + 空清单」。这是最常见的一种删除，必须走调和——
        // 但要有正面证据：上一级在同一个提交上列得出来，清单里确实没有它。
        Assert.True(GitHubDirectorySyncService.ShouldReconcileAsEmpty(
            HttpStatusCode.NotFound, GitHubDirectorySyncService.PathAbsence.ProvenAbsent));
    }

    [Fact]
    public void 拿不到它确实没了的证据时404一律不许当真()
    {
        // GitHub 对「无权访问的私有仓」回的也是 404，和「目录真没了」逐字一样。
        // 证据取不到（读不到仓库、清单可能被截断、网络不通）就不许删；
        // 上一级清单里明明还有它，那条 404 更是另有来路，同样不许删。
        Assert.False(GitHubDirectorySyncService.ShouldReconcileAsEmpty(
            HttpStatusCode.NotFound, GitHubDirectorySyncService.PathAbsence.Unproven));
        Assert.False(GitHubDirectorySyncService.ShouldReconcileAsEmpty(
            HttpStatusCode.NotFound, GitHubDirectorySyncService.PathAbsence.ProvenPresent));
    }

    [Fact]
    public void 目录不是404时与本判据无关()
    {
        // 限额、权限不足、GitHub 故障各有各的处置，不能借道这条判据去删东西。
        // 连「证明了它不存在」都不能让它们借道。
        foreach (var absence in Enum.GetValues<GitHubDirectorySyncService.PathAbsence>())
        {
            Assert.False(GitHubDirectorySyncService.ShouldReconcileAsEmpty(HttpStatusCode.Forbidden, absence));
            Assert.False(GitHubDirectorySyncService.ShouldReconcileAsEmpty(HttpStatusCode.InternalServerError, absence));
            Assert.False(GitHubDirectorySyncService.ShouldReconcileAsEmpty(HttpStatusCode.OK, absence));
        }
    }

    [Theory]
    [InlineData("doc/design/a", "doc/design")]
    [InlineData("doc", "")]           // 上一级是仓库根
    [InlineData("", null)]            // 仓库根本身无处可上溯：它不会「被删掉」，只会「读不到」
    public void 上溯一级(string path, string? expected)
    {
        Assert.Equal(expected, GitHubDirectorySyncService.ParentPathOf(path));
    }

    [Theory]
    [InlineData("doc/design/a", "a")]
    [InlineData("doc", "doc")]
    public void 取最后一段名字(string path, string expected)
    {
        Assert.Equal(expected, GitHubDirectorySyncService.NameOf(path));
    }

    [Fact]
    public void 解析ref的地址对分支标签提交号一视同仁()
    {
        // 订阅地址 /tree/<ref>/<path> 里那一段允许是标签或提交号（`/tree/v1.2/docs`）。
        // 用只认分支的 /branches/{ref} 去解析，这类订阅会解析失败 → 整轮中止 → 永远同步不了。
        // 断言的是这个纯函数吐出来的地址本身，不是源码里有没有某几个字：
        // 前者换个写法照样成立，后者一重构就假红、一写错又可能假绿。
        var url = GitHubDirectorySyncService.BuildRefResolveUrl("inernoro", "prd_agent", "v1.2");

        Assert.Equal("https://api.github.com/repos/inernoro/prd_agent/commits/v1.2", url);
        // 带斜杠的分支名（feature/foo）转义成 %2F，实测 GitHub 照样解析得出来
        Assert.EndsWith("/commits/feature%2Ffoo",
            GitHubDirectorySyncService.BuildRefResolveUrl("o", "r", "feature/foo"),
            StringComparison.Ordinal);
    }

    [Fact]
    public void 列目录的地址逐段转义路径且带上ref()
    {
        // 目录名里合法的 # 会被当成片段、? 会被当成查询串；斜杠是分隔符必须留着。
        var url = GitHubDirectorySyncService.BuildContentsUrl(
            "o", "r", "doc/a b#c", new GitHubDirectorySyncService.PinnedRef("abc123"));

        Assert.Equal("https://api.github.com/repos/o/r/contents/doc/a%20b%23c?ref=abc123", url);
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
