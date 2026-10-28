using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.DataProtection;
using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Services.ProductAgent;

public sealed record ProductMentionTarget(string Kind, string Value);

/// <summary>复用选中MAP账号的已验证企微身份，不按显示姓名、提交人或项目成员猜测。</summary>
public static class ProductClaimMentionIdentity
{
    private const string Purpose = "ProductAgent.ClaimMentionIdentity.v1";
    private sealed record BoundIdentity(string BindingHash, string? WeComUserId, string? Mobile);
    public static bool ValidUserId(string? value) => !string.IsNullOrWhiteSpace(value) && value.Length <= 64
        && Regex.IsMatch(value, @"\A[A-Za-z0-9_.@-]+\z") && !value.Equals("@all", StringComparison.OrdinalIgnoreCase);
    public static bool ValidMobile(string? value) => value != null && Regex.IsMatch(value, @"\A1[3-9]\d{9}\z");

    public static string? Protect(User user, string? weComUserId, string? mobile, IDataProtectionProvider protection)
    {
        if (string.IsNullOrWhiteSpace(user.MiduoSsoSubjectHash)) return null;
        var id = ValidUserId(weComUserId) ? weComUserId!.Trim() : null;
        var phone = ValidMobile(mobile) ? mobile : null;
        if (id == null && phone == null) return null;
        return protection.CreateProtector(Purpose, user.UserId).Protect(JsonSerializer.Serialize(new BoundIdentity(user.MiduoSsoSubjectHash, id, phone)));
    }

    public static ProductMentionTarget? Resolve(User? user, IDataProtectionProvider protection)
    {
        if (user == null || user.Status != UserStatus.Active || user.UserType != UserType.Human) return null;
        if (!string.IsNullOrEmpty(user.NotificationIdentityProtected))
        {
            try
            {
                var bound = JsonSerializer.Deserialize<BoundIdentity>(protection.CreateProtector(Purpose, user.UserId).Unprotect(user.NotificationIdentityProtected));
                if (bound?.BindingHash == user.MiduoSsoSubjectHash)
                {
                    if (ValidUserId(bound.WeComUserId)) return new("userid", bound.WeComUserId!);
                    if (ValidMobile(bound.Mobile)) return new("mobile", bound.Mobile!);
                }
            }
            catch (Exception ex) when (ex is System.Security.Cryptography.CryptographicException or JsonException) { }
        }
        // 少量旧企微userid未被截断时可直接复用；带掩码的值绝不拿来提醒。
        if (user.MiduoSsoSubjectType == "wework_userid" && ValidUserId(user.MiduoSsoSubjectMasked))
            return new("userid", user.MiduoSsoSubjectMasked!);
        return null;
    }

    public static async Task RememberAsync(MongoDbContext db, User user, string? weComUserId, string? mobile, IDataProtectionProvider protection)
    {
        var value = Protect(user, weComUserId, mobile, protection);
        if (value == null) return;
        await db.Users.UpdateOneAsync(x => x.UserId == user.UserId && x.MiduoSsoSubjectHash == user.MiduoSsoSubjectHash,
            Builders<User>.Update.Set(x => x.NotificationIdentityProtected, value), cancellationToken: CancellationToken.None);
    }
}
