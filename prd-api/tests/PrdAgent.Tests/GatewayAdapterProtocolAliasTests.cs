using System.IO;
using PrdAgent.Core.LlmGateway;
using PrdAgent.Infrastructure.LlmGateway;
using Xunit;

namespace PrdAgent.Tests;

public class GatewayAdapterProtocolAliasTests
{
    /// <summary>库里出现过的全部协议写法，与它们该落到的适配器。</summary>
    public static readonly (string Protocol, string? AdapterKey)[] KnownProtocols =
    [
        ("claude", "claude"),
        ("anthropic", "claude"),
        ("claude-compatible", "claude"),
        ("openai", "openai"),
        ("openai-compatible", "openai"),
        ("openrouter", "openai"),
        ("gemini-compatible", "openai"),
        ("unknown", null),
        ("", null),
    ];

    public static TheoryData<string, string?> ProtocolCases()
    {
        var data = new TheoryData<string, string?>();
        foreach (var (protocol, adapterKey) in KnownProtocols) data.Add(protocol, adapterKey);
        return data;
    }

    [Theory]
    [MemberData(nameof(ProtocolCases))]
    public void NormalizeAdapterKey_ShouldMapProtocolAliasesToRegisteredAdapters(string protocol, string? expected)
    {
        Assert.Equal(expected, LlmGateway.NormalizeAdapterKey(protocol));
        // 网关那一侧只是转调，别名表本体在 Core：两处给出的结论必须逐字相同。
        Assert.Equal(expected, GatewayProtocolAliases.NormalizeAdapterKey(protocol));
    }

    /// <summary>
    /// 「用哪个适配器发」与「按哪套口径算账」必须由**同一张**别名表决定。
    ///
    /// 2026-09-17 的缺陷正是这两张表差了一个写法：`claude-compatible` 选中 Claude 适配器
    /// （它把 cache_read_input_tokens 与 input_tokens 分三个数报），而计价那一侧只认
    /// `anthropic` / `claude`，于是按 OpenAI 口径把缓存读从输入里减了一遍——
    /// 成本报低、预算闸跟着松，编译过、不报错，只在对账时显形。
    ///
    /// 这条守卫逐个协议对照两个函数：任何一个写法在两边给出不一致的归属就红。
    /// 新增别名时只要漏了一边，这里立刻变红。
    /// </summary>
    [Theory]
    [MemberData(nameof(ProtocolCases))]
    public void 计价的用量口径与适配器选择必须由同一张别名表决定(string protocol, string? adapterKey)
    {
        var isClaudeAdapter = string.Equals(adapterKey, "claude", StringComparison.Ordinal);

        // Claude 协议：三个数分开报，缓存读**不在** input 里。
        // 其余（含认不出来而按 OpenAI 兼容兜底的）：缓存读含在 prompt_tokens 里。
        Assert.Equal(!isClaudeAdapter, GatewayCostCalculator.CacheReadCountedInsideInput(protocol));
        Assert.Equal(isClaudeAdapter, GatewayProtocolAliases.IsClaudeProtocol(protocol));
    }

    /// <summary>
    /// 计价那一侧不许自己再列一遍别名——列了就是第二张表，而两张表迟早差一个写法。
    /// </summary>
    [Fact]
    public void 计价不许自己维护一份协议别名表()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null
               && !Directory.Exists(Path.Combine(dir.FullName, ".git"))
               && !File.Exists(Path.Combine(dir.FullName, ".git")))
        {
            dir = dir.Parent;
        }
        Assert.NotNull(dir);
        var calculator = File.ReadAllText(Path.Combine(
            dir!.FullName,
            "prd-api/src/PrdAgent.Core/LlmGateway/GatewayCostCalculator.cs".Replace('/', Path.DirectorySeparatorChar)));

        Assert.Contains("GatewayProtocolAliases.IsClaudeProtocol(protocol)", calculator);
        // 判据里不许再出现具体的协议写法（注释里说明缘由的那几处除外——它们不在判据上）。
        Assert.DoesNotContain("normalized is not (", calculator);
    }
}
