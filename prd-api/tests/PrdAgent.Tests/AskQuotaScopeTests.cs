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
