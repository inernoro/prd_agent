using System.Security.Claims;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging.Abstractions;
using MongoDB.Driver;
using PrdAgent.Api.Controllers;
using PrdAgent.Api.Controllers.Api;
using PrdAgent.Api.Mcp;
using PrdAgent.Api.Services;
using PrdAgent.Api.Services.Mcp;
using PrdAgent.Core.Models;
using PrdAgent.Core.Services;
using PrdAgent.Infrastructure.Database;
using Xunit;

namespace PrdAgent.Api.Tests.Mcp;

/// <summary>
/// 文学 MCP「能用但难用、会把数据弄乱」那一批问题的回归：
/// 风格 / 水印 / 尺寸不能指定、单篇只能 4 张、全角冒号不认、改稿后配不了图、
/// 幂等键复用悄悄返回旧文章、网页一操作就把历史配图删掉、网页整份覆盖抹掉智能体的任务状态。
/// </summary>
public class LiteraryMcpUsabilityTests
{
    // ───────────── 纯函数：标记格式 ─────────────

    [Theory]
    [InlineData("正文\n[插图]：书店\n")]
    [InlineData("正文\n【插图】: 书店\n")]
    [InlineData("正文\n【插图】：书店\n")]
    [InlineData("正文\r\n[插图] : 书店\r\n")]
    public void 全角与括号变体都规范成标准标记(string raw)
    {
        var normalized = LiteraryMcpWorkflow.NormalizeMarkedContent(raw);
        Assert.Null(LiteraryMcpWorkflow.Validate(null, normalized, null));
        var markers = ArticleMarkerExtractor.Extract(normalized);
        Assert.Single(markers);
        Assert.Equal("书店", markers[0].Text.Trim());
    }

    [Fact]
    public void 空描述的标记被拒_不会吞掉下一段正文()
    {
        var normalized = LiteraryMcpWorkflow.NormalizeMarkedContent("第一段。\n[插图]：\n第二段不能被当成画面描述。\n");
        var error = LiteraryMcpWorkflow.Validate(null, normalized, null);
        Assert.NotNull(error);
        Assert.Contains("没有画面描述", error);
    }

    [Fact]
    public void 单篇上限提到二十张()
    {
        string Article(int n) => "正文。\n" + string.Concat(Enumerable.Range(0, n).Select(i => $"[插图]: 画面{i}\n段落{i}\n"));
        Assert.Null(LiteraryMcpWorkflow.Validate(null, Article(20), null));
        Assert.Contains("1-20", LiteraryMcpWorkflow.Validate(null, Article(21), null));
    }

    [Fact]
    public void 标记写进普通正文会被拦下而不是当文字存()
    {
        Assert.Contains("markedContent", LiteraryMcpWorkflow.Validate("正文\n[插图]：书店", null, null));
        Assert.Null(LiteraryMcpWorkflow.Validate("只是普通正文", null, null));
    }

    // ───────────── 纯函数：当前配图判定 ─────────────

    [Fact]
    public void 当前配图按指针与版本认_旧版本的图不会顶掉当前图()
    {
        var ws = new ImageMasterWorkspace
        {
            Id = "w",
            ArticleWorkflow = new()
            {
                Version = 3,
                Markers = new() { new() { Index = 0 }, new() { Index = 1 } },
                AssetIdByMarkerIndex = new() { ["0"] = "cur-0" },
            },
        };
        var t0 = DateTime.UtcNow;
        var assets = new List<ImageAsset>
        {
            new() { Id = "cur-0", WorkspaceId = "w", ArticleInsertionIndex = 0, ArticleWorkflowVersion = 3, CreatedAt = t0 },
            new() { Id = "old-0-newer", WorkspaceId = "w", ArticleInsertionIndex = 0, ArticleWorkflowVersion = 2, CreatedAt = t0.AddMinutes(5) },
            new() { Id = "old-1", WorkspaceId = "w", ArticleInsertionIndex = 1, ArticleWorkflowVersion = 2, CreatedAt = t0 },
            new() { Id = "cur-1", WorkspaceId = "w", ArticleInsertionIndex = 1, ArticleWorkflowVersion = 3, CreatedAt = t0 },
        };
        var current = LiteraryMcpWorkflow.SelectCurrent(ws, assets);
        Assert.Equal("cur-0", current[0].Id);
        Assert.Equal("cur-1", current[1].Id);

        // 渲染按标记序号替换，不因为库里多了旧图而错位
        var rendered = LiteraryMcpWorkflow.Render("a\n[插图]: x\nb\n[插图]: y\n",
            current.ToDictionary(kv => kv.Key, kv => $"/img/{kv.Value.Id}.png"), allowRelative: true);
        Assert.Contains("/img/cur-0.png", rendered);
        Assert.Contains("/img/cur-1.png", rendered);
        Assert.DoesNotContain("old-", rendered);
    }

    // ───────────── 端到端：风格 / 水印 / 尺寸 / 批量 ─────────────

    [Fact]
    public async Task 风格水印尺寸可按名称指定_批量入队且重试不重复()
    {
        var (db, name, connection) = NewDb("literary_mcp_presets");
        try
        {
            await db.ReferenceImageConfigs.InsertManyAsync(new[]
            {
                new ReferenceImageConfig { Id = "style-a", AppKey = "literary-agent", CreatedByAdminId = "writer", Name = "默认风", IsActive = true, ImageSha256 = "AAA", Prompt = "默认风格提示" },
                new ReferenceImageConfig { Id = "style-b", AppKey = "literary-agent", CreatedByAdminId = "writer", Name = "全域粉销风格", ImageSha256 = "BBB", Prompt = "粉销风格提示" },
                new ReferenceImageConfig { Id = "style-x", AppKey = "literary-agent", CreatedByAdminId = "other", Name = "全域粉销风格", ImageSha256 = "XXX" },
            });
            await db.WatermarkConfigs.InsertManyAsync(new[]
            {
                new WatermarkConfig { Id = "wm-1", UserId = "writer", Name = "水印配置1", AppKeys = new() },
                new WatermarkConfig { Id = "wm-2", UserId = "writer", Name = "水印配置2", AppKeys = new() { "literary-agent" } },
            });

            var drafts = WithUser(new LiteraryOpenApiController(db), "writer");
            var images = WithUser(new LiteraryImageOpenApiController(db, new FixedModelSelection()), "writer");

            var presets = Data(await images.Presets(CancellationToken.None));
            Assert.Equal("style-a", presets.GetProperty("defaultStyle").GetProperty("styleId").GetString());
            Assert.Equal("wm-2", presets.GetProperty("defaultWatermark").GetProperty("watermarkId").GetString());
            Assert.Equal(2, presets.GetProperty("styles").GetArrayLength()); // 别人的风格不出现
            Assert.Equal(20, presets.GetProperty("maxMarkersPerArticle").GetInt32());

            var created = Data(await drafts.CreateWorkspace(new()
            {
                MarkedContent = "# 秋日书店\n第一段。\n[插图]：书店门口\n第二段。\n【插图】：窗边的猫\n第三段。\n[插图]: 茶杯\n",
                ClientRequestId = "article-1",
            }, CancellationToken.None));
            var id = created.GetProperty("workspaceId").GetString()!;
            Assert.Equal("秋日书店", created.GetProperty("title").GetString()); // 不再是「未命名」
            var version = created.GetProperty("workflowVersion").GetInt32();
            Assert.Equal(3, created.GetProperty("illustrations").GetArrayLength());

            // 不存在的风格给出可选清单，不静默套默认
            var bad = Assert.IsType<BadRequestObjectResult>(await images.Generate(id, new()
            {
                MarkerIndexes = new() { 0 }, WorkflowVersion = version, ClientRequestId = "g-bad", Style = "赛博朋克",
            }, CancellationToken.None));
            Assert.Contains("全域粉销风格", Assert.IsType<ApiResponse<object>>(bad.Value).Error!.Message);

            var request = new LiteraryImageOpenApiController.GenerateRequest
            {
                MarkerIndexes = new() { 0, 1, 2 }, WorkflowVersion = version, ClientRequestId = "g-1",
                Style = "全域粉销风格", Watermark = "水印配置1", Size = "16:9",
            };
            var batch = Data(await images.Generate(id, request, CancellationToken.None));
            Assert.Equal(3, batch.GetProperty("runs").GetArrayLength());
            Assert.Equal("style-b", batch.GetProperty("applied").GetProperty("style").GetProperty("styleId").GetString());
            Assert.Equal("wm-1", batch.GetProperty("applied").GetProperty("watermark").GetProperty("watermarkId").GetString());

            var runs = await db.ImageGenRuns.Find(x => x.WorkspaceId == id).ToListAsync();
            Assert.Equal(3, runs.Count);
            Assert.All(runs, r =>
            {
                Assert.Equal("bbb", r.InitImageAssetSha256);
                Assert.Equal("wm-1", r.WatermarkConfigId);
                Assert.Equal("1376x768", r.Size);
                Assert.StartsWith("粉销风格提示", r.Items[0].Prompt);
                Assert.Equal(AppCallerRegistry.LiteraryAgent.Illustration.Img2Img, r.AppCallerCode);
            });
            Assert.Equal(new[] { 0, 1, 2 }, runs.Select(r => r.ArticleMarkerIndex!.Value).OrderBy(i => i));

            // 原样重试：不多入队
            var retry = Data(await images.Generate(id, request, CancellationToken.None));
            Assert.All(retry.GetProperty("runs").EnumerateArray(), r => Assert.True(r.GetProperty("deduplicated").GetBoolean()));
            Assert.Equal(3, await db.ImageGenRuns.CountDocumentsAsync(x => x.WorkspaceId == id));

            // 同一个幂等键换了尺寸 → 冲突，不回放
            request.Size = "1:1";
            Assert.IsType<ConflictObjectResult>(await images.Generate(id, request, CancellationToken.None));

            // 「重画一张」不再报风格水印：沿用这篇文章上次指定的那套，而不是退回账号默认（蓝色 / 默认水印）
            var redraw = Data(await images.Generate(id, new()
            {
                MarkerIndex = 2, WorkflowVersion = version, ClientRequestId = "g-redraw",
            }, CancellationToken.None));
            var redrawRun = await db.ImageGenRuns.Find(x => x.Id == redraw.GetProperty("runId").GetString()).SingleAsync();
            Assert.Equal("bbb", redrawRun.InitImageAssetSha256);
            Assert.Equal("wm-1", redrawRun.WatermarkConfigId);
            Assert.Equal("1376x768", redrawRun.Size);
            Assert.Equal("remembered", redraw.GetProperty("applied").GetProperty("style").GetProperty("source").GetString());
            Assert.Equal("remembered", redraw.GetProperty("applied").GetProperty("watermark").GetProperty("source").GetString());

            // 只换水印：风格与尺寸照旧沿用，水印改成新指定的并被记住
            var onlyWm = Data(await images.Generate(id, new()
            {
                MarkerIndex = 0, WorkflowVersion = version, ClientRequestId = "g-only-wm", Watermark = "水印配置2",
            }, CancellationToken.None));
            var onlyWmRun = await db.ImageGenRuns.Find(x => x.Id == onlyWm.GetProperty("runId").GetString()).SingleAsync();
            Assert.Equal("bbb", onlyWmRun.InitImageAssetSha256);
            Assert.Equal("wm-2", onlyWmRun.WatermarkConfigId);
            var prefs = (await db.ImageMasterWorkspaces.Find(x => x.Id == id).SingleAsync()).IllustrationPrefs!;
            Assert.Equal("style-b", prefs.StyleId);
            Assert.Equal("wm-2", prefs.WatermarkId);
            Assert.Equal("1376x768", prefs.Size);
            // 读工作区能看到记住的选择
            var read = Data(await drafts.GetWorkspace(id, 0, 0, CancellationToken.None));
            Assert.Equal("style-b", read.GetProperty("illustrationPrefs").GetProperty("styleId").GetString());

            // 记住的风格被删了：不报错卡住，也不静默换——回执写明改用了账号默认
            await db.ReferenceImageConfigs.DeleteOneAsync(x => x.Id == "style-b");
            var fallback = Data(await images.Generate(id, new()
            {
                MarkerIndex = 1, WorkflowVersion = version, ClientRequestId = "g-fallback",
            }, CancellationToken.None));
            var fallbackRun = await db.ImageGenRuns.Find(x => x.Id == fallback.GetProperty("runId").GetString()).SingleAsync();
            Assert.Equal("aaa", fallbackRun.InitImageAssetSha256);
            Assert.Equal("account-default", fallback.GetProperty("applied").GetProperty("style").GetProperty("source").GetString());
            Assert.Contains("已不存在", fallback.GetProperty("applied").GetProperty("notes")[0].GetString());

            // 从没指定过的文章：不传就是账号默认，入队时把账号绑定的水印钉进任务
            var fresh = Data(await drafts.CreateWorkspace(new()
            {
                MarkedContent = "另一篇。\n[插图]: 灯塔\n", ClientRequestId = "article-2",
            }, CancellationToken.None));
            var freshId = fresh.GetProperty("workspaceId").GetString()!;
            var single = Data(await images.Generate(freshId, new()
            {
                MarkerIndex = 0, WorkflowVersion = 1, ClientRequestId = "g-default",
            }, CancellationToken.None));
            var defaultRun = await db.ImageGenRuns.Find(x => x.Id == single.GetProperty("runId").GetString()).SingleAsync();
            Assert.Equal("wm-2", defaultRun.WatermarkConfigId);
            Assert.Equal("aaa", defaultRun.InitImageAssetSha256);
            Assert.Equal("account-default", single.GetProperty("applied").GetProperty("style").GetProperty("source").GetString());
            Assert.Null((await db.ImageMasterWorkspaces.Find(x => x.Id == freshId).SingleAsync()).IllustrationPrefs);

            // none 明确不打水印、不用参考图
            var none = Data(await images.Generate(freshId, new()
            {
                MarkerIndex = 0, WorkflowVersion = 1, ClientRequestId = "g-none", Style = "none", Watermark = "none",
            }, CancellationToken.None));
            var noneRun = await db.ImageGenRuns.Find(x => x.Id == none.GetProperty("runId").GetString()).SingleAsync();
            Assert.Equal(WatermarkSelection.None, noneRun.WatermarkConfigId);
            Assert.Null(noneRun.InitImageAssetSha256);
            Assert.Equal(AppCallerRegistry.LiteraryAgent.Illustration.Text2Img, noneRun.AppCallerCode);
        }
        finally { await new MongoClient(connection).DropDatabaseAsync(name); }
    }

    [Fact]
    public void 批量生图按标记数占额度_网关与控制器同一口径()
    {
        Assert.Equal(3, McpGatewayController.ReadLiteraryImageCount(JsonNode.Parse("""{"markerIndexes":[0,1,2,2]}""")!.AsObject()));
        Assert.Equal(1, McpGatewayController.ReadLiteraryImageCount(JsonNode.Parse("""{"markerIndex":0}""")!.AsObject()));
        Assert.Equal(3, LiteraryImageOpenApiController.RequestedImageCount(null, new[] { 0, 1, 2 }));
    }

    // ───────────── 端到端：改稿后重新配图、历史配图不丢 ─────────────

    [Fact]
    public async Task 改稿可带标记重新配图_旧图保留进历史()
    {
        var (db, name, connection) = NewDb("literary_mcp_rewrite");
        try
        {
            var drafts = WithUser(new LiteraryOpenApiController(db), "writer");
            var id = Data(await drafts.CreateWorkspace(new()
            {
                Title = "改稿", MarkedContent = "第一段。\n[插图]: 书店\n", ClientRequestId = "c-1",
            }, CancellationToken.None)).GetProperty("workspaceId").GetString()!;
            // 模拟旧版本已出一张图、以及一张改造前没有版本号的历史图
            await db.ImageAssets.InsertManyAsync(new[]
            {
                new ImageAsset { Id = "v1-0", OwnerUserId = "writer", WorkspaceId = id, ArticleInsertionIndex = 0, ArticleWorkflowVersion = 1, Url = "https://example.test/v1.png" },
                new ImageAsset { Id = "legacy-0", OwnerUserId = "writer", WorkspaceId = id, ArticleInsertionIndex = 0, Url = "https://example.test/legacy.png" },
            });

            // 追加时不许带标记
            Assert.IsType<BadRequestObjectResult>(await drafts.WriteContent(id, new()
            {
                MarkedContent = "续写\n[插图]: 猫\n", Mode = "append",
            }, CancellationToken.None));

            var written = Data(await drafts.WriteContent(id, new()
            {
                MarkedContent = "改过的第一段。\n[插图]：雨中的书店\n新第二段。\n[插图]: 窗边的猫\n",
            }, CancellationToken.None));
            Assert.Equal(2, written.GetProperty("workflowVersion").GetInt32());
            Assert.Equal(2, written.GetProperty("illustrations").GetArrayLength());

            var ws = await db.ImageMasterWorkspaces.Find(x => x.Id == id).SingleAsync();
            Assert.Equal(2, ws.ArticleWorkflow!.Markers.Count);
            Assert.Equal("雨中的书店", ws.ArticleWorkflow.Markers[0].Text);
            Assert.DoesNotContain("[插图]", ws.ArticleContent);

            // 旧图一张没删；没版本号的那张被归到旧版本，不会被猜回新标记上
            Assert.Equal(2, await db.ImageAssets.CountDocumentsAsync(x => x.WorkspaceId == id));
            Assert.Equal(1, (await db.ImageAssets.Find(x => x.Id == "legacy-0").SingleAsync()).ArticleWorkflowVersion);
            var read = Data(await drafts.GetWorkspace(id, 0, 0, CancellationToken.None, "illustrated"));
            Assert.All(read.GetProperty("illustrations").EnumerateArray(), m => Assert.Equal(JsonValueKind.Null, m.GetProperty("url").ValueKind));
            Assert.Equal(2, read.GetProperty("historyImageCount").GetInt32());
            Assert.DoesNotContain("example.test", read.GetProperty("content").GetString());

            // 页面「历史配图」列出全部，按版本分组
            var ui = WithAdminUser(new LiteraryAgentWorkspaceController(db, null!, NullLogger<LiteraryAgentWorkspaceController>.Instance), "writer");
            var history = Data(await ui.GetIllustrationHistory(id, CancellationToken.None));
            Assert.Equal(2, history.GetProperty("total").GetInt32());
            Assert.Equal(0, history.GetProperty("currentCount").GetInt32());
            Assert.Contains(history.GetProperty("groups").EnumerateArray(), g => g.GetProperty("workflowVersion").GetInt32() == 1);
        }
        finally { await new MongoClient(connection).DropDatabaseAsync(name); }
    }

    [Fact]
    public async Task 网页上重新上传正文_旧标记失效并升版_旧图进历史()
    {
        // 文学页的 PUT 此前只改正文：旧标记与带标记正文原样挂在新正文上，刷新后又回到旧状态。
        var (db, name, connection) = NewDb("literary_web_put");
        try
        {
            var drafts = WithUser(new LiteraryOpenApiController(db), "writer");
            var id = Data(await drafts.CreateWorkspace(new()
            {
                Title = "网页改稿", MarkedContent = "旧正文。\n[插图]: 书店\n", ClientRequestId = "w-1",
            }, CancellationToken.None)).GetProperty("workspaceId").GetString()!;
            await db.ImageAssets.InsertOneAsync(new ImageAsset
            {
                Id = "old-web", OwnerUserId = "writer", WorkspaceId = id, ArticleInsertionIndex = 0, Url = "https://example.test/old.png",
            });

            var ui = WithAdminUser(new LiteraryAgentWorkspaceController(db, null!, NullLogger<LiteraryAgentWorkspaceController>.Instance), "writer");
            Assert.IsType<OkObjectResult>(await ui.UpdateWorkspace(id, new UpdateWorkspaceRequest { ArticleContent = "全新上传的正文。", Title = "新标题" }, CancellationToken.None));

            var ws = await db.ImageMasterWorkspaces.Find(x => x.Id == id).SingleAsync();
            Assert.Equal(2, ws.ArticleWorkflow!.Version);
            Assert.Empty(ws.ArticleWorkflow.Markers);
            Assert.Null(ws.ArticleContentWithMarkers);
            Assert.Equal("新标题", ws.Title);
            Assert.Equal(1, (await db.ImageAssets.Find(x => x.Id == "old-web").SingleAsync()).ArticleWorkflowVersion);

            // 正文没变只改标题：不升版
            Assert.IsType<OkObjectResult>(await ui.UpdateWorkspace(id, new UpdateWorkspaceRequest { ArticleContent = "全新上传的正文。", Title = "再改标题" }, CancellationToken.None));
            Assert.Equal(2, (await db.ImageMasterWorkspaces.Find(x => x.Id == id).SingleAsync()).ArticleWorkflow!.Version);
        }
        finally { await new MongoClient(connection).DropDatabaseAsync(name); }
    }

    // ───────────── 网页定向写：不再整份覆盖 ─────────────

    [Fact]
    public async Task 网页改一个标记不会抹掉其它标记的任务与图片指针()
    {
        var (db, name, connection) = NewDb("literary_marker_patch");
        try
        {
            var ws = new ImageMasterWorkspace
            {
                OwnerUserId = "writer", ScenarioType = "article-illustration",
                ArticleWorkflow = new()
                {
                    Version = 4,
                    Markers = new() { new() { Index = 0, Status = "idle" }, new() { Index = 1, Status = "idle" } },
                },
            };
            await db.ImageMasterWorkspaces.InsertOneAsync(ws);
            // 智能体在页面读完之后，认领了标记 1 并写入了指针（页面手里那份快照看不到）
            await db.ImageMasterWorkspaces.UpdateOneAsync(x => x.Id == ws.Id,
                Builders<ImageMasterWorkspace>.Update.Set("articleWorkflow.markers.1.runId", "mcp-run")
                    .Set("articleWorkflow.markers.1.status", "running")
                    .Set("articleWorkflow.assetIdByMarkerIndex.1", "mcp-asset"));

            Assert.True(await LiteraryMarkerWrites.PatchMarkerAsync(db, ws.Id, 4, 0,
                new Dictionary<string, object?> { ["status"] = "parsed", ["draftText"] = "新描述" }, null));
            var after = (await db.ImageMasterWorkspaces.Find(x => x.Id == ws.Id).SingleAsync()).ArticleWorkflow!;
            Assert.Equal("parsed", after.Markers[0].Status);
            Assert.Equal("mcp-run", after.Markers[1].RunId);
            Assert.Equal("running", after.Markers[1].Status);
            Assert.Equal("mcp-asset", after.AssetIdByMarkerIndex["1"]);

            // 版本已变（期间被改稿）→ 不写，调用方重读
            Assert.False(await LiteraryMarkerWrites.PatchMarkerAsync(db, ws.Id, 3, 0,
                new Dictionary<string, object?> { ["status"] = "error" }, null));

            Assert.True(await LiteraryMarkerWrites.PointMarkerAsync(db, ws.Id, 4, 0, "web-asset"));
            after = (await db.ImageMasterWorkspaces.Find(x => x.Id == ws.Id).SingleAsync()).ArticleWorkflow!;
            Assert.Equal("web-asset", after.AssetIdByMarkerIndex["0"]);
            Assert.Equal("mcp-asset", after.AssetIdByMarkerIndex["1"]);
            Assert.Equal(2, after.DoneImageCount);
            Assert.Equal("done", after.Markers[0].Status);
        }
        finally { await new MongoClient(connection).DropDatabaseAsync(name); }
    }

    [Fact]
    public void 网页换版的三处入口不再硬删配图()
    {
        // 行为已由上面的端到端覆盖；这里守「网页入口没有退回删除」——那三处以前各自 DeleteMany/DeleteOne。
        var root = FindRepoRoot();
        var master = File.ReadAllText(Path.Combine(root, "prd-api/src/PrdAgent.Api/Controllers/Api/ImageMasterController.cs"));
        var literary = File.ReadAllText(Path.Combine(root, "prd-api/src/PrdAgent.Api/Controllers/Api/LiteraryAgentWorkspaceController.cs"));
        Assert.DoesNotContain("DeleteManyAsync(x => x.WorkspaceId == wid && x.ArticleInsertionIndex != null", master);
        Assert.DoesNotContain("Filter.Eq(x => x.ArticleInsertionIndex, asset.ArticleInsertionIndex)", literary);
        Assert.Equal(2, CountOf(master, "LiteraryIllustrationArchive.StampUnversionedAsync(_db, wid, ws.ArticleWorkflow?.Version ?? 0)"));

        // 水印选择要真的走到打水印那一层：Worker 透传、客户端读取
        var worker = File.ReadAllText(Path.Combine(root, "prd-api/src/PrdAgent.Api/Services/ImageGenRunWorker.cs"));
        var client = File.ReadAllText(Path.Combine(root, "prd-api/src/PrdAgent.Infrastructure/LLM/OpenAIImageClient.cs"));
        Assert.Contains("WatermarkConfigId: run.WatermarkConfigId", worker);
        Assert.Contains("Current?.WatermarkConfigId", client);
    }

    private static int CountOf(string text, string needle)
    {
        var count = 0;
        for (var i = text.IndexOf(needle, StringComparison.Ordinal); i >= 0; i = text.IndexOf(needle, i + needle.Length, StringComparison.Ordinal)) count++;
        return count;
    }

    private static string FindRepoRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir != null && !Directory.Exists(Path.Combine(dir.FullName, "prd-api", "src"))) dir = dir.Parent;
        return dir?.FullName ?? throw new InvalidOperationException("找不到仓库根目录");
    }

    private static (MongoDbContext db, string name, string connection) NewDb(string prefix)
    {
        var connection = Environment.GetEnvironmentVariable("MONGODB_TEST_CONNECTION") ?? "mongodb://127.0.0.1:27017";
        var name = $"{prefix}_{Guid.NewGuid():N}";
        return (new MongoDbContext(connection, name), name, connection);
    }

    private static T WithUser<T>(T controller, string id) where T : ControllerBase
    {
        controller.ControllerContext = new() { HttpContext = new DefaultHttpContext() };
        controller.HttpContext.User = new ClaimsPrincipal(new ClaimsIdentity(new[]
        {
            new Claim("boundUserId", id), new Claim("agentApiKeyId", "key-" + id),
            new Claim("scope", McpCapabilityCatalog.ScopeLiteraryUse),
        }, "ApiKey"));
        controller.Request.Scheme = "https";
        controller.Request.Host = new HostString("example.test");
        return controller;
    }

    private static T WithAdminUser<T>(T controller, string id) where T : ControllerBase
    {
        controller.ControllerContext = new() { HttpContext = new DefaultHttpContext() };
        controller.HttpContext.User = new ClaimsPrincipal(new ClaimsIdentity(new[]
        {
            new Claim("sub", id), new Claim(ClaimTypes.NameIdentifier, id),
        }, "Bearer"));
        return controller;
    }

    private static JsonElement Data(IActionResult result) => JsonSerializer.SerializeToElement(
        Assert.IsType<ApiResponse<object>>(Assert.IsType<OkObjectResult>(result).Value).Data);

    private sealed class FixedModelSelection : ILiteraryMcpModelSelectionService
    {
        public Task<LiteraryMcpModelSelection> ResolveForRunAsync(
            string ownerUserId, string agentApiKeyId, string appCallerCode, CancellationToken ct)
            => Task.FromResult(LiteraryMcpModelSelection.Selected("gpt-image-2"));

        public Task<LiteraryMcpModelSelection> ValidateFixedModelAsync(string logicalModelPublicId, CancellationToken ct)
            => Task.FromResult(LiteraryMcpModelSelection.Selected(logicalModelPublicId));
    }
}
