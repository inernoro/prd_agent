using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace PrdAgent.Api.Services.ProductAgent;

public static class ProductClaimWebhookPayload
{
    public static bool IsValidWebhook(string? url) => Uri.TryCreate(url, UriKind.Absolute, out var uri)
        && uri.Scheme == Uri.UriSchemeHttps && uri.Host.Equals("qyapi.weixin.qq.com", StringComparison.OrdinalIgnoreCase)
        && uri.Port == 443 && uri.UserInfo.Length == 0 && uri.Fragment.Length == 0
        && uri.AbsolutePath == "/cgi-bin/webhook/send" && Regex.IsMatch(uri.Query, @"\A\?key=[A-Za-z0-9-]+\z");

    public static string Build(string content, ProductMentionTarget? target)
    {
        content = Regex.Replace(content, @"<@[^>]*>", string.Empty);
        if (Encoding.UTF8.GetByteCount(content) > 2048) throw new InvalidOperationException("通知超过企微长度限制，请精简后重试通知");
        if (target == null)
            return JsonSerializer.Serialize(new { msgtype = "text", text = new { content } });
        if (target.Kind == "userid" && ProductClaimMentionIdentity.ValidUserId(target.Value))
            return JsonSerializer.Serialize(new { msgtype = "text", text = new { content, mentioned_list = new[] { target.Value } } });
        if (target.Kind == "mobile" && ProductClaimMentionIdentity.ValidMobile(target.Value))
            return JsonSerializer.Serialize(new { msgtype = "text", text = new { content, mentioned_mobile_list = new[] { target.Value } } });
        throw new InvalidOperationException("负责人企微身份无效，不能发送定向提醒");
    }
}
