using System.Security.Cryptography;
using System.Text;
using PrdAgent.Api.Services;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public sealed class DesignArtifactBrowserQualityTests
{
    [Fact]
    public void ParseBrowserQualitySummary_ProjectsOnlyBoundedMetricsAndEvidenceReference()
    {
        var json = """
        {
          "schemaVersion":"map-browser-quality-evidence-v1",
          "ruleVersion":"browser-hard-gate-v1",
          "heuristicVersion":"browser-aesthetic-heuristic-v1",
          "firstPassPassed":false,
          "repairAttempts":2,
          "repairSucceeded":true,
          "finalHardPassed":true,
          "finalScore":91,
          "attempts":[
            {"viewports":[{"viewport":"desktop"},{"viewport":"mobile"}],"evidenceRefs":["assets/quality/attempt-0-desktop.png","assets/quality/attempt-0-mobile.png"]},
            {"viewports":[{"viewport":"desktop"},{"viewport":"mobile"}],"evidenceRefs":["assets/quality/attempt-1-desktop.png","assets/quality/attempt-1-mobile.png"]},
            {"viewports":[{"viewport":"desktop"},{"viewport":"mobile"}],"evidenceRefs":["assets/quality/attempt-2-desktop.png","assets/quality/attempt-2-mobile.png"]}
          ]
        }
        """;

        var summary = HostedSiteEditRunWorker.ParseBrowserQualitySummary(Package(json, 3));

        Assert.NotNull(summary);
        Assert.Equal("browser-hard-gate-v1", summary!.RuleVersion);
        Assert.False(summary.FirstPassPassed);
        Assert.Equal(2, summary.RepairAttempts);
        Assert.True(summary.RepairSucceeded);
        Assert.Equal(91, summary.FinalScore);
        Assert.Equal(["desktop", "mobile"], summary.Viewports);
        Assert.Equal("assets/visual-quality-report.json", summary.EvidenceRef);
    }

    [Theory]
    [InlineData("rawHtml")]
    [InlineData("thinking")]
    [InlineData("text_delta")]
    [InlineData("prompt")]
    public void ParseBrowserQualitySummary_RejectsRawPageOrModelMaterial(string forbiddenField)
    {
        var json = $$"""
        {
          "schemaVersion":"map-browser-quality-evidence-v1",
          "ruleVersion":"browser-hard-gate-v1",
          "heuristicVersion":"browser-aesthetic-heuristic-v1",
          "firstPassPassed":true,
          "repairAttempts":0,
          "repairSucceeded":false,
          "finalHardPassed":true,
          "finalScore":88,
          "attempts":[{"viewports":[{"viewport":"desktop"},{"viewport":"mobile"}],"evidenceRefs":["assets/quality/attempt-0-desktop.png","assets/quality/attempt-0-mobile.png"],"{{forbiddenField}}":"private"}]
        }
        """;

        var error = Assert.Throws<InvalidOperationException>(() =>
            HostedSiteEditRunWorker.ParseBrowserQualitySummary(Package(json, 1)));

        Assert.Contains("不应持久化", error.Message);
    }

    [Fact]
    public void ParseBrowserQualitySummary_RejectsUncheckedOrIncompleteEvidence()
    {
        var json = """
        {
          "schemaVersion":"map-browser-quality-evidence-v1",
          "ruleVersion":"browser-hard-gate-v1",
          "heuristicVersion":"browser-aesthetic-heuristic-v1",
          "firstPassPassed":false,
          "repairAttempts":2,
          "repairSucceeded":false,
          "finalHardPassed":false,
          "finalScore":40,
          "attempts":[{"viewports":[{"viewport":"desktop"}],"evidenceRefs":["assets/quality/attempt-0-desktop.png"]}]
        }
        """;

        Assert.Throws<InvalidOperationException>(() =>
            HostedSiteEditRunWorker.ParseBrowserQualitySummary(Package(json, 1)));
    }

    [Fact]
    public void ParseBrowserQualitySummary_PresentationKeepsFailedVisualChecksAsObservations()
    {
        var json = """
        {
          "schemaVersion":"map-browser-quality-evidence-v1",
          "ruleVersion":"browser-hard-gate-v1",
          "heuristicVersion":"browser-aesthetic-heuristic-v1",
          "firstPassPassed":false,
          "repairAttempts":0,
          "repairSucceeded":false,
          "finalHardPassed":false,
          "finalScore":40,
          "attempts":[{"viewports":[
            {"viewport":"desktop","slideIndex":1},{"viewport":"desktop","slideIndex":2},
            {"viewport":"mobile","slideIndex":1},{"viewport":"mobile","slideIndex":2}
          ],"evidenceRefs":[
            "assets/quality/attempt-0-desktop-slide-1.png","assets/quality/attempt-0-desktop-slide-2.png",
            "assets/quality/attempt-0-mobile-slide-1.png","assets/quality/attempt-0-mobile-slide-2.png"
          ]}]
        }
        """;

        var summary = HostedSiteEditRunWorker.ParseBrowserQualitySummary(
            PresentationPackage(json, 2),
            requireHardPass: false);

        Assert.NotNull(summary);
        Assert.False(summary!.FinalHardPassed);
        Assert.False(summary.RepairSucceeded);
        Assert.Equal(40, summary.FinalScore);
    }

    [Fact]
    public void ParseBrowserQualitySummary_RejectsMissingScreenshotEvidence()
    {
        var json = """
        {
          "schemaVersion":"map-browser-quality-evidence-v1",
          "ruleVersion":"browser-hard-gate-v1",
          "heuristicVersion":"browser-aesthetic-heuristic-v1",
          "firstPassPassed":true,
          "repairAttempts":0,
          "repairSucceeded":false,
          "finalHardPassed":true,
          "finalScore":90,
          "attempts":[{"viewports":[{"viewport":"desktop"},{"viewport":"mobile"}],"evidenceRefs":["assets/quality/attempt-0-desktop.png","assets/quality/missing.png"]}]
        }
        """;

        var error = Assert.Throws<InvalidOperationException>(() =>
            HostedSiteEditRunWorker.ParseBrowserQualitySummary(Package(json, 1)));

        Assert.Contains("截图引用无效", error.Message);
    }

    [Fact]
    public void ParseBrowserQualitySummary_PresentationObservationStillRequiresEveryReferencedScreenshot()
    {
        var json = """
        {
          "schemaVersion":"map-browser-quality-evidence-v1",
          "ruleVersion":"browser-hard-gate-v1",
          "heuristicVersion":"browser-aesthetic-heuristic-v1",
          "firstPassPassed":true,
          "repairAttempts":0,
          "repairSucceeded":false,
          "finalHardPassed":true,
          "finalScore":92,
          "attempts":[{"viewports":[
            {"viewport":"desktop","slideIndex":1},{"viewport":"desktop","slideIndex":2},
            {"viewport":"mobile","slideIndex":1},{"viewport":"mobile","slideIndex":2}
          ],"evidenceRefs":[
            "assets/quality/attempt-0-desktop-slide-1.png","assets/quality/attempt-0-desktop-slide-2.png",
            "assets/quality/attempt-0-mobile-slide-1.png","assets/quality/attempt-0-mobile-slide-2.png"
          ]}]
        }
        """;

        var summary = HostedSiteEditRunWorker.ParseBrowserQualitySummary(
            PresentationPackage(json, 2),
            requireHardPass: false);

        Assert.NotNull(summary);
        Assert.Throws<InvalidOperationException>(() => HostedSiteEditRunWorker.ParseBrowserQualitySummary(
            PresentationPackage(json, 2).Where(file => !file.Path.EndsWith("mobile-slide-2.png", StringComparison.Ordinal)).ToList(),
            requireHardPass: false));
    }

    private static DesignWorkspaceFile File(string json)
    {
        var bytes = Encoding.UTF8.GetBytes(json);
        return new DesignWorkspaceFile(
            "assets/visual-quality-report.json",
            Convert.ToBase64String(bytes),
            Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant(),
            bytes.Length,
            "application/json; charset=utf-8");
    }

    private static IReadOnlyList<DesignWorkspaceFile> Package(string json, int attempts)
    {
        var files = new List<DesignWorkspaceFile> { File(json) };
        for (var attempt = 0; attempt < attempts; attempt++)
        foreach (var viewport in new[] { "desktop", "mobile" })
        {
            var bytes = new byte[] { 137, 80, 78, 71 };
            files.Add(new DesignWorkspaceFile(
                $"assets/quality/attempt-{attempt}-{viewport}.png",
                Convert.ToBase64String(bytes),
                Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant(),
                bytes.Length,
                "image/png"));
        }
        return files;
    }

    private static IReadOnlyList<DesignWorkspaceFile> PresentationPackage(string json, int pages)
    {
        var files = new List<DesignWorkspaceFile> { File(json) };
        foreach (var viewport in new[] { "desktop", "mobile" })
        for (var page = 1; page <= pages; page++)
        {
            var bytes = new byte[] { 137, 80, 78, 71 };
            files.Add(new DesignWorkspaceFile(
                $"assets/quality/attempt-0-{viewport}-slide-{page}.png",
                Convert.ToBase64String(bytes),
                Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant(),
                bytes.Length,
                "image/png"));
        }
        return files;
    }
}
