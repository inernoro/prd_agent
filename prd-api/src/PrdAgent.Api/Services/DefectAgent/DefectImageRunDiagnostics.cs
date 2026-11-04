using System.Text.RegularExpressions;
using PrdAgent.Core.Models;

namespace PrdAgent.Api.Services.DefectAgent;

/// <summary>从服务端采集的请求日志提取有限关联，不接受智能体传任意任务 ID 或下载 URL。</summary>
public static class DefectImageRunDiagnostics
{
    public static string[] ExtractRunIds(string requestLog)
        => Regex.Matches(requestLog, @"(?m)^=== \[[^\r\n]+\] GET /api/(?:literary-agent/image-gen|visual-agent/image-gen)/runs/([a-f0-9]{32})(?:/stream)? \| HTTP \d+ \|")
            .Select(x => x.Groups[1].Value).Distinct(StringComparer.Ordinal).Take(20).ToArray();

    public static string? AttachmentKey(DefectAttachment attachment)
    {
        if (!attachment.IsSystemGenerated || attachment.Type != DefectAttachmentType.LogRequest
            || attachment.FileSize > 1024 * 1024 || !Uri.TryCreate(attachment.Url, UriKind.Absolute, out var uri)) return null;
        var key = uri.AbsolutePath.TrimStart('/');
        return Regex.IsMatch(key, @"^data/defect-agent/log/[a-z0-9]+\.txt$") ? key : null;
    }

    public static bool CanExpose(ImageGenRun run, DefectReport defect, IReadOnlyCollection<string> capturedRunIds)
        => run.OwnerAdminId == defect.ReporterId && capturedRunIds.Contains(run.Id)
            && run.AppKey is "literary-agent" or "visual-agent";
}
