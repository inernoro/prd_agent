using Microsoft.AspNetCore.StaticFiles;
using Microsoft.Extensions.FileProviders;

namespace PrdAgent.Api.Services;

/// <summary>
/// 本地资产通过管理后台同源访问时的静态文件安全策略。
/// 托管网页等主动内容允许执行自身脚本，但必须保持不透明来源，不能读取管理后台凭据。
/// </summary>
public static class LocalAssetStaticFilePolicy
{
    public const string ContentSecurityPolicy =
        "sandbox allow-scripts allow-forms allow-modals allow-popups allow-downloads";

    public static StaticFileOptions CreateOptions(string localAssetDir)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(localAssetDir);

        return new StaticFileOptions
        {
            FileProvider = new PhysicalFileProvider(localAssetDir),
            RequestPath = "/local-assets",
            ServeUnknownFileTypes = true,
            DefaultContentType = "application/octet-stream",
            OnPrepareResponse = context => ApplyResponseHeaders(context.Context.Response),
        };
    }

    private static void ApplyResponseHeaders(HttpResponse response)
    {
        // 关键约束：不得加入 allow-same-origin。否则用户可控 HTML 会重新获得
        // 管理后台来源，并能读取 localStorage 中的认证令牌。
        response.Headers.ContentSecurityPolicy = ContentSecurityPolicy;
        response.Headers.XContentTypeOptions = "nosniff";
        response.Headers["Referrer-Policy"] = "no-referrer";
    }
}
