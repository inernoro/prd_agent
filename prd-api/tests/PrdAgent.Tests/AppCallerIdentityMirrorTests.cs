using PrdAgent.Infrastructure.LlmGateway;
using PrdAgent.LlmGw.LogicalModels;
using Xunit;

namespace PrdAgent.Tests;

/// <summary>
/// appCaller 身份比较规则的两侧对照：权威侧 <see cref="GatewayAppCallerIdentity"/>
/// 与控制台镜像 <see cref="AppCallerIdentityPolicy"/>。
///
/// 为什么必须有这条：这份规则要在被动注册、治理读、路由读、去重、唯一索引之间逐处相同
/// （权威侧的类注释就是这么写的）。两边漂了不会有任何东西报错——漂的后果是
/// 「控制面说认领成功了，运行时找不到这条认领」，请求悄悄换一个模型（第 76 轮 review）。
///
/// console-api 按既定架构不引用 PrdAgent.*，所以只能留一份镜像；本测试项目是全仓
/// 唯一同时引用两侧的地方，对照只能在这里做。
/// </summary>
public sealed class AppCallerIdentityMirrorTests
{
    /// <summary>
    /// collation 的两个决定性字段逐项比：locale 与强度。
    ///
    /// 比字段而不是比对象：Collation 没有值相等语义，`Equals` 比的是引用，
    /// 两边各 new 一个永远不相等——那样写出来的断言恒红或恒绿，测不到任何东西。
    /// </summary>
    [Fact]
    public void 身份比较的_collation_两侧一致()
    {
        Assert.Equal(GatewayAppCallerIdentity.Collation.Locale, AppCallerIdentityPolicy.Collation.Locale);
        Assert.Equal(GatewayAppCallerIdentity.Collation.Strength, AppCallerIdentityPolicy.Collation.Strength);
    }

    /// <summary>NormalizePart 两侧同解：只去首尾空白，**不改大小写**。</summary>
    [Theory]
    [InlineData("  some-agent.feature::chat  ")]
    [InlineData("Some-Agent.Feature::Chat")]
    [InlineData("")]
    [InlineData("   ")]
    public void 归一化两侧一致(string value)
        => Assert.Equal(
            GatewayAppCallerIdentity.NormalizePart(value),
            AppCallerIdentityPolicy.NormalizePart(value));

    /// <summary>
    /// 认领列表的去重按身份走，不按字节：同一份列表里的 Foo 与 foo 是同一个调用方，
    /// 留成两条的话库里一个身份占两个数组位，唯一索引与位移账本都要为此各写一遍特例。
    /// </summary>
    [Fact]
    public void 认领列表去重不分大小写()
    {
        var normalized = AppCallerIdentityPolicy.NormalizeClaims(
            ["Some-Agent.Feature::Chat", " some-agent.feature::chat ", "", "   ", "other-agent.x::chat"]);

        Assert.Equal(2, normalized.Count);
        // 保留的是**第一个**出现的写法，不是把大小写抹平——权威侧的 NormalizePart 只去空白，
        // 抹平会让控制台存进去的值与用户填的不一样，那是另一种惊讶。
        Assert.Equal("Some-Agent.Feature::Chat", normalized[0]);
        Assert.Equal("other-agent.x::chat", normalized[1]);
    }
}
