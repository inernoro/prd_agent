using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Controllers;

public class MdToPptPrewarmProfileTests
{
    [Fact]
    public void RunAgentStream_PrewarmsOnlyMatchingRuntimeProfile()
    {
        var source = File.ReadAllText(ControllerPath());
        var start = source.IndexOf("private async Task RunAgentStreamAsync", StringComparison.Ordinal);
        start.ShouldBeGreaterThanOrEqualTo(0);
        var end = source.IndexOf("private async Task<InfraConnection?> ResolveCdsConnectionAsync", start, StringComparison.Ordinal);
        end.ShouldBeGreaterThan(start);
        var method = source[start..end];

        method.ShouldContain("runtimeProfile = await ResolveRuntimeProfileAsync(userId, CancellationToken.None, runtimeProfileId)");
        method.ShouldContain("session = await TakePrewarmedSessionAsync(userId, runtimeProfile.Id)");
        method.ShouldNotContain("session = await TakePrewarmedSessionAsync(userId);");
    }

    [Fact]
    public void KnowledgeReferences_AreResolvedFromServerOwnedIdentity()
    {
        var source = File.ReadAllText(ControllerPath());

        source.ShouldContain("_knowledgeSnapshots.ResolveAsync");
        source.ShouldContain("new DesignKnowledgeReferenceIdentity(");
        source.ShouldContain("BuildKnowledgeContext(knowledgeReferences)");
        source.ShouldNotContain("x.Content!.Trim()");

        var dtoStart = source.IndexOf("public class MdToPptKnowledgeReferenceRequest", StringComparison.Ordinal);
        var dtoEnd = source.IndexOf("public class MdToPptOutlineRequest", dtoStart, StringComparison.Ordinal);
        dtoStart.ShouldBeGreaterThanOrEqualTo(0);
        dtoEnd.ShouldBeGreaterThan(dtoStart);
        var dto = source[dtoStart..dtoEnd];
        dto.ShouldContain("EntryId");
        dto.ShouldContain("StoreId");
        dto.ShouldNotContain("Content");
        dto.ShouldNotContain("Title");
        dto.ShouldNotContain("StoreName");
    }

    private static string ControllerPath()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null)
        {
            var path = Path.Combine(dir.FullName, "prd-api", "src", "PrdAgent.Api", "Controllers", "Api", "MdToPptController.cs");
            if (File.Exists(path)) return path;
            dir = dir.Parent;
        }

        throw new DirectoryNotFoundException("Could not locate MdToPptController.cs from test base directory.");
    }
}
