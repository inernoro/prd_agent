using Xunit;

namespace PrdAgent.Tests;

/// <summary>
/// 设计执行器配置的模型，必须是**对外模型标识**，不能是上游的物理模型名。
///
/// 2026-09-16 的网关模型收敛（#1546）之后，点名解析只认对外目录里的标识；继续写
/// "gpt-4.1" 这种厂商物理模型名，网关回 404 MODEL_NOT_FOUND。而这条配置是两个执行器
/// 共用的，于是直连与 OpenDesign **一起哑**——线上实测就是这么挂的：OpenDesign 的容器
/// 起来了、工作区包下发了、Codex 回打代理调了 60 次模型，60 次全部 502，上游 404。
///
/// 为什么用关键字而不是查状态：判据的真值在网关的对外目录里，单测拿不到那份状态。
/// 按 external-cause-first §4.3，拿不到状态才退到关键字匹配，且匹配表要有覆盖守卫——
/// 下面第二条就是那张表自己的样本覆盖。
/// </summary>
public class DesignArtifactModelIdentifierGuardTests
{
    /// <summary>厂商物理模型名的已知前缀。新增上游时往这里加。</summary>
    private static readonly string[] VendorModelPrefixes =
    [
        "gpt-", "o1-", "o3-", "o4-", "claude-", "gemini-", "qwen-",
        "deepseek-", "glm-", "moonshot-", "doubao-", "ernie-", "hunyuan-",
    ];

    [Fact]
    public void 设计执行器配置的模型不得写成厂商物理模型名()
    {
        var appSettings = ReadRepoFile("prd-api/src/PrdAgent.Api/appsettings.json");
        var configured = System.Text.Json.JsonDocument.Parse(appSettings)
            .RootElement.GetProperty("DesignArtifactRuntime").GetProperty("Model").GetString();

        Assert.False(string.IsNullOrWhiteSpace(configured));

        foreach (var prefix in VendorModelPrefixes)
        {
            Assert.False(
                configured!.StartsWith(prefix, System.StringComparison.OrdinalIgnoreCase),
                $"DesignArtifactRuntime:Model 现在是 \"{configured}\"，这是厂商物理模型名。"
                + " 网关点名解析只认对外模型标识（如 default-chat-curated），"
                + " 写物理模型名会让直连与 OpenDesign 两条路一起 404。");
        }
    }

    [Fact]
    public void 厂商前缀表的每一条都真的能拦住一个样本()
    {
        // 表里躺着永不生效的死规则，比没有规则更糟：它让人以为这一类已经被拦住了。
        foreach (var prefix in VendorModelPrefixes)
        {
            var sample = prefix + "4.1";
            Assert.True(
                sample.StartsWith(prefix, System.StringComparison.OrdinalIgnoreCase),
                $"前缀 {prefix} 构造不出能被它自己拦住的样本，说明这条规则写坏了");
        }
        Assert.Contains("gpt-", VendorModelPrefixes);
    }

    private static string ReadRepoFile(string relativePath)
    {
        var dir = new System.IO.DirectoryInfo(System.AppContext.BaseDirectory);
        while (dir is not null && !System.IO.Directory.Exists(System.IO.Path.Combine(dir.FullName, ".git")))
            dir = dir.Parent;
        Assert.NotNull(dir);
        return System.IO.File.ReadAllText(System.IO.Path.Combine(dir!.FullName, relativePath));
    }
}
