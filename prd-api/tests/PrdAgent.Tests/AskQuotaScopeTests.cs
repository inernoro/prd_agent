using PrdAgent.Core.Models;
using Xunit;

namespace PrdAgent.Tests;

/// <summary>
/// 提问配额 key 必须带部署作用域的守卫（PR #1351 第六轮 review）。
///
/// CDS 分支预览与生产**共用同一个 Redis**（cross-project-isolation 通道 4），站点 ID 也一样。
/// key 不盖作用域的话，在预览里点几下提问就吃掉生产那条分享的当日额度，把线上刷成
/// QUOTA_EXCEEDED，且要等到 key 过期才恢复。
///
/// 这里测的是通用的作用域拼接语义（生产为 null 时原样保留，保证存量计数不受影响）——
/// AskQuotaService 的两个 key 构造方法都经过它。
/// </summary>
public class AskQuotaScopeTests
{
    [Fact]
    public void 生产环境不加前缀_存量计数不受影响()
    {
        // 生产没有 CDS_PROJECT_ID，Current 为 null，key 原样返回
        var key = "ask-quota:site:abc:20260810";
        Assert.Equal(key, DeploymentScope.ScopeIdempotencyKey(key));
    }

    [Fact]
    public void 分支预览作用域会拼成前缀()
    {
        var scoped = DeploymentScope.Compose("prd-agent", "claude/feature", "abc123");
        Assert.NotNull(scoped);
        Assert.StartsWith("prd-agent", scoped);
        Assert.Contains("claude/feature", scoped);
    }

    [Fact]
    public void 同名分支不同项目不会撞车()
    {
        var a = DeploymentScope.Compose("project-a", "main", null);
        var b = DeploymentScope.Compose("project-b", "main", null);
        Assert.NotEqual(a, b);
    }

    [Fact]
    public void 空key原样返回_不产生只有前缀的怪key()
    {
        Assert.Equal("", DeploymentScope.ScopeIdempotencyKey(""));
    }
}

/// <summary>
/// 匿名配额取哪个 IP —— 源码守卫。
///
/// 由 review 抓出：`GetRealClientIp` 是给**统计**用的，它无条件采信 X-Real-IP /
/// X-Forwarded-For；而提问的分享路径匿名可达，攻击者每次换一个头就换一个配额桶，
/// 匿名闸形同虚设，站点主付费的日额度会被迅速啃光。
/// `GetAbuseControlClientIp` 只在对端是回环/私网（即我方反代）时才采信该头，
/// 与 RateLimitMiddleware 用的是同一个判据。
///
/// 改回去之后没有任何行为测试会红（两个方法签名一样、返回值也一样），只能守源码。
/// </summary>
public class AskQuotaClientIpGuardTests
{
    [Fact]
    public void 匿名配额必须用防滥用IP而不是统计IP()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir != null && !Directory.Exists(Path.Combine(dir.FullName, ".git"))
                           && !File.Exists(Path.Combine(dir.FullName, ".git")))
            dir = dir.Parent;
        Assert.NotNull(dir); // 找不到仓库根就让用例红，而不是静默跳过

        var path = Path.Combine(dir!.FullName,
            "prd-api", "src", "PrdAgent.Api", "Controllers", "Api", "WebPageAskController.cs");
        Assert.True(File.Exists(path), $"未找到被守文件：{path}");
        var src = File.ReadAllText(path);

        Assert.Contains("HttpContext.GetAbuseControlClientIp()", src);
        Assert.DoesNotContain("HttpContext.GetRealClientIp()", src);
    }
}

/// <summary>
/// 合集分享的执行路径守卫。
///
/// 展示路径不返回提问入口 ≠ 访问控制：拿着合集 token 的人可以直接 POST 里面某个
/// 开了提问的 siteId，一路走到付费的模型调用。策略存在却只接了展示那一半，
/// 正是 predicate-and-wiring-discipline 形状 2。删掉这道判定不会有任何行为测试变红。
/// </summary>
public class AskCollectionGateWiringGuardTests
{
    [Fact]
    public void 提问流端点必须在执行前挡掉合集分享()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir != null && !Directory.Exists(Path.Combine(dir.FullName, ".git"))
                           && !File.Exists(Path.Combine(dir.FullName, ".git")))
            dir = dir.Parent;
        Assert.NotNull(dir);

        var path = Path.Combine(dir!.FullName,
            "prd-api", "src", "PrdAgent.Api", "Controllers", "Api", "WebPageAskController.cs");
        Assert.True(File.Exists(path), $"未找到被守文件：{path}");
        var src = File.ReadAllText(path);

        var gate = src.IndexOf("AskAccessPolicy.IsCollectionShare(resolved.Share?.ShareType)", StringComparison.Ordinal);
        Assert.True(gate > 0, "分享提问端点缺少合集判定");

        // 必须挡在真正开跑之前，而不是记一笔了事
        var run = src.IndexOf("RunAskAsync(site, req, viewerUserId, shareToken: token)", StringComparison.Ordinal);
        Assert.True(run > gate, "合集判定必须出现在 RunAskAsync 之前");
    }
}
