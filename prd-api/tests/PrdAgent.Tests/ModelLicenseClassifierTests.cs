using PrdAgent.Api.Services.ModelLeaderboard;
using Xunit;

namespace PrdAgent.Tests;

/// <summary>
/// 授权归类的守卫。
///
/// 要防的事故：页面上那个「仅开源」筛选，本页教程里是**推荐给想自部署的人**的。
/// 原判据是「除了 Proprietary 都算开源」，于是非商用、仅研究、各家 community 许可
/// 全挂上了绿色徽章——在用户会照着做决定的地方给错信息（Codex 在 PR #1538 指出）。
///
/// 下面的取值**不是编出来的**：是 2026-09-14 从 arena.ai 四个榜的存档页里把授权段
/// 全量抽出来去重得到的 42 种写法（外加一个空值），每一种都在这里钉住它该落哪一类。
/// 这既是行为断言，也是「匹配表能不能盖住已知的全部历史取值」的数据覆盖守卫
/// （external-cause-first 第四节）。
/// </summary>
public sealed class ModelLicenseClassifierTests
{
    // ---- 真开源：能认出来的标准许可 --------------------------------------

    [Theory]
    [InlineData("MIT")]
    [InlineData("Apache 2.0")]
    [InlineData("Apache-2.0")]
    [InlineData("apache 2.0")]
    public void 标准开源许可判 open(string license)
        => Assert.Equal(LicenseKind.Open, ModelLicenseClassifier.Classify(license));

    // ---- 带限制：闭源 / 非商用 / 仅研究 / community ------------------------

    [Theory]
    [InlineData("Proprietary")]                              // 线上 646 行，最大的一类
    [InlineData("CC-BY-NC-4.0")]                             // NC = NonCommercial
    [InlineData("flux-non-commercial-license")]
    [InlineData("flux-1-dev-non-commercial-license")]
    [InlineData("Non-commercial")]
    [InlineData("Mistral Research")]                         // 仅研究
    [InlineData("Llama 2 Community")]
    [InlineData("Llama 3 Community")]
    [InlineData("Llama 3.1 Community")]
    [InlineData("MiniMax Community License")]
    [InlineData("minimax-h3-community-license-agreement")]
    [InlineData("tencent-hunyuan-community")]
    [InlineData("krea-2-community-license")]
    [InlineData("Qwen-community-1.0")]
    [InlineData("qwen-community-1.0")]
    public void 带使用限制的许可判 restricted(string license)
        => Assert.Equal(LicenseKind.Restricted, ModelLicenseClassifier.Classify(license));

    // ---- 认不出来：各家自造的，条款没逐个读过就不敢说开源 ------------------

    [Theory]
    [InlineData("Modified MIT")]        // 改过的 MIT，改了什么不知道
    [InlineData("Qianwen LICENSE")]
    [InlineData("Gemma license")]
    [InlineData("Gemma")]
    [InlineData("Qwen")]
    [InlineData("Llama")]
    [InlineData("Llama 3.1")]
    [InlineData("Llama 3.2")]
    [InlineData("Llama 4")]
    [InlineData("Llama-3.3")]
    [InlineData("Kimi K3 license")]     // Codex 点名的那个
    [InlineData("DeepSeek")]
    [InlineData("DeepSeek License")]
    [InlineData("MRL")]
    [InlineData("OpenMDW-1.1")]
    [InlineData("NVIDIA Open Model")]
    [InlineData("Nvidia Open Model")]
    [InlineData("Nvidia Open")]
    [InlineData("Nvidia")]
    [InlineData("Ideogram Open Model")]
    [InlineData("Open")]                // 名字里有 Open 不等于开源
    public void 各家自造的许可判 unknown(string license)
        => Assert.Equal(LicenseKind.Unknown, ModelLicenseClassifier.Classify(license));

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    public void 没有授权段判 unknown 而不是 open(string? license)
    {
        // 这条单独立一个用例：把「读不出来」默认成「开源」正是原判据最贵的那个错误
        Assert.Equal(LicenseKind.Unknown, ModelLicenseClassifier.Classify(license));
    }

    // ---- 判据本身的形状 --------------------------------------------------

    [Fact]
    public void 限制标记优先于开源家族()
    {
        // 两边的词都在时，限制必须赢。判据顺序反过来这条就红。
        Assert.Equal(
            LicenseKind.Restricted,
            ModelLicenseClassifier.Classify("Apache 2.0 with Commons Clause (non-commercial)"));
    }

    [Fact]
    public void 开源家族按前缀加分隔符匹配_不是子串()
    {
        // 子串匹配会被 permit / transmit 这类词命中，而一次误判就是一个错的绿徽章
        Assert.Equal(LicenseKind.Unknown, ModelLicenseClassifier.Classify("Transmit-Only License"));
        Assert.Equal(LicenseKind.Unknown, ModelLicenseClassifier.Classify("Permitted Use Only"));
        Assert.Equal(LicenseKind.Open, ModelLicenseClassifier.Classify("MIT-0"));
    }

    [Fact]
    public void 归类只有三种取值()
    {
        // 前端按这三个值分支；多出第四种会让它悄悄落到 else 分支
        string[] samples =
        [
            "MIT", "Proprietary", "Kimi K3 license", "", "Llama 2 Community", "Apache-2.0",
        ];
        Assert.All(samples, s => Assert.Contains(
            ModelLicenseClassifier.Classify(s),
            new[] { LicenseKind.Open, LicenseKind.Restricted, LicenseKind.Unknown }));
    }
}
