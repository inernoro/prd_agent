using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using Moq;
using PrdAgent.Api.Controllers.Api;
using PrdAgent.Api.Services;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Services.AssetStorage;
using Xunit;

namespace PrdAgent.Api.Tests;

public sealed class DesignArtifactWorkspaceContractTests
{
    [Theory]
    [InlineData(null, 72)]
    [InlineData("0", 1)]
    [InlineData("72", 72)]
    [InlineData("200", 96)]
    public void ModelCallBudgetCoversBuildReviewAndOneRepairWithinHardLimit(
        string? configured,
        int expected)
    {
        var values = new Dictionary<string, string?>();
        if (configured != null)
            values["DesignArtifactRuntime:MaxModelCalls"] = configured;
        var configuration = new ConfigurationBuilder().AddInMemoryCollection(values).Build();

        Assert.Equal(expected, DesignArtifactWorkspaceBroker.ResolveModelCallLimit(configuration));
    }

    [Fact]
    public void NewRunUsesTheSameDefaultModelCallBudget()
    {
        Assert.Equal(72, new DesignArtifactRun().RuntimeModelCallLimit);
    }

    [Theory]
    [InlineData("{\"messages\":[]}")]
    [InlineData("{\"messages\":[],\"max_tokens\":999999,\"n\":8,\"best_of\":8}")]
    [InlineData("{\"messages\":[],\"max_completion_tokens\":999999}")]
    [InlineData("{\"messages\":[],\"max_tokens\":\"unbounded\",\"max_completion_tokens\":{}}")]
    public void MapAlwaysOwnsRemoteCompletionBudgetAndFanOut(string json)
    {
        var body = JsonNode.Parse(json)!.AsObject();

        DesignArtifactRuntimeController.ApplyMapOwnedCompletionBudget(body, 4_096);

        Assert.Equal(4_096, body["max_tokens"]?.GetValue<int>());
        Assert.Null(body["max_completion_tokens"]);
        Assert.Equal(1, body["n"]?.GetValue<int>());
        Assert.Null(body["best_of"]);
    }

    [Fact]
    public void MapPromptsMatchTheDeclarativeOnlyArtifactGate()
    {
        var generate = DesignArtifactPromptBuilder.BuildSystemPrompt(DesignArtifactOperations.Generate);
        var edit = DesignArtifactPromptBuilder.BuildSystemPrompt(DesignArtifactOperations.Edit);

        Assert.Contains("不得输出任何 <script>", generate, StringComparison.Ordinal);
        Assert.Contains("不得输出任何 <script>", edit, StringComparison.Ordinal);
        Assert.Contains("事实、数字、日期、金额、联系方式和链接只能来自", generate, StringComparison.Ordinal);
        Assert.Contains("不得保留无行为的启用按钮", edit, StringComparison.Ordinal);
        Assert.DoesNotContain("只使用内联 CSS 与原生 JavaScript", generate, StringComparison.Ordinal);
    }

    [Fact]
    public async Task ModelProxyUsesMapSourceAndKeepsOpenDesignRunAttribution()
    {
        var run = BuildRun();
        run.Id = "run-model-proxy-1";
        run.Status = RunStatuses.Running;
        run.Operation = DesignArtifactOperations.Generate;
        var broker = new Mock<IDesignArtifactWorkspaceBroker>(MockBehavior.Strict);
        broker.Setup(item => item.ReserveModelCallAsync(run.Id, "model-ticket", It.IsAny<CancellationToken>()))
            .ReturnsAsync(run);
        var handler = new CapturingHandler();
        var configuration = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["LlmGateway:ServeBaseUrl"] = "http://llmgw-serve:8091",
            ["LlmGwServe:ApiKey"] = "gateway-secret",
            ["DesignArtifactRuntime:Model"] = "gpt-4.1-mini",
        }).Build();
        var controller = new DesignArtifactRuntimeController(
            broker.Object,
            new SingleClientFactory(handler),
            configuration,
            NullLogger<DesignArtifactRuntimeController>.Instance)
        {
            ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext() },
        };
        var requestBytes = Encoding.UTF8.GetBytes("{\"model\":\"map-managed\",\"max_tokens\":8192,\"messages\":[{\"role\":\"user\",\"content\":\"hello\"}]}");
        controller.Request.Body = new MemoryStream(requestBytes);
        controller.Request.ContentLength = requestBytes.Length;
        controller.Request.Headers.Authorization = "Bearer model-ticket";
        controller.Response.Body = new MemoryStream();

        await controller.ProxyChatCompletions(run.Id, CancellationToken.None);

        Assert.Equal(StatusCodes.Status200OK, controller.Response.StatusCode);
        Assert.Equal("map", handler.Header("X-Gateway-Source"));
        Assert.Equal(AppCallerRegistry.Admin.WebHosting.GenerateHtml, handler.Header("X-Gateway-App-Caller"));
        Assert.Equal(run.UserId, handler.Header("X-Gateway-User-Id"));
        Assert.Equal(run.Id, handler.Header("X-Gateway-Run-Id"));
        Assert.Equal("gateway-secret", handler.Header("X-Gateway-Key"));
        Assert.True(handler.RequestTokenCanBeCanceled);
        Assert.Equal("gpt-4.1-mini", handler.Body?["model"]?.GetValue<string>());
        Assert.Equal(4096, handler.Body?["max_tokens"]?.GetValue<int>());
        broker.VerifyAll();
    }

    [Fact]
    public async Task ModelProxyStreamStopsWhenNoBytesArriveBeforeIdleDeadline()
    {
        await using var source = new NeverCompletingReadStream();
        await using var destination = new MemoryStream();
        using var totalDeadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            DesignArtifactRuntimeController.CopyWithIdleTimeoutAsync(
                source,
                destination,
                TimeSpan.FromMilliseconds(40),
                totalDeadline.Token));
    }

    [Fact]
    public async Task ModelProxyStreamStopsAtRunDeadlineEvenWhenIdleLimitIsLonger()
    {
        await using var source = new NeverCompletingReadStream();
        await using var destination = new MemoryStream();
        using var totalDeadline = new CancellationTokenSource(TimeSpan.FromMilliseconds(40));

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            DesignArtifactRuntimeController.CopyWithIdleTimeoutAsync(
                source,
                destination,
                TimeSpan.FromSeconds(10),
                totalDeadline.Token));
    }

    [Fact]
    public async Task ModelProxyContinuesDrainingUpstreamAfterBrowserDisconnects()
    {
        await using var source = new MemoryStream(Encoding.UTF8.GetBytes("first-second"));
        await using var disconnectedBrowser = new DisconnectingWriteStream();
        using var totalDeadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));

        await DesignArtifactRuntimeController.CopyWithIdleTimeoutAsync(
            source,
            disconnectedBrowser,
            TimeSpan.FromSeconds(1),
            totalDeadline.Token);

        Assert.Equal(source.Length, source.Position);
        Assert.Equal(1, disconnectedBrowser.WriteAttempts);
    }

    [Fact]
    public void ModelProxyTotalDeadlineUsesRunTicketAndHardUpperBound()
    {
        var now = new DateTime(2026, 9, 6, 0, 0, 0, DateTimeKind.Utc);
        var configuration = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["DesignArtifactRuntime:ProxyTimeoutSeconds"] = "3600",
        }).Build();

        var hardBound = DesignArtifactRuntimeController.ResolveProxyTotalTimeout(configuration, null, now);
        var runBound = DesignArtifactRuntimeController.ResolveProxyTotalTimeout(
            configuration,
            now.AddSeconds(20),
            now);

        Assert.Equal(TimeSpan.FromMinutes(15), hardBound);
        Assert.Equal(TimeSpan.FromSeconds(20), runBound);
        Assert.Throws<UnauthorizedAccessException>(() =>
            DesignArtifactRuntimeController.ResolveProxyTotalTimeout(configuration, now, now));
    }

    [Fact]
    public async Task ModelProxyUsesPoolRoutingFieldsInsteadOfPretendingPoolIdIsAModel()
    {
        var run = BuildRun();
        run.Id = "run-model-pool-proxy-1";
        run.Status = RunStatuses.Running;
        var broker = new Mock<IDesignArtifactWorkspaceBroker>(MockBehavior.Strict);
        broker.Setup(item => item.ReserveModelCallAsync(run.Id, "model-ticket", It.IsAny<CancellationToken>()))
            .ReturnsAsync(run);
        var handler = new CapturingHandler();
        var configuration = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["LlmGateway:ServeBaseUrl"] = "http://llmgw-serve:8091",
            ["LlmGwServe:ApiKey"] = "gateway-secret",
            ["DesignArtifactRuntime:ModelPoolId"] = "pool-chat-premium",
            ["DesignArtifactRuntime:Model"] = "gpt-4.1-mini",
        }).Build();
        var controller = new DesignArtifactRuntimeController(
            broker.Object,
            new SingleClientFactory(handler),
            configuration,
            NullLogger<DesignArtifactRuntimeController>.Instance)
        {
            ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext() },
        };
        var requestBytes = Encoding.UTF8.GetBytes("{\"model\":\"map-managed\",\"messages\":[{\"role\":\"user\",\"content\":\"hello\"}]}");
        controller.Request.Body = new MemoryStream(requestBytes);
        controller.Request.ContentLength = requestBytes.Length;
        controller.Request.Headers.Authorization = "Bearer model-ticket";
        controller.Response.Body = new MemoryStream();

        await controller.ProxyChatCompletions(run.Id, CancellationToken.None);

        Assert.Equal(StatusCodes.Status200OK, controller.Response.StatusCode);
        Assert.Null(handler.Body?["model"]);
        Assert.Equal("pool-chat-premium", handler.Body?["model_pool_id"]?.GetValue<string>());
        Assert.Equal("pool", handler.Body?["model_policy"]?.GetValue<string>());
        broker.VerifyAll();
    }

    [Fact]
    public async Task WorkspaceMetadataRoundTripsThroughRegisteredAssetStoragePath()
    {
        var root = Path.Combine(Path.GetTempPath(), $"design-workspace-assets-{Guid.NewGuid():N}");
        try
        {
            IAssetStorage storage = new LocalAssetStorage(root);
            var payload = Encoding.UTF8.GetBytes("{\"schemaVersion\":\"map-design-workspace-v1\"}");

            var stored = await DesignArtifactWorkspaceBroker.SaveWorkspaceMetadataAsync(
                storage,
                payload,
                "run-workspace-1.json",
                CancellationToken.None);

            Assert.Equal(AppDomainPaths.DomainWebHosting, AppDomainPaths.NormDomain(AppDomainPaths.DomainWebHosting));
            Assert.Equal(AppDomainPaths.TypeMeta, AppDomainPaths.NormType(AppDomainPaths.TypeMeta));
            Assert.NotNull(stored.Key);
            Assert.StartsWith(
                $"{AppDomainPaths.DomainWebHosting}/{AppDomainPaths.TypeMeta}/",
                stored.Key,
                StringComparison.Ordinal);
            Assert.Equal(payload, await storage.TryDownloadBytesAsync(stored.Key!, CancellationToken.None));
        }
        finally
        {
            if (Directory.Exists(root))
                Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void InputPackageMaterializesKnowledgeAndCurrentPageAsFiles()
    {
        var run = BuildRun();

        var package = DesignArtifactWorkspaceContract.BuildInputPackage(
            run,
            "<!doctype html><html><body>旧页面</body></html>");

        Assert.Equal(DesignArtifactWorkspaceBroker.SchemaVersion, package.SchemaVersion);
        Assert.Equal(run.Id, package.RunId);
        Assert.Equal(64, package.BaseRevision.Length);
        Assert.Contains(package.Files, file => file.Path == "brief/task.json");
        Assert.Contains(package.Files, file => file.Path.StartsWith("knowledge/01-", StringComparison.Ordinal));
        Assert.Contains(package.Files, file => file.Path == "current/index.html");
        foreach (var file in package.Files)
        {
            var bytes = Convert.FromBase64String(file.ContentBase64);
            Assert.Equal(file.Size, bytes.LongLength);
            Assert.Equal(Hash(bytes), file.Sha256);
        }

        var taskFile = Assert.Single(package.Files, file => file.Path == "brief/task.json");
        using var task = JsonDocument.Parse(Convert.FromBase64String(taskFile.ContentBase64));
        var quality = task.RootElement.GetProperty("qualityContract");
        Assert.Equal("map-design-artifact-quality-v1", quality.GetProperty("schemaVersion").GetString());
        Assert.Equal(
            ["title", "instruction", "knowledge", "current-visible-content"],
            quality.GetProperty("factualSources").EnumerateArray().Select(value => value.GetString() ?? string.Empty).ToArray());
        Assert.True(quality.GetProperty("measuredClaimsRequireSource").GetBoolean());
        Assert.True(quality.GetProperty("sensitiveFactsRequireSource").GetBoolean());
        Assert.True(quality.GetProperty("contextBoundMetricsReviewRequired").GetBoolean());
        Assert.False(quality.GetProperty("visibleDraftMarkersAllowed").GetBoolean());
        Assert.False(quality.GetProperty("emptyOrMissingFragmentTargetsAllowed").GetBoolean());
        Assert.False(quality.GetProperty("inertEnabledButtonsAllowed").GetBoolean());
        Assert.True(quality.GetProperty("finalReviewRequired").GetBoolean());
    }

    [Fact]
    public void MapQualityEvidenceIncludesKnowledgeTitlesAndOnlyVisibleCurrentContent()
    {
        var run = BuildRun();
        run.KnowledgeReferences[0].Title = "2026-10-01 发布计划与 40 分钟指南";
        var current = new HostedSiteEditableEntry(
            new HostedSite(),
            "<!doctype html><html><body><p>当前可见事实</p><div hidden>平台已服务999个项目</div></body></html>",
            DateTime.UtcNow);

        var evidence = HostedSiteEditRunWorker.BuildQualityEvidence(run, current);

        Assert.Contains("2026-10-01 发布计划与 40 分钟指南", evidence, StringComparison.Ordinal);
        Assert.Contains("当前可见事实", evidence, StringComparison.Ordinal);
        Assert.DoesNotContain("999个项目", evidence, StringComparison.Ordinal);
        HostedSiteRevisionRules.ValidateGeneratedContentQuality(
            "<!doctype html><html><body><p>2026-10-01，完整阅读约40分钟。</p></body></html>",
            evidence);
    }

    [Fact]
    public void InputPackageRemovesOnlyMapDeliveryWrappersFromEditablePage()
    {
        var run = BuildRun();
        var html = $"""
            <!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="{HostedSiteRevisionRules.GeneratedArtifactCsp}">
            <script data-cds-offline-guard>addEventListener('click', block, true)</script>
            </head><body><main>真实页面</main>
            <script>window.location.hash = '#kept-for-output-review'</script>
            <!--map-slide-nav-compat--><script>window.location.pathname</script>
            </body></html>
            """;

        var package = DesignArtifactWorkspaceContract.BuildInputPackage(run, html);
        var current = Assert.Single(package.Files, file => file.Path == "current/index.html");
        var editableHtml = Encoding.UTF8.GetString(Convert.FromBase64String(current.ContentBase64));

        Assert.DoesNotContain("map-slide-nav-compat", editableHtml, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("data-cds-offline-guard", editableHtml, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("Content-Security-Policy", editableHtml, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("真实页面", editableHtml, StringComparison.Ordinal);
        Assert.Contains("window.location.hash", editableHtml, StringComparison.Ordinal);
    }

    [Fact]
    public void InputPackageSizeUsesSerializedBase64PackageInsteadOfRawCharacterEstimate()
    {
        var run = BuildRun();
        run.KnowledgeReferences.Clear();
        var rawHtml = $"<!doctype html><html><body>{new string('a', 800_000)}</body></html>";
        Assert.True(Encoding.UTF8.GetByteCount(rawHtml) < DesignArtifactWorkspaceBroker.MaxInputBytes);

        var package = DesignArtifactWorkspaceContract.BuildInputPackage(run, rawHtml);
        var error = Assert.Throws<InvalidOperationException>(() =>
            DesignArtifactWorkspaceContract.ValidateInputPackageSize(
                package,
                DesignArtifactWorkspaceBroker.MaxInputBytes));

        Assert.Contains("打包后超过远程工作区 1MB 上限", error.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void ResultPackageRejectsBytesBeyondConfiguredLimitBeforeParsing()
    {
        var error = Assert.Throws<InvalidOperationException>(() =>
            DesignArtifactWorkspaceContract.ParseAndValidateResult(
                new byte[1_025],
                "run-workspace-1",
                "base-revision",
                1_024));

        Assert.Contains("大小不符合要求", error.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void VerifiedCdsHardenedResultCanBeHardenedAgainWithExactlyOneSystemCsp()
    {
        var run = BuildRun();
        var input = DesignArtifactWorkspaceContract.BuildInputPackage(run, null);
        var cdsHtml = $"<!doctype html><html><head><meta http-equiv=\"Content-Security-Policy\" content=\"{HostedSiteRevisionRules.GeneratedArtifactCsp}\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><title>CDS result</title></head><body>ok</body></html>";
        var htmlFile = BuildFile("index.html", cdsHtml, "text/html");
        var manifest = BuildManifest(input.BaseRevision, htmlFile);
        var result = new DesignWorkspacePackage(
            DesignArtifactWorkspaceBroker.SchemaVersion,
            run.Id,
            input.BaseRevision,
            [htmlFile, manifest]);
        var bytes = JsonSerializer.SerializeToUtf8Bytes(result, DesignArtifactWorkspaceContract.JsonOptions);

        var verified = DesignArtifactWorkspaceContract.ParseAndValidateResult(
            bytes,
            run.Id,
            input.BaseRevision,
            DesignArtifactWorkspaceBroker.MaxOutputBytes);
        var trustedPayload = HostedSiteRevisionRules.StripSingleTrustedSystemCspEnvelope(verified.IndexHtml);
        var hardenedAgain = HostedSiteRevisionRules.HardenGeneratedHtml(trustedPayload);

        Assert.Single(System.Text.RegularExpressions.Regex.Matches(
                hardenedAgain,
                "Content-Security-Policy",
                System.Text.RegularExpressions.RegexOptions.IgnoreCase)
            .Cast<System.Text.RegularExpressions.Match>());
        Assert.Single(System.Text.RegularExpressions.Regex.Matches(
                hardenedAgain,
                @"<head\b",
                System.Text.RegularExpressions.RegexOptions.IgnoreCase)
            .Cast<System.Text.RegularExpressions.Match>());
        Assert.Contains("name=\"viewport\"", hardenedAgain, StringComparison.Ordinal);
        Assert.Contains("CDS result", hardenedAgain, StringComparison.Ordinal);
    }

    [Theory]
    [MemberData(nameof(UntrustedSystemMetaVariants))]
    public void TrustedCdsBoundaryDoesNotStripMovedDuplicateOrCustomHttpEquiv(string html)
    {
        var boundaryResult = HostedSiteRevisionRules.StripSingleTrustedSystemCspEnvelope(html);

        Assert.Throws<InvalidOperationException>(() => HostedSiteRevisionRules.HardenGeneratedHtml(boundaryResult));
    }

    public static IEnumerable<object[]> UntrustedSystemMetaVariants()
    {
        var exact = $"<head><meta http-equiv=\"Content-Security-Policy\" content=\"{HostedSiteRevisionRules.GeneratedArtifactCsp}\"></head>";
        yield return [$"<!doctype html><html><head><title>before</title><meta http-equiv=\"Content-Security-Policy\" content=\"{HostedSiteRevisionRules.GeneratedArtifactCsp}\"></head><body></body></html>"];
        yield return [$"<!doctype html><html>{exact}{exact}<body></body></html>"];
        yield return ["<!doctype html><html><head><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'\"></head><body></body></html>"];
        yield return ["<!doctype html><html><head><meta http-equiv=\"re&#102;resh\" content=\"0;url=https://evil.example\"></head><body></body></html>"];
    }

    [Fact]
    public void ResultRequiresMatchingRevisionAndVerifiedIndexHtml()
    {
        var run = BuildRun();
        var input = DesignArtifactWorkspaceContract.BuildInputPackage(run, null);
        var html = Encoding.UTF8.GetBytes("<!doctype html><html><body>新页面</body></html>");
        var htmlFile = new DesignWorkspaceFile("index.html", Convert.ToBase64String(html), Hash(html), html.Length, "text/html");
        var manifest = BuildManifest(input.BaseRevision, htmlFile);
        var result = new DesignWorkspacePackage(
            DesignArtifactWorkspaceBroker.SchemaVersion,
            run.Id,
            input.BaseRevision,
            [htmlFile, manifest]);
        var bytes = JsonSerializer.SerializeToUtf8Bytes(result, DesignArtifactWorkspaceContract.JsonOptions);

        var parsed = DesignArtifactWorkspaceContract.ParseAndValidateResult(
            bytes,
            run.Id,
            input.BaseRevision,
            DesignArtifactWorkspaceBroker.MaxOutputBytes);

        Assert.Contains("新页面", parsed.IndexHtml);
    }

    [Theory]
    [InlineData("other-run", null)]
    [InlineData(null, "other-revision")]
    public void ResultRejectsAnotherTaskOrSourceRevision(string? resultRunId, string? resultBaseRevision)
    {
        var run = BuildRun();
        var input = DesignArtifactWorkspaceContract.BuildInputPackage(run, null);
        var htmlFile = BuildFile("index.html", "<!doctype html><html><body>新页面</body></html>", "text/html");
        var manifest = BuildManifest(resultBaseRevision ?? input.BaseRevision, htmlFile);
        var result = new DesignWorkspacePackage(
            DesignArtifactWorkspaceBroker.SchemaVersion,
            resultRunId ?? run.Id,
            resultBaseRevision ?? input.BaseRevision,
            [htmlFile, manifest]);
        var bytes = JsonSerializer.SerializeToUtf8Bytes(result, DesignArtifactWorkspaceContract.JsonOptions);

        var error = Assert.Throws<InvalidOperationException>(() =>
            DesignArtifactWorkspaceContract.ParseAndValidateResult(
                bytes,
                run.Id,
                input.BaseRevision,
                DesignArtifactWorkspaceBroker.MaxOutputBytes));

        Assert.Contains("版本不匹配", error.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void ResultRejectsManifestThatDoesNotMatchVerifiedFiles()
    {
        var run = BuildRun();
        var input = DesignArtifactWorkspaceContract.BuildInputPackage(run, null);
        var html = Encoding.UTF8.GetBytes("<!doctype html><html><body>新页面</body></html>");
        var htmlFile = new DesignWorkspaceFile("index.html", Convert.ToBase64String(html), Hash(html), html.Length, "text/html");
        var incorrectManifest = BuildManifest(input.BaseRevision, htmlFile with { Sha256 = new string('a', 64) });
        var result = new DesignWorkspacePackage(
            DesignArtifactWorkspaceBroker.SchemaVersion,
            run.Id,
            input.BaseRevision,
            [htmlFile, incorrectManifest]);
        var bytes = JsonSerializer.SerializeToUtf8Bytes(result, DesignArtifactWorkspaceContract.JsonOptions);

        var error = Assert.Throws<InvalidOperationException>(() =>
            DesignArtifactWorkspaceContract.ParseAndValidateResult(
                bytes,
                run.Id,
                input.BaseRevision,
                DesignArtifactWorkspaceBroker.MaxOutputBytes));

        Assert.Contains("清单与文件校验结果不一致", error.Message);
    }

    [Theory]
    [InlineData("/index.html")]
    [InlineData("assets/../secret.txt")]
    [InlineData("assets/..")]
    [InlineData("assets/./logo.png")]
    [InlineData("assets//logo.png")]
    [InlineData("assets\\..\\secret.txt")]
    [InlineData(" assets/logo.png")]
    public void ResultRejectsNonCanonicalOrTraversalPathEvenWhenHashMatches(string path)
    {
        var run = BuildRun();
        var input = DesignArtifactWorkspaceContract.BuildInputPackage(run, null);
        var content = Encoding.UTF8.GetBytes("secret");
        var result = new DesignWorkspacePackage(
            DesignArtifactWorkspaceBroker.SchemaVersion,
            run.Id,
            input.BaseRevision,
            [new DesignWorkspaceFile(path, Convert.ToBase64String(content), Hash(content), content.Length, "text/plain")]);
        var bytes = JsonSerializer.SerializeToUtf8Bytes(result, DesignArtifactWorkspaceContract.JsonOptions);

        var error = Assert.Throws<InvalidOperationException>(() =>
            DesignArtifactWorkspaceContract.ParseAndValidateResult(
                bytes,
                run.Id,
                input.BaseRevision,
                DesignArtifactWorkspaceBroker.MaxOutputBytes));

        Assert.Contains("不允许", error.Message);
    }

    private static DesignArtifactRun BuildRun() => new()
    {
        Id = "run-workspace-1",
        UserId = "user-1",
        Title = "网页标题",
        Operation = DesignArtifactOperations.Edit,
        SourceSurface = DesignArtifactSourceSurfaces.WebHosting,
        Instruction = "把主色改成蓝色并保留正文",
        KnowledgeReferences =
        [
            new DesignKnowledgeSnapshot
            {
                EntryId = "entry-1",
                Title = "产品 资料",
                Content = "产品定位与核心卖点",
                ContentHash = "source-hash",
            },
        ],
    };

    private static string Hash(byte[] bytes) =>
        Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();

    private static DesignWorkspaceFile BuildManifest(string baseRevision, DesignWorkspaceFile file)
    {
        var manifest = new DesignArtifactManifest(
            DesignArtifactWorkspaceBroker.ManifestSchemaVersion,
            baseRevision,
            "index.html",
            [new DesignArtifactManifestFile(file.Path, file.Sha256, file.Size, file.MediaType)]);
        var bytes = JsonSerializer.SerializeToUtf8Bytes(manifest, DesignArtifactWorkspaceContract.JsonOptions);
        return new DesignWorkspaceFile(
            "manifest.json",
            Convert.ToBase64String(bytes),
            Hash(bytes),
            bytes.Length,
            "application/json");
    }

    private static DesignWorkspaceFile BuildFile(string path, string content, string mediaType)
    {
        var bytes = Encoding.UTF8.GetBytes(content);
        return new DesignWorkspaceFile(path, Convert.ToBase64String(bytes), Hash(bytes), bytes.Length, mediaType);
    }

    private sealed class SingleClientFactory(HttpMessageHandler handler) : IHttpClientFactory
    {
        public HttpClient CreateClient(string name) => new(handler, disposeHandler: false);
    }

    private sealed class CapturingHandler : HttpMessageHandler
    {
        private IReadOnlyDictionary<string, string[]> _headers = new Dictionary<string, string[]>();

        public JsonObject? Body { get; private set; }

        public bool RequestTokenCanBeCanceled { get; private set; }

        public string Header(string name) => _headers.TryGetValue(name, out var values)
            ? Assert.Single(values)
            : string.Empty;

        protected override async Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            RequestTokenCanBeCanceled = cancellationToken.CanBeCanceled;
            _headers = request.Headers.ToDictionary(item => item.Key, item => item.Value.ToArray(), StringComparer.OrdinalIgnoreCase);
            Body = JsonNode.Parse(await request.Content!.ReadAsStringAsync(cancellationToken)) as JsonObject;
            return new HttpResponseMessage(System.Net.HttpStatusCode.OK)
            {
                Content = new StringContent("{\"id\":\"gateway-response\"}", Encoding.UTF8, "application/json"),
            };
        }
    }

    private sealed class NeverCompletingReadStream : Stream
    {
        public override bool CanRead => true;
        public override bool CanSeek => false;
        public override bool CanWrite => false;
        public override long Length => throw new NotSupportedException();
        public override long Position
        {
            get => throw new NotSupportedException();
            set => throw new NotSupportedException();
        }

        public override void Flush() { }
        public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException();
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();

        public override async ValueTask<int> ReadAsync(
            Memory<byte> buffer,
            CancellationToken cancellationToken = default)
        {
            await Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken);
            return 0;
        }
    }

    private sealed class DisconnectingWriteStream : Stream
    {
        public int WriteAttempts { get; private set; }

        public override bool CanRead => false;
        public override bool CanSeek => false;
        public override bool CanWrite => true;
        public override long Length => throw new NotSupportedException();
        public override long Position
        {
            get => throw new NotSupportedException();
            set => throw new NotSupportedException();
        }

        public override void Flush() => throw new IOException("browser disconnected");
        public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException();
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new IOException("browser disconnected");

        public override ValueTask WriteAsync(
            ReadOnlyMemory<byte> buffer,
            CancellationToken cancellationToken = default)
        {
            WriteAttempts++;
            return ValueTask.FromException(new IOException("browser disconnected"));
        }
    }
}
