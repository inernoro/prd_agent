using PrdAgent.Api.Services.DefectAgent;
using PrdAgent.Core.Models;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public class DefectImageRunDiagnosticsTests
{
    private const string RunId = "307c7a1392ea4b0495bab004756602d7";

    [Fact]
    public void CapturesOnlyServerLogRequestHeadersNotBodyInjectedIds()
    {
        var header = $"=== [2026-10-10 05:33:08] GET /api/literary-agent/image-gen/runs/{RunId}/stream | HTTP 200 | 4573ms ===";
        var injected = $"Request Body: /api/literary-agent/image-gen/runs/{new string('a', 32)}/stream";
        Assert.Equal(new[] { RunId }, DefectImageRunDiagnostics.ExtractRunIds(header + "\n" + injected + "\n" + header));
    }

    [Fact]
    public void ReporterOwnershipAndCapturedReferenceAreBothRequired()
    {
        var defect = new DefectReport { ReporterId = "reporter" };
        var run = new ImageGenRun { Id = RunId, OwnerAdminId = "reporter", AppKey = "literary-agent" };
        Assert.True(DefectImageRunDiagnostics.CanExpose(run, defect, new[] { RunId }));
        Assert.False(DefectImageRunDiagnostics.CanExpose(run, defect, Array.Empty<string>()));
        run.OwnerAdminId = "other-user";
        Assert.False(DefectImageRunDiagnostics.CanExpose(run, defect, new[] { RunId }));
    }

    [Fact]
    public void UserAttachmentAndNonDiagnosticAssetCannotBeRead()
    {
        var attachment = new DefectAttachment { Type = DefectAttachmentType.LogRequest, Url = "https://assets.test/data/defect-agent/log/test123.txt" };
        Assert.Null(DefectImageRunDiagnostics.AttachmentKey(attachment));
        attachment.IsSystemGenerated = true;
        Assert.Equal("data/defect-agent/log/test123.txt", DefectImageRunDiagnostics.AttachmentKey(attachment));
        attachment.Url = "https://assets.test/data/other/log/test123.txt";
        Assert.Null(DefectImageRunDiagnostics.AttachmentKey(attachment));
    }
}
