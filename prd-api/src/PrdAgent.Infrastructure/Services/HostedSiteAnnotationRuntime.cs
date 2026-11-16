using System.Text.RegularExpressions;

namespace PrdAgent.Infrastructure.Services;

/// <summary>站内预览与托管直链共用的批注运行时；严格声明式产物不参与脚本注入。</summary>
public static class HostedSiteAnnotationRuntime
{
    private static readonly Lazy<string> Runtime = new(() =>
    {
        using var stream = typeof(HostedSiteAnnotationRuntime).Assembly.GetManifestResourceStream("PrdAgent.HostedAnnotations.js")
            ?? throw new InvalidOperationException("网页批注运行时资源缺失");
        using var reader = new StreamReader(stream);
        return reader.ReadToEnd();
    });

    private static readonly Regex ExistingRuntime = new(
        @"<script\b[^>]*\bdata-map-annotations\s*=\s*([""'])[^""']*\1[^>]*>[\s\S]*?</script\s*>",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

    public static string Script => Runtime.Value;

    public static string Strip(string html) => ExistingRuntime.Replace(html, string.Empty);

    public static string Inject(string html)
    {
        html = Strip(html);
        var script = "<script data-map-annotations=\"v1\">" + Script + "</script>";
        var body = html.LastIndexOf("</body>", StringComparison.OrdinalIgnoreCase);
        var end = body >= 0 ? body : html.LastIndexOf("</html>", StringComparison.OrdinalIgnoreCase);
        return end >= 0 ? html.Insert(end, script) : html + script;
    }
}
