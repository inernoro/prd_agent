using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using Xunit;

namespace PrdAgent.Tests;

public class WebPageAskEvidenceTests
{
    [Fact]
    public void Prompt_PreservesLiteralIdentifiers_WhenTheyResemblePlaceholders()
    {
        const string marker = "stsmk-owned-share-正文标记";
        var snapshot = new SiteContentSnapshot { Text = marker };
        var prompt = WebPageAskPrompt.Build(new HostedSite { Title = "验收页面" }, snapshot);
        Assert.Contains(marker, prompt);
        Assert.Contains("逐字保留完整值，包括字母、数字和前后缀", prompt);
        Assert.Contains("不能因其看起来像测试值或占位文字而忽略已有内容", prompt);
    }

    [Fact]
    public void 脚注使用原文并按首次引用排序重复引用共用编号()
    {
        var evidence = new WebPageAskEvidence("# 套餐\n团队版99元/月\n\n# 退款\n已开票订单不支持退款。");
        var result = evidence.CompleteAnswer("已开票不能退款。[引用:2] 团队版99元/月。[引用:1] 不能退款。[引用:2]");
        Assert.StartsWith("已开票不能退款。[^1] 团队版99元/月。[^2] 不能退款。[^1]", result);
        Assert.Contains("[^1]: \\# 退款\n    已开票订单不支持退款。", result);
        Assert.Contains("[^2]: \\# 套餐\n    团队版99元/月", result);
        Assert.DoesNotContain("[^3]", result);
    }

    [Fact]
    public void 不允许模型伪造脚注内容或不存在的片段()
    {
        var evidence = new WebPageAskEvidence("仅未开票订单可申请退款。");
        var result = evidence.CompleteAnswer("可以申请。[引用:1] 所有订单均可。[引用:999][引用:-1][引用:错误]\n\n[^1]: 无条件退款。");
        Assert.Contains("\\[^1]: 无条件退款。", result);
        Assert.Contains("\n[^1]: 仅未开票订单可申请退款。", result);
        Assert.DoesNotContain("[引用:", result);
        Assert.Contains("已移除无效编号", result);
    }

    [Fact]
    public void 原文中的Markdown及伪造引用只能显示为文本()
    {
        var evidence = new WebPageAskEvidence("[外链](javascript:alert(1)) <script>bad</script> [^9]: 假引用 &lt;原样&gt;");
        var result = evidence.CompleteAnswer("页面有这段文本。[引用:1]");
        Assert.Contains(@"\[外链\]\(javascript:alert\(1\)\)", result);
        Assert.Contains(@"\<script\>bad\</script\>", result);
        Assert.Contains(@"\[^9\]: 假引用", result);
        Assert.Contains("&amp;lt;原样&amp;gt;", result);
    }

    [Fact]
    public void 缺少引用时明确提示而不强行匹配一个来源()
    {
        var result = new WebPageAskEvidence("实际原文").CompleteAnswer("页面没有提到。");
        Assert.Contains("未提供可核对的原文引用", result);
        Assert.DoesNotContain("[^1]", result);
    }

    [Fact]
    public void 长段落分片保留全文而且不会截断代理对()
    {
        var text = new string('文', 799) + char.ConvertFromUtf32(0x20000) + new string('字', 900);
        var evidence = new WebPageAskEvidence(text);
        Assert.Equal(text, string.Concat(evidence.Excerpts));
        Assert.All(evidence.Excerpts, s => Assert.InRange(s.Length, 1, 800));
        Assert.All(evidence.Excerpts, s => Assert.False(char.IsHighSurrogate(s[^1])));
    }

    [Fact]
    public void 提示词只包含本次提供的片段及其编号()
    {
        var snapshot = new SiteContentSnapshot { Text = "第一段\n\n第二段", Truncated = true };
        var evidence = new WebPageAskEvidence(snapshot.Text);
        var prompt = WebPageAskPrompt.Build(new HostedSite { Title = "测试页" }, snapshot, evidence);
        Assert.Contains("【原文片段 1】\n第一段", prompt);
        Assert.Contains("【原文片段 2】\n第二段", prompt);
        Assert.Contains("只读取到部分原文", prompt);
    }
}
