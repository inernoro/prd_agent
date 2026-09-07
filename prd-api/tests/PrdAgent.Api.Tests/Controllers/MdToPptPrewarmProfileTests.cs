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
    public void KnowledgeReferences_AreResolvedFromServerOwnedIdentityAndPreflightHash()
    {
        var source = File.ReadAllText(ControllerPath());

        source.ShouldContain("_knowledgeSnapshots.ResolveForRunAsync");
        source.ShouldContain("new DesignKnowledgeReferenceIdentity(");
        source.ShouldContain("item.ContentHash");
        source.ShouldContain("BuildKnowledgeContext(knowledgeReferences)");
        source.ShouldNotContain("x.Content!.Trim()");
        source.ShouldContain("StatusCodes.Status409Conflict");

        var dtoStart = source.IndexOf("public class MdToPptKnowledgeReferenceRequest", StringComparison.Ordinal);
        var dtoEnd = source.IndexOf("public class MdToPptOutlineRequest", dtoStart, StringComparison.Ordinal);
        dtoStart.ShouldBeGreaterThanOrEqualTo(0);
        dtoEnd.ShouldBeGreaterThan(dtoStart);
        var dto = source[dtoStart..dtoEnd];
        dto.ShouldContain("EntryId");
        dto.ShouldContain("StoreId");
        dto.ShouldContain("ContentHash");
        dto.ShouldNotContain("public string? Content {");
        dto.ShouldNotContain("Title");
        dto.ShouldNotContain("StoreName");
    }

    [Fact]
    public void Convert_RejectsStaleKnowledgeBeforeCreatingRunOrStartingStreaming()
    {
        var source = File.ReadAllText(ControllerPath());
        var start = source.IndexOf("public async Task Convert(", StringComparison.Ordinal);
        var end = source.IndexOf("[HttpPost(\"patch\")]", start, StringComparison.Ordinal);
        start.ShouldBeGreaterThanOrEqualTo(0);
        end.ShouldBeGreaterThan(start);
        var method = source[start..end];

        var resolve = method.IndexOf("ResolveKnowledgeReferencesAsync", StringComparison.Ordinal);
        var streamHeaders = method.IndexOf("SetSseHeaders()", StringComparison.Ordinal);
        var createRun = method.IndexOf("CreateRunAsync", StringComparison.Ordinal);
        resolve.ShouldBeGreaterThanOrEqualTo(0);
        streamHeaders.ShouldBeGreaterThan(resolve);
        createRun.ShouldBeGreaterThan(resolve);
        method.ShouldContain("Response.StatusCode = KnowledgeReferenceStatusCode(ex)");
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
