using Shouldly;
using PrdAgent.Api.Controllers.Api;
using PrdAgent.Core.Models;
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
        method.ShouldContain("session = await TakePrewarmedSessionAsync(userId, run.Id, runtimeProfile.Id)");
        method.ShouldNotContain("session = await TakePrewarmedSessionAsync(userId);");
    }

    [Fact]
    public void KnowledgeReferences_AreResolvedFromServerOwnedIdentityAndPreflightHash()
    {
        var source = File.ReadAllText(ControllerPath());

        source.ShouldContain("_knowledgeSnapshots.ResolveForRunAsync");
        source.ShouldContain("new DesignKnowledgeReferenceIdentity(");
        source.ShouldContain("item.ContentHash");
        source.ShouldContain("BuildPartitionedKnowledgeContext(");
        source.ShouldContain("server-authoritative-snapshot");
        source.ShouldContain("user-supplied-not-knowledge-provenance");
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

    [Fact]
    public void ConfirmedOutline_RequiresExactlyTheSameFrozenKnowledgeSet()
    {
        var expected = new[]
        {
            Snapshot("entry-a", "store-a", 'a'),
            Snapshot("entry-b", "store-b", 'b'),
        };

        MdToPptController.KnowledgeReferenceSetsMatch(
            expected,
            new[] { Snapshot("entry-b", "store-b", 'b'), Snapshot("entry-a", "store-a", 'a') })
            .ShouldBeTrue();
        MdToPptController.KnowledgeReferenceSetsMatch(
            expected,
            new[] { Snapshot("entry-b", "store-b", 'c'), Snapshot("entry-a", "store-a", 'a') })
            .ShouldBeFalse();
    }

    [Fact]
    public void MixedInput_IsPartitionedByAuthorityInsteadOfBlessingClientTextAsKnowledge()
    {
        var context = MdToPptController.BuildPartitionedKnowledgeContext(
            "客户端正文",
            "客户端附件",
            "客户端大纲",
            new[] { Snapshot("entry-a", "store-a", 'a') });

        context.ShouldContain("<user_supplied authority=\"user-supplied-not-knowledge-provenance\">");
        context.ShouldContain("客户端正文");
        context.ShouldContain("客户端附件");
        context.ShouldContain("客户端大纲");
        context.ShouldContain("<server_knowledge authority=\"server-authoritative-snapshot\">");
        context.ShouldContain("冻结知识正文");
    }

    [Fact]
    public void OutlineGatewayAudit_IsCreatedAfterRunAndCarriesRunIdentity()
    {
        var source = File.ReadAllText(ControllerPath());
        foreach (var (methodName, runVariable) in new[]
                 {
                     ("public async Task<IActionResult> Outline(", "outlineRun"),
                     ("public async Task OutlineStream(", "run"),
                 })
        {
            var start = source.IndexOf(methodName, StringComparison.Ordinal);
            start.ShouldBeGreaterThanOrEqualTo(0);
            var nextAction = source.IndexOf("[Http", start + methodName.Length, StringComparison.Ordinal);
            var method = nextAction > start ? source[start..nextAction] : source[start..];
            var createRun = method.IndexOf("CreateRunAsync", StringComparison.Ordinal);
            var beginScope = method.IndexOf("_llmRequestContext.BeginScope", StringComparison.Ordinal);

            createRun.ShouldBeGreaterThanOrEqualTo(0);
            beginScope.ShouldBeGreaterThan(createRun);
            method.ShouldContain($"SessionId: {runVariable}.Id");
            method.ShouldContain($"RunId: {runVariable}.Id");
        }
    }

    [Fact]
    public void ConfirmedOutlineHash_IsCanonicalButChangesWhenMeaningfulContentChanges()
    {
        var first = new[]
        {
            new MdToPptOutlinePageDto { Title = " 第一页 ", Bullets = [" 要点一 "], Design = " 左右布局 " },
        };
        var normalized = new[]
        {
            new MdToPptOutlinePageDto { Title = "第一页", Bullets = ["要点一"], Design = "左右布局" },
        };
        var changed = new[]
        {
            new MdToPptOutlinePageDto { Title = "第一页", Bullets = ["要点二"], Design = "左右布局" },
        };

        MdToPptController.ComputeOutlineHash(first, " 摘要 ")
            .ShouldBe(MdToPptController.ComputeOutlineHash(normalized, "摘要"));
        MdToPptController.ComputeOutlineHash(changed, "摘要")
            .ShouldNotBe(MdToPptController.ComputeOutlineHash(normalized, "摘要"));
    }

    [Fact]
    public void Convert_ValidatesConfirmedOutlineAndContentBeforeStreamingOrRunCreation()
    {
        var source = File.ReadAllText(ControllerPath());
        var start = source.IndexOf("public async Task Convert(", StringComparison.Ordinal);
        var end = source.IndexOf("[HttpPost(\"patch\")]", start, StringComparison.Ordinal);
        var method = source[start..end];

        var binding = method.IndexOf("outline_binding_mismatch", StringComparison.Ordinal);
        binding.ShouldBeGreaterThanOrEqualTo(0);
        method.IndexOf("SetSseHeaders()", StringComparison.Ordinal).ShouldBeGreaterThan(binding);
        method.IndexOf("CreateRunAsync", StringComparison.Ordinal).ShouldBeGreaterThan(binding);
        method.ShouldContain("ConfirmedContentHash");
        method.ShouldContain("ConfirmedOutlineHash");
        method.ShouldContain("CryptographicOperations.FixedTimeEquals");
    }

    [Fact]
    public void Prewarm_IsDurableSingleFlightAndClaimBindsRootRun()
    {
        var source = File.ReadAllText(ControllerPath());
        source.ShouldContain("BuildPrewarmKey(userId, profile.Id)");
        source.ShouldContain("ClientApp: \"md-to-ppt-prewarm\"");
        source.ShouldContain("PrewarmExpiresAt: now + PrewarmTtl");
        source.ShouldContain("ClaimPrewarmedAsync(");
        source.ShouldNotContain("ConcurrentDictionary<string, PrewarmEntry>");
    }

    [Fact]
    public void PublicGenerationError_DoesNotExposeUpstreamSecretsOrTopology()
    {
        var error = MdToPptController.ToPublicGenerationError(
            "https://provider.internal Bearer secret api_key=hidden model=private-model");

        error.ShouldNotContain("provider");
        error.ShouldNotContain("Bearer");
        error.ShouldNotContain("api_key");
        error.ShouldNotContain("private-model");
        error.ShouldContain("请稍后重试");
    }

    private static DesignKnowledgeSnapshot Snapshot(string entryId, string storeId, char hashChar) => new()
    {
        EntryId = entryId,
        StoreId = storeId,
        StoreName = "知识库",
        Title = "条目",
        Content = "冻结知识正文",
        ContentHash = new string(hashChar, 64),
    };

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
