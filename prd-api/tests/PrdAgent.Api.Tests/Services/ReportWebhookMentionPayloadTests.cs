using System.Text.Json;
using PrdAgent.Api.Services.ReportAgent;
using PrdAgent.Core.Models;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

/// <summary>
/// 周报评论 @ 提醒的群推送 payload 守卫。
///
/// 企微群机器人只有 markdown 里出现 &lt;@userid&gt; 才会真的 @ 亮那个人，而这个 userid 来自
/// 团队成员身份映射的 wecom 项——没配就只能发 @显示名 纯文本。钉钉/飞书不认这个语法，
/// 所以它绝不能泄漏到那两个渠道的 body 里（会显示成一段乱码般的原文）。
/// </summary>
public class ReportWebhookMentionPayloadTests
{
    private const string Title = "周报评论提醒";
    private const string Body = "**余瑞鹏** 在 **杨锐聪** 的周报「问题&对策」中提到了 @杨锐聪\n> 引用：很多临时插入的事项\n评论：@杨锐聪 关注";

    private static string WeComContent(string payload)
        => JsonDocument.Parse(payload).RootElement.GetProperty("markdown").GetProperty("content").GetString()!;

    [Fact]
    public void WeCom_WithMappedUserIds_EmbedsRealMentionSyntax()
    {
        var payload = ReportWebhookService.BuildPayload(
            WebhookChannel.WeCom, Title, Body, "https://example.com/report-agent/report/r1?comment=c1",
            new[] { "yangruicong" });

        var content = WeComContent(payload);
        Assert.Contains("<@yangruicong>", content);
        // 引用原文与评论内容必须原样带进群消息
        Assert.Contains("引用：很多临时插入的事项", content);
        Assert.Contains("评论：@杨锐聪 关注", content);
        Assert.Contains("查看详情", content);
    }

    [Fact]
    public void WeCom_WithoutMapping_FallsBackToPlainText()
    {
        var payload = ReportWebhookService.BuildPayload(
            WebhookChannel.WeCom, Title, Body, null, Array.Empty<string>());

        var content = WeComContent(payload);
        Assert.DoesNotContain("<@", content);
        // 退化路径仍要看得出 @ 了谁
        Assert.Contains("@杨锐聪", content);
    }

    [Fact]
    public void WeCom_NullMentionList_DoesNotEmitSuffix()
    {
        var payload = ReportWebhookService.BuildPayload(WebhookChannel.WeCom, Title, Body, null);
        Assert.DoesNotContain("<@", WeComContent(payload));
    }

    [Fact]
    public void WeCom_BlankAndDuplicateIds_AreCleanedUp()
    {
        var suffix = ReportWebhookService.BuildWeComMentionSuffix(
            new[] { " yangruicong ", "yangruicong", "  ", "yuruipeng" });

        Assert.Equal("\n<@yangruicong> <@yuruipeng>", suffix);
    }

    [Theory]
    [InlineData(WebhookChannel.DingTalk)]
    [InlineData(WebhookChannel.Feishu)]
    [InlineData(WebhookChannel.Custom)]
    public void OtherChannels_NeverLeakWeComMentionSyntax(string channel)
    {
        var payload = ReportWebhookService.BuildPayload(
            channel, Title, Body, "https://example.com/report-agent", new[] { "yangruicong" });

        // 断言 userid 本身而不是 "<@userid>"：System.Text.Json 默认把 < 转义成 \u003C，
        // 按尖括号原文断言的话，真泄漏了也不会红（转义后的形态匹配不上）。
        // 字母数字不受转义影响，所以 userid 是这里唯一可靠的判据。
        Assert.DoesNotContain("yangruicong", payload);
    }

    [Fact]
    public void WeCom_MentionSyntaxSurvivesJsonEscaping()
    {
        // 同一条守卫的正面：企微渠道下，userid 必须真的进了 payload（不管序列化成 <@id> 还是 \u003C@id\u003E）
        var payload = ReportWebhookService.BuildPayload(
            WebhookChannel.WeCom, Title, Body, null, new[] { "yangruicong" });

        Assert.Contains("yangruicong", payload);
        Assert.Contains("<@yangruicong>", WeComContent(payload));
    }
}
