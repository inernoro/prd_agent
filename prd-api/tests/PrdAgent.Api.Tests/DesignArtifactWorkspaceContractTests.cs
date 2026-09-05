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
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Services.AssetStorage;
using Xunit;

namespace PrdAgent.Api.Tests;

public sealed class DesignArtifactWorkspaceContractTests
{
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
        Assert.Equal("gpt-4.1-mini", handler.Body?["model"]?.GetValue<string>());
        Assert.Equal(4096, handler.Body?["max_tokens"]?.GetValue<int>());
        broker.VerifyAll();
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
    }

    [Fact]
    public void InputPackageRemovesOnlyMapDeliveryWrappersFromEditablePage()
    {
        var run = BuildRun();
        const string html = """
            <!doctype html><html><head>
            <meta http-equiv="Content-Security-Policy" content="default-src 'none'">
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

    [Fact]
    public void ResultRejectsTraversalEvenWhenHashMatches()
    {
        var run = BuildRun();
        var input = DesignArtifactWorkspaceContract.BuildInputPackage(run, null);
        var content = Encoding.UTF8.GetBytes("secret");
        var result = new DesignWorkspacePackage(
            DesignArtifactWorkspaceBroker.SchemaVersion,
            run.Id,
            input.BaseRevision,
            [new DesignWorkspaceFile("assets/../secret.txt", Convert.ToBase64String(content), Hash(content), content.Length, "text/plain")]);
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

    private sealed class SingleClientFactory(HttpMessageHandler handler) : IHttpClientFactory
    {
        public HttpClient CreateClient(string name) => new(handler, disposeHandler: false);
    }

    private sealed class CapturingHandler : HttpMessageHandler
    {
        private IReadOnlyDictionary<string, string[]> _headers = new Dictionary<string, string[]>();

        public JsonObject? Body { get; private set; }

        public string Header(string name) => _headers.TryGetValue(name, out var values)
            ? Assert.Single(values)
            : string.Empty;

        protected override async Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            _headers = request.Headers.ToDictionary(item => item.Key, item => item.Value.ToArray(), StringComparer.OrdinalIgnoreCase);
            Body = JsonNode.Parse(await request.Content!.ReadAsStringAsync(cancellationToken)) as JsonObject;
            return new HttpResponseMessage(System.Net.HttpStatusCode.OK)
            {
                Content = new StringContent("{\"id\":\"gateway-response\"}", Encoding.UTF8, "application/json"),
            };
        }
    }
}
