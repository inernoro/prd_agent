using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace PrdAgent.Core.Helpers;

public static class ProductVersionClaimPolicy
{
    public static bool CanUseReview(string applicantId, string submitterId, bool claimTest) =>
        claimTest || string.Equals(applicantId, submitterId, StringComparison.Ordinal);

    public static string ReviewKey(string submissionId) => "review:" + submissionId.Trim();

    // 老登记与产品页共用应用名称维度，手填和选择 T 使用同一占用键。
    public static string ReleaseKey(string applicationName, string tCode)
    {
        if (string.IsNullOrWhiteSpace(applicationName) || string.IsNullOrWhiteSpace(tCode))
            throw new ArgumentException("申领正式版本必须指定应用和 T 号");
        var values = new[] { applicationName.Trim().Normalize().ToUpperInvariant(), tCode.Trim().ToUpperInvariant() };
        return "release:" + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(values))));
    }
}
