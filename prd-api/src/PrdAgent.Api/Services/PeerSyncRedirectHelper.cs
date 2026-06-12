using System.Net;

namespace PrdAgent.Api.Services;

public static class PeerSyncRedirectHelper
{
    public static bool IsRedirect(HttpStatusCode statusCode) =>
        statusCode is HttpStatusCode.MovedPermanently
            or HttpStatusCode.Found
            or HttpStatusCode.TemporaryRedirect
            or HttpStatusCode.PermanentRedirect;

    public static bool TryBuildSameHostHttpsRedirect(
        Uri originalRequest,
        Uri? location,
        string expectedPathSuffix,
        out string canonicalBaseUrl,
        out string redirectedUrl,
        out string reason)
    {
        canonicalBaseUrl = string.Empty;
        redirectedUrl = string.Empty;
        reason = string.Empty;

        if (location == null)
        {
            reason = "对端返回重定向但没有 Location";
            return false;
        }

        var target = location.IsAbsoluteUri ? location : new Uri(originalRequest, location);
        if (!string.Equals(originalRequest.Scheme, Uri.UriSchemeHttp, StringComparison.OrdinalIgnoreCase)
            || !string.Equals(target.Scheme, Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase))
        {
            reason = "只允许 http 到 https 的规范化重定向";
            return false;
        }

        if (!string.Equals(originalRequest.Host, target.Host, StringComparison.OrdinalIgnoreCase))
        {
            reason = "不允许跨 host 重定向";
            return false;
        }

        if (!string.IsNullOrEmpty(target.Query) || !string.IsNullOrEmpty(target.Fragment))
        {
            reason = "不允许重定向携带 query 或 fragment";
            return false;
        }

        if (!target.AbsolutePath.EndsWith(expectedPathSuffix, StringComparison.Ordinal))
        {
            reason = "重定向路径不是 peer-sync 端点";
            return false;
        }

        var basePath = target.AbsolutePath[..^expectedPathSuffix.Length].TrimEnd('/');
        canonicalBaseUrl = $"{target.GetLeftPart(UriPartial.Authority)}{basePath}".TrimEnd('/');
        redirectedUrl = target.GetLeftPart(UriPartial.Path);
        return true;
    }
}
