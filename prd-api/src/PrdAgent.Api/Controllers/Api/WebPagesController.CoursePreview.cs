using System.Text.Json;
using PrdAgent.Core.Models;

namespace PrdAgent.Api.Controllers.Api;

public partial class WebPagesController
{
    private const string CoursePath = "review/course.json";
    private const long MaxDirectoryBytes = 4L * 1024 * 1024;

    private async Task<string> WithCourseDirectoryAsync(HostedSite site, string html, CancellationToken ct)
    {
        // The course package uses a classic script with a relative course.json fetch. In srcdoc
        // that fetch has an opaque origin even after the preview has resolved the base URL.
        var storage = _reviewStorage;
        if (storage == null || site.Files is not { } files
            || !files.Exists(file => file.Path == "downloads/tutorial-package.json"))
            return html;

        var head = html.IndexOf("<head>", StringComparison.OrdinalIgnoreCase);
        if (head < 0 || !html.Contains("<script src=\"app.js\"></script>", StringComparison.Ordinal))
            return html;
        if (site.EntryFile != "review/index.html" && (site.EntryFile != "index.html"
            || !html.Contains("<base href=\"review/\">", StringComparison.Ordinal)))
            return html;

        var entry = files.Find(file => file.Path == site.EntryFile);
        var directory = files.Find(file => file.Path == CoursePath);
        if (entry == null || directory == null || directory.Size is <= 0 or > MaxDirectoryBytes)
            return html;

        const string scopeMarker = "__course_directory_scope__";
        var scope = storage.BuildSiteKey(site.Id, scopeMarker)[..^scopeMarker.Length];
        // Resolve the exact object from the same site's same publication. Legacy unversioned
        // course archives also use the same entry and directory prefix.
        if (!entry.CosKey.StartsWith(scope, StringComparison.Ordinal)
            || !entry.CosKey.EndsWith(site.EntryFile, StringComparison.Ordinal)
            || directory.CosKey != entry.CosKey[..^site.EntryFile.Length] + CoursePath)
            return html;

        if (!await LargeSiteHtmlReads.WaitAsync(LargeSiteHtmlWait, ct))
            return html;
        try
        {
            var bytes = await storage.TryDownloadBytesAsync(directory.CosKey, ct);
            if (bytes == null || bytes.LongLength != directory.Size)
                return html;
            using var json = JsonDocument.Parse(bytes);
            var root = json.RootElement;
            if (root.ValueKind != JsonValueKind.Object
                || !root.TryGetProperty("chapters", out var chapters) || chapters.ValueKind != JsonValueKind.Array
                || !root.TryGetProperty("lessons", out var lessons) || lessons.ValueKind != JsonValueKind.Array)
                return html;

            // Base64 keeps uploaded text out of the script grammar, including closing script tags.
            var data = Convert.ToBase64String(bytes);
            var bootstrap = $$"""
                <script data-map-course-directory>
                (() => {
                  if (location.href !== 'about:srcdoc' && !location.href.startsWith('about:srcdoc#')) return;
                  const originalFetch = window.fetch;
                  window.fetch = function (input, options) {
                    if (input !== 'course.json' || options?.cache !== 'no-store' || Object.keys(options).length !== 1)
                      return originalFetch.apply(this, arguments);
                    const directory = Uint8Array.from(atob('{{data}}'), character => character.charCodeAt(0));
                    return Promise.resolve(new Response(directory, { headers: { 'Content-Type': 'application/json' } }));
                  };
                })();
                </script>
                """;
            return html.Insert(head + "<head>".Length, bootstrap);
        }
        catch (Exception ex) when (ex is JsonException or HttpRequestException or IOException or OperationCanceledException)
        {
            // The directory is optional for other views of the uploaded HTML. Leave it unchanged
            // if the course data cannot be read from storage.
            return html;
        }
        finally
        {
            LargeSiteHtmlReads.Release();
        }
    }
}
