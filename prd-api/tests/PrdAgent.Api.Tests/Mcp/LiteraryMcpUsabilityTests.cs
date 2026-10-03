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
using PrdAgent.Infrastructure.LlmGateway;
using PrdAgent.Infrastructure.Services;
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

    [Fact]
    public void 改造前的旧图_只重画一张其余照样挂着()
    {
        // 改造前的文章：图都没盖版本号、也没有挂图指针。重画第 2 张后它带了版本号，
        // 以前「工作区出现任何带版本的图就整体不再兜底」，第 1 张从正文、导出、投稿里一起消失。
        var ws = new ImageMasterWorkspace
        {
            Id = "w",
            ArticleWorkflow = new() { Version = 1, Markers = new() { new() { Index = 0 }, new() { Index = 1 } } },
        };
        var t0 = DateTime.UtcNow;
        var assets = new List<ImageAsset>
        {
            new() { Id = "legacy-0", WorkspaceId = "w", ArticleInsertionIndex = 0, CreatedAt = t0 },
            new() { Id = "legacy-1", WorkspaceId = "w", ArticleInsertionIndex = 1, CreatedAt = t0 },
            new() { Id = "redrawn-1", WorkspaceId = "w", ArticleInsertionIndex = 1, ArticleWorkflowVersion = 1, CreatedAt = t0.AddMinutes(3) },
        };
        var current = LiteraryMcpWorkflow.SelectCurrent(ws, assets);
        Assert.Equal("legacy-0", current[0].Id);
        Assert.Equal("redrawn-1", current[1].Id);
    }

    [Fact]
    public void 连着两次换纯正文后_带标记写回仍能接上最近一组在用的图()
    {
        // 最近那份存档来自第二次换纯正文，那一版没有标记、是空的；要往前找最近一份真能接上的
        var ws = new ImageMasterWorkspace
        {
            Id = "w",
            ArticleWorkflow = new() { Version = 3, Markers = new() },
            ArticleWorkflowHistory = new()
            {
                new() { Version = 2, Markers = new(), ArchivedAt = DateTime.UtcNow, ArchivedReason = LiteraryArchiveReason.WebContent },
                new()
                {
                    Version = 1, ArchivedAt = DateTime.UtcNow.AddMinutes(-5), ArchivedReason = LiteraryArchiveReason.WebContent,
                    Markers = new() { new() { Index = 0, Text = "书店门口" }, new() { Index = 1, Text = "窗边的猫" } },
                    AssetIdByMarkerIndex = new() { ["0"] = "a0", ["1"] = "a1" },
                },
            },
        };
        var assets = new List<ImageAsset>
        {
            new() { Id = "a0", WorkspaceId = "w", ArticleInsertionIndex = 0, ArticleWorkflowVersion = 1 },
            new() { Id = "a1", WorkspaceId = "w", ArticleInsertionIndex = 1, ArticleWorkflowVersion = 1 },
        };
        var next = LiteraryMcpWorkflow.Prepare("一。\n[插图]: 书店门口\n二。\n[插图]: 窗边的猫\n", 4);
        var carried = LiteraryMcpWorkflow.CarryOverUnchanged(next, ws, assets, DateTime.UtcNow);
        Assert.Equal(new[] { 0, 1 }, carried);
        Assert.Equal("a0", next.AssetIdByMarkerIndex["0"]);
    }

    [Fact]
    public void 生图额度退还_网关与直连同一个算法()
    {
        var day = DateTime.UtcNow.Date;
        var image = McpQuotaVerdict.Reserved(McpUsageService.KindImage, 3, day);
        Assert.Equal(3, McpUsageService.UnqueuedImages(image, 0));   // 整批重放
        Assert.Equal(2, McpUsageService.UnqueuedImages(image, 1));   // 部分重放 / 没排上
        Assert.Equal(0, McpUsageService.UnqueuedImages(image, 3));
        Assert.Equal(0, McpUsageService.UnqueuedImages(image, null)); // 下游没报就不退
        Assert.Equal(0, McpUsageService.UnqueuedImages(McpQuotaVerdict.Reserved(McpUsageService.KindWrite, 1, day), 0));

        // 直连那条路读控制器回执的口径，与网关读响应体的口径一致
        Assert.Equal(1, PrdAgent.Api.Filters.AgentApiKeyUsageFilter.QueuedImagesOf(
            new OkObjectResult(ApiResponse<object>.Ok(new { runs = new[] { 1 }, queuedImages = 1 }))));
        Assert.Null(PrdAgent.Api.Filters.AgentApiKeyUsageFilter.QueuedImagesOf(new OkObjectResult(ApiResponse<object>.Ok(new { runId = "r" }))));

        // 接线：两条路都必须调用这个算法，删掉任何一处调用这条用例都会红
        var root = FindRepoRoot();
        foreach (var rel in new[] { "prd-api/src/PrdAgent.Api/Controllers/McpGatewayController.cs", "prd-api/src/PrdAgent.Api/Filters/AgentApiKeyUsageFilter.cs" })
            Assert.Contains("McpUsageService.UnqueuedImages(", File.ReadAllText(Path.Combine(root, rel)));
    }

    [Fact]
    public async Task 编辑页详情与历史配图_按当前实际挂图返回()
    {
        var (db, name, connection) = NewDb("literary_detail_current");
        try
        {
            var drafts = WithUser(new LiteraryOpenApiController(db), "writer");
            var id = Data(await drafts.CreateWorkspace(new()
            {
                MarkedContent = "一。\n[插图]: 书店门口\n二。\n[插图]: 窗边的猫\n", ClientRequestId = "detail",
            }, CancellationToken.None)).GetProperty("workspaceId").GetString()!;
            var t0 = DateTime.UtcNow;
            // 改造前的旧图（无版本号、无指针）+ 只重画了第 2 张（带版本、有指针）
            await db.ImageAssets.InsertManyAsync(new[]
            {
                new ImageAsset { Id = "legacy-0", OwnerUserId = "writer", WorkspaceId = id, ArticleInsertionIndex = 0, Url = "https://example.test/l0.png", CreatedAt = t0 },
                new ImageAsset { Id = "legacy-1", OwnerUserId = "writer", WorkspaceId = id, ArticleInsertionIndex = 1, Url = "https://example.test/l1.png", CreatedAt = t0 },
                new ImageAsset { Id = "redrawn-1", OwnerUserId = "writer", WorkspaceId = id, ArticleInsertionIndex = 1, ArticleWorkflowVersion = 1, Url = "https://example.test/r1.png", CreatedAt = t0.AddMinutes(2) },
            });
            await LiteraryMarkerWrites.PointMarkerAsync(db, id, 1, 1, "redrawn-1");

            var ui = WithAdminUser(new LiteraryAgentWorkspaceController(db, null!, NullLogger<LiteraryAgentWorkspaceController>.Instance), "writer");
            var ids = Data(await ui.GetWorkspaceDetail(id)).GetProperty("assets").EnumerateArray().Select(a => a.GetProperty("id").GetString()).ToList();
            Assert.Equal(new[] { "legacy-0", "redrawn-1" }, ids); // 刷新后第 1 张不再变成没图，被换下的 legacy-1 不混进来

            // 把第 1 张的旧图放到第 2 个位置：历史里它报的是现在挂的位置，不是生成时的位置
            Data(await drafts.RestoreImage(id, 1, new() { AssetId = "legacy-0", WorkflowVersion = 1 }, CancellationToken.None));
            var history = Data(await drafts.GetHistory(id, CancellationToken.None)).GetProperty("images").EnumerateArray().ToList();
            var moved = history.Single(i => i.GetProperty("assetId").GetString() == "legacy-0");
            Assert.True(moved.GetProperty("isCurrent").GetBoolean());
            Assert.Equal(1, moved.GetProperty("markerIndex").GetInt32());
            // 作品详情同样按挂的位置报：两个位置各一张、序号 0 和 1，不再两张都报生成时的 0
            await db.Submissions.InsertOneAsync(new Submission { Id = "sub-detail", OwnerUserId = "writer", ContentType = "literary", WorkspaceId = id, IsPublic = true });
            var subs = WithAdminUser(new SubmissionsController(db, null!, NullLogger<SubmissionsController>.Instance), "writer");
            var related = Data(await subs.GetSubmissionDetail("sub-detail")).GetProperty("relatedAssets").EnumerateArray().ToList();
            Assert.Equal(new[] { 0, 1 }, related.Select(a => a.GetProperty("articleInsertionIndex").GetInt32()).ToArray());
            Assert.All(related, a => Assert.Equal("legacy-0", a.GetProperty("id").GetString()));

            // 整篇换成全新的标记、新版本还没出图：指针表是空的，旧图都保留着，详情不能把它们当成当前图返回
            Data(await drafts.WriteContent(id, new() { MarkedContent = "全新的一段。\n[插图]: 海边的灯塔\n" }, CancellationToken.None));
            Assert.Empty(Data(await ui.GetWorkspaceDetail(id)).GetProperty("assets").EnumerateArray());
            Assert.Contains(Data(await drafts.GetHistory(id, CancellationToken.None)).GetProperty("images").EnumerateArray(),
                i => i.GetProperty("assetId").GetString() == "redrawn-1"); // 旧图仍能在历史里找到
        }
        finally { await new MongoClient(connection).DropDatabaseAsync(name); }
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
            Assert.Equal(3, batch.GetProperty("queuedImages").GetInt32());
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
            // 整批都是重放：根上标出去重、真正入队 0 张，网关据此把预占的 3 张额度全退回
            Assert.True(retry.GetProperty("deduplicated").GetBoolean());
            Assert.Equal(0, retry.GetProperty("queuedImages").GetInt32());
            Assert.True(McpArtifactExtractor.IsDeduplicated(JsonSerializer.Serialize(new { success = true, data = retry })));
            Assert.Equal(1, McpArtifactExtractor.QueuedImages("{\"success\":true,\"data\":{\"queuedImages\":1}}"));
            Assert.Null(McpArtifactExtractor.QueuedImages("{\"success\":true,\"data\":{}}"));

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

            // 点名的风格在重试前被删了：同一个 clientRequestId 照样回放原任务，不报「风格不存在」
            request.Size = "16:9";
            var replayAfterDelete = Data(await images.Generate(id, request, CancellationToken.None));
            Assert.True(replayAfterDelete.GetProperty("deduplicated").GetBoolean());
            Assert.Equal(JsonValueKind.Null, replayAfterDelete.GetProperty("applied").ValueKind);

            // 只写明确指定的那一项：入队期间网页顶栏改了水印，不会被读到的旧快照改回去
            await db.ImageMasterWorkspaces.UpdateOneAsync(x => x.Id == id, Builders<ImageMasterWorkspace>.Update.Set(x => x.IllustrationPrefs!.WatermarkId, "wm-web"));
            await LiteraryIllustrationChoices.RememberExplicitAsync(db, id, "writer", "style-a", null, null);
            var kept = (await db.ImageMasterWorkspaces.Find(x => x.Id == id).SingleAsync()).IllustrationPrefs!;
            Assert.Equal(("style-a", "wm-web", "1376x768"), (kept.StyleId, kept.WatermarkId, kept.Size));

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

            // 账号默认水印在重试前换了：没点名的项不算请求本身，同一个 clientRequestId 照样回放
            await db.WatermarkConfigs.UpdateOneAsync(x => x.Id == "wm-2", Builders<WatermarkConfig>.Update.Set(x => x.AppKeys, new List<string>()));
            await db.WatermarkConfigs.UpdateOneAsync(x => x.Id == "wm-1", Builders<WatermarkConfig>.Update.Set(x => x.AppKeys, new List<string> { "literary-agent" }));
            var replayAfterDefault = Data(await images.Generate(freshId, new()
            {
                MarkerIndex = 0, WorkflowVersion = 1, ClientRequestId = "g-default",
            }, CancellationToken.None));
            Assert.True(replayAfterDefault.GetProperty("deduplicated").GetBoolean());
            Assert.Equal(defaultRun.Id, replayAfterDefault.GetProperty("runId").GetString());

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

    [Fact]
    public async Task 改一节正文只重画改动的那一节_其余沿用原图()
    {
        // 验收里撞出来的：只压缩第二节，整篇 6 张图全部作废重画，用户满意的图一起被换掉
        var (db, name, connection) = NewDb("literary_carry_over");
        try
        {
            var drafts = WithUser(new LiteraryOpenApiController(db), "writer");
            var id = Data(await drafts.CreateWorkspace(new()
            {
                Title = "沿用", MarkedContent = "一。\n[插图]: 书店门口\n二。\n[插图]: 窗边的猫\n三。\n[插图]: 茶杯\n", ClientRequestId = "co-1",
            }, CancellationToken.None)).GetProperty("workspaceId").GetString()!;
            var ws = await db.ImageMasterWorkspaces.Find(x => x.Id == id).SingleAsync();
            ws.ArticleWorkflow!.AssetIdByMarkerIndex = new() { ["0"] = "a0", ["1"] = "a1", ["2"] = "a2" };
            await db.ImageMasterWorkspaces.ReplaceOneAsync(x => x.Id == id, ws);
            await db.ImageAssets.InsertManyAsync(new[] { 0, 1, 2 }.Select(i => new ImageAsset
            {
                Id = $"a{i}", OwnerUserId = "writer", WorkspaceId = id, ArticleInsertionIndex = i, ArticleWorkflowVersion = 1,
                Url = $"https://example.test/a{i}.png",
            }));

            var written = Data(await drafts.WriteContent(id, new()
            {
                MarkedContent = "一。\n[插图]：书店门口\n二改短了。\n[插图]: 窗边打盹的橘猫\n三。\n[插图]:  茶杯 \n",
            }, CancellationToken.None));
            Assert.Equal(new[] { 0, 2 }, written.GetProperty("reusedImages").EnumerateArray().Select(x => x.GetInt32()));
            Assert.Equal(new[] { 1 }, written.GetProperty("needsGeneration").EnumerateArray().Select(x => x.GetInt32()));

            var read = Data(await drafts.GetWorkspace(id, 0, 0, CancellationToken.None, "illustrated"));
            var ill = read.GetProperty("illustrations").EnumerateArray().ToList();
            Assert.Equal("https://example.test/a0.png", ill[0].GetProperty("url").GetString());
            Assert.Equal(JsonValueKind.Null, ill[1].GetProperty("url").ValueKind);
            Assert.Equal("https://example.test/a2.png", ill[2].GetProperty("url").GetString());
            Assert.Equal(1, read.GetProperty("historyImageCount").GetInt32());
            Assert.Contains("a0.png", read.GetProperty("content").GetString());
            Assert.Contains("a2.png", read.GetProperty("content").GetString());
        }
        finally { await new MongoClient(connection).DropDatabaseAsync(name); }
    }

    [Fact]
    public async Task 网页改过的描述智能体读得到_整篇重写不冲掉也不错配图()
    {
        // 验收里撞出来的：客户在网页上改了第一张的描述并重画，智能体读稿拿到的还是原始描述，
        // 整篇重写把描述改了回去，却凭原始描述把按新描述画的图接了回来——图和描述对不上
        var (db, name, connection) = NewDb("literary_effective_prompt");
        try
        {
            var drafts = WithUser(new LiteraryOpenApiController(db), "writer");
            async Task<string> Seed(string requestId)
            {
                var id = Data(await drafts.CreateWorkspace(new()
                {
                    Title = "描述", MarkedContent = "一。\n[插图]: 书店门口\n二。\n[插图]: 窗边的猫\n", ClientRequestId = requestId,
                }, CancellationToken.None)).GetProperty("workspaceId").GetString()!;
                var ws = await db.ImageMasterWorkspaces.Find(x => x.Id == id).SingleAsync();
                ws.ArticleWorkflow!.Markers[1].DraftText = "窗边打盹的橘猫"; // 网页编辑只写 DraftText
                ws.ArticleWorkflow.AssetIdByMarkerIndex = new() { ["0"] = $"{id}-a0", ["1"] = $"{id}-a1" };
                await db.ImageMasterWorkspaces.ReplaceOneAsync(x => x.Id == id, ws);
                await db.ImageAssets.InsertManyAsync(new[] { 0, 1 }.Select(i => new ImageAsset
                {
                    Id = $"{id}-a{i}", OwnerUserId = "writer", WorkspaceId = id, ArticleInsertionIndex = i, ArticleWorkflowVersion = 1,
                    Url = $"https://example.test/{id}-a{i}.png",
                }));
                return id;
            }

            var id = await Seed("ep-1");
            var read = Data(await drafts.GetWorkspace(id, 0, 0, CancellationToken.None));
            Assert.Equal("窗边打盹的橘猫", read.GetProperty("illustrations").EnumerateArray().ElementAt(1).GetProperty("prompt").GetString());

            // 照读到的描述原样写回：两张都沿用
            var kept = Data(await drafts.WriteContent(id, new()
            {
                MarkedContent = "一。\n[插图]: 书店门口\n二改短了。\n[插图]: 窗边打盹的橘猫\n",
            }, CancellationToken.None));
            Assert.Equal(new[] { 0, 1 }, kept.GetProperty("reusedImages").EnumerateArray().Select(x => x.GetInt32()));
            Assert.Equal("窗边打盹的橘猫", kept.GetProperty("illustrations").EnumerateArray().ElementAt(1).GetProperty("prompt").GetString());

            // 拿过期的原始描述写回：按新描述画的那张不许接回去，老实标成要重画
            var stale = await Seed("ep-2");
            var rewritten = Data(await drafts.WriteContent(stale, new()
            {
                MarkedContent = "一。\n[插图]: 书店门口\n二。\n[插图]: 窗边的猫\n",
            }, CancellationToken.None));
            Assert.Equal(new[] { 0 }, rewritten.GetProperty("reusedImages").EnumerateArray().Select(x => x.GetInt32()));
            Assert.Equal(new[] { 1 }, rewritten.GetProperty("needsGeneration").EnumerateArray().Select(x => x.GetInt32()));
        }
        finally { await new MongoClient(connection).DropDatabaseAsync(name); }
    }

    [Fact]
    public async Task 智能体按当前描述读带标记全文_只改一张描述_能从历史放回旧图()
    {
        // 验收里智能体的原话：读稿去掉了标记只能靠空行猜位置；改一张描述只能整篇重写；
        // 沿用的图 runId 变空看不出来历；想换回旧图没有工具，只能让用户去网页（网页其实也没有）
        var (db, name, connection) = NewDb("literary_lit05");
        try
        {
            var drafts = WithUser(new LiteraryOpenApiController(db), "writer");
            var id = Data(await drafts.CreateWorkspace(new()
            {
                Title = "五号债", MarkedContent = "一。\n[插图]: 书店门口\n二。\n[插图]: 窗边的猫\n", ClientRequestId = "lit05",
            }, CancellationToken.None)).GetProperty("workspaceId").GetString()!;
            var ws = await db.ImageMasterWorkspaces.Find(x => x.Id == id).SingleAsync();
            ws.ArticleWorkflow!.AssetIdByMarkerIndex = new() { ["0"] = "a0", ["1"] = "a1" };
            ws.ArticleWorkflow.Markers[0].RunId = "run-0";
            await db.ImageMasterWorkspaces.ReplaceOneAsync(x => x.Id == id, ws);
            await db.ImageAssets.InsertManyAsync(new[]
            {
                new ImageAsset { Id = "a0", OwnerUserId = "writer", WorkspaceId = id, ArticleInsertionIndex = 0, ArticleWorkflowVersion = 1, Url = "https://example.test/a0.png", OriginalMarkerText = "书店门口" },
                new ImageAsset { Id = "a1", OwnerUserId = "writer", WorkspaceId = id, ArticleInsertionIndex = 1, ArticleWorkflowVersion = 1, Url = "https://example.test/a1.png", OriginalMarkerText = "窗边的猫" },
            });

            // 只改一张描述：正文与另一张不动；拿过期配图版本、或读稿后被网页改过（版本令牌不符）都要 409
            var token = Data(await drafts.GetWorkspace(id, 0, 0, CancellationToken.None)).GetProperty("updatedAt").GetString();
            Assert.IsType<ConflictObjectResult>(await drafts.UpdateIllustrationPrompt(id, 1, new() { Prompt = "窗边打盹的橘猫", WorkflowVersion = 9, ExpectedUpdatedAt = token }, CancellationToken.None));
            Assert.IsType<BadRequestObjectResult>(await drafts.UpdateIllustrationPrompt(id, 1, new() { Prompt = "窗边打盹的橘猫", WorkflowVersion = 1 }, CancellationToken.None));
            await LiteraryMarkerWrites.PatchMarkerAsync(db, id, 1, 0, new Dictionary<string, object?> { ["draftText"] = "书店门口的雨" }, null); // 网页上改了另一张
            Assert.IsType<ConflictObjectResult>(await drafts.UpdateIllustrationPrompt(id, 1, new() { Prompt = "窗边打盹的橘猫", WorkflowVersion = 1, ExpectedUpdatedAt = token }, CancellationToken.None));
            await LiteraryMarkerWrites.PatchMarkerAsync(db, id, 1, 0, new Dictionary<string, object?> { ["draftText"] = "书店门口" }, null);
            token = Data(await drafts.GetWorkspace(id, 0, 0, CancellationToken.None)).GetProperty("updatedAt").GetString();
            Data(await drafts.UpdateIllustrationPrompt(id, 1, new() { Prompt = "窗边打盹的橘猫", WorkflowVersion = 1, ExpectedUpdatedAt = token }, CancellationToken.None));

            // format=marked：标记就在原位，写的是当前描述
            var marked = Data(await drafts.GetWorkspace(id, 0, 0, CancellationToken.None, "marked"));
            Assert.Equal("marked", marked.GetProperty("format").GetString());
            Assert.Equal("一。\n[插图]: 书店门口\n二。\n[插图]: 窗边打盹的橘猫\n", marked.GetProperty("content").GetString());

            // 按新描述出了新图，原样写回读到的全文：两张都沿用，沿用的那张保留原 runId
            await db.ImageAssets.InsertOneAsync(new ImageAsset { Id = "a1b", OwnerUserId = "writer", WorkspaceId = id, ArticleInsertionIndex = 1, ArticleWorkflowVersion = 1, Url = "https://example.test/a1b.png", OriginalMarkerText = "窗边打盹的橘猫", CreatedAt = DateTime.UtcNow.AddMinutes(1) });
            await LiteraryMarkerWrites.PointMarkerAsync(db, id, 1, 1, "a1b");
            var rewritten = Data(await drafts.WriteContent(id, new() { MarkedContent = marked.GetProperty("content").GetString() }, CancellationToken.None));
            Assert.Equal(new[] { 0, 1 }, rewritten.GetProperty("reusedImages").EnumerateArray().Select(x => x.GetInt32()));
            var read = Data(await drafts.GetWorkspace(id, 0, 0, CancellationToken.None));
            Assert.Equal("run-0", read.GetProperty("illustrations").EnumerateArray().First().GetProperty("runId").GetString());

            // 历史：智能体能看到全部三张，被换下的 a1 不在正文上
            var history = Data(await drafts.GetHistory(id, CancellationToken.None));
            var images = history.GetProperty("images").EnumerateArray().ToList();
            Assert.Equal(3, images.Count);
            Assert.False(images.Single(i => i.GetProperty("assetId").GetString() == "a1").GetProperty("isCurrent").GetBoolean());

            // 放回旧图：图和描述一起回到当初那一对
            var restored = Data(await drafts.RestoreImage(id, 1, new() { AssetId = "a1", WorkflowVersion = 2 }, CancellationToken.None));
            Assert.Equal("窗边的猫", restored.GetProperty("prompt").GetString());
            var after = Data(await drafts.GetWorkspace(id, 0, 0, CancellationToken.None)).GetProperty("illustrations").EnumerateArray().ElementAt(1);
            Assert.Equal("https://example.test/a1.png", after.GetProperty("url").GetString());
            Assert.Equal("窗边的猫", after.GetProperty("prompt").GetString());
            Assert.IsType<NotFoundObjectResult>(await drafts.RestoreImage(id, 1, new() { AssetId = "别人的图", WorkflowVersion = 2 }, CancellationToken.None));

            // 网页「历史配图」的放回按钮走同一处：不传位置就放回它当初的位置
            var ui = WithAdminUser(new LiteraryAgentWorkspaceController(db, null!, NullLogger<LiteraryAgentWorkspaceController>.Instance), "writer");
            // 页面得带上打开历史时看到的方案版本：不带不放，带了旧版本（期间改过稿）拒绝且什么都不动
            Assert.IsType<BadRequestObjectResult>(await ui.RestoreIllustration(id, "a1b", null, CancellationToken.None));
            var beforeStale = (await db.ImageMasterWorkspaces.Find(x => x.Id == id).SingleAsync()).ArticleWorkflow!.AssetIdByMarkerIndex["1"];
            Assert.IsType<ConflictObjectResult>(await ui.RestoreIllustration(id, "a1b", new() { WorkflowVersion = 1 }, CancellationToken.None));
            Assert.Equal(beforeStale, (await db.ImageMasterWorkspaces.Find(x => x.Id == id).SingleAsync()).ArticleWorkflow!.AssetIdByMarkerIndex["1"]);
            Data(await ui.RestoreIllustration(id, "a1b", new() { WorkflowVersion = 2 }, CancellationToken.None));
            var web = Data(await ui.GetIllustrationHistory(id, CancellationToken.None));
            var current = web.GetProperty("groups").EnumerateArray().SelectMany(g => g.GetProperty("items").EnumerateArray())
                .Where(i => i.GetProperty("isCurrent").GetBoolean()).Select(i => i.GetProperty("id").GetString()).OrderBy(x => x);
            Assert.Equal(new[] { "a0", "a1b" }, current);
            Assert.Equal(new[] { 0, 1 }, web.GetProperty("markerIndexes").EnumerateArray().Select(x => x.GetInt32()));

            // 长描述的图放回后，标记描述一字不少（图上记的原始描述与标记同一个上限）
            var longPrompt = string.Concat(Enumerable.Repeat("窗边打盹的橘猫，阳光斜照在书脊上。", 30));
            Assert.True(longPrompt.Length > 200);
            await db.ImageAssets.InsertOneAsync(new ImageAsset { Id = "a1long", OwnerUserId = "writer", WorkspaceId = id, ArticleInsertionIndex = 1, ArticleWorkflowVersion = 2, Url = "https://example.test/a1long.png",
                OriginalMarkerText = LiteraryMcpWorkflow.ClampOriginalMarkerText(longPrompt) });
            Data(await ui.RestoreIllustration(id, "a1long", new() { WorkflowVersion = 2 }, CancellationToken.None));
            var restoredMarker = (await db.ImageMasterWorkspaces.Find(x => x.Id == id).SingleAsync()).ArticleWorkflow!.Markers.Single(m => m.Index == 1);
            Assert.Equal(longPrompt, LiteraryMcpWorkflow.EffectivePrompt(restoredMarker));
        }
        finally { await new MongoClient(connection).DropDatabaseAsync(name); }
    }

    [Fact]
    public async Task 原样写回拿到的令牌能直接接着写_放回遇到换稿整体不生效()
    {
        // review 指出的两处：正文没变的覆盖照样换了 UpdatedAt，却回了旧令牌；
        // 放回拆成两次写，中间换了稿，后一半落空仍报成功
        var (db, name, connection) = NewDb("literary_tokens");
        try
        {
            var drafts = WithUser(new LiteraryOpenApiController(db), "writer");
            var id = Data(await drafts.CreateWorkspace(new()
            {
                MarkedContent = "一。\n[插图]: 书店门口\n", ClientRequestId = "tok",
            }, CancellationToken.None)).GetProperty("workspaceId").GetString()!;
            var read = Data(await drafts.GetWorkspace(id, 0, 0, CancellationToken.None));
            var token = read.GetProperty("updatedAt").GetString();
            await Task.Delay(5); // 让这次写入的时间戳与读到的不同

            var same = Data(await drafts.WriteContent(id, new() { Content = read.GetProperty("content").GetString(), ExpectedUpdatedAt = token }, CancellationToken.None));
            var fresh = same.GetProperty("updatedAt").GetString();
            Assert.Equal(McpRevision.Token((await db.ImageMasterWorkspaces.Find(x => x.Id == id).SingleAsync()).UpdatedAt), fresh);
            Data(await drafts.UpdateIllustrationPrompt(id, 0, new() { Prompt = "书店门口的雨", WorkflowVersion = 1, ExpectedUpdatedAt = fresh }, CancellationToken.None));

            await db.ImageAssets.InsertOneAsync(new ImageAsset { Id = "old", OwnerUserId = "writer", WorkspaceId = id, ArticleInsertionIndex = 0, ArticleWorkflowVersion = 1, Url = "https://example.test/old.png", OriginalMarkerText = "书店门口" });
            var ws = await db.ImageMasterWorkspaces.Find(x => x.Id == id).SingleAsync();
            // 读到的是第 1 版，放回前文章已被重写成第 2 版：不许报成功，也不许在新方案上留下半截
            var rewritten = Data(await drafts.WriteContent(id, new() { MarkedContent = "二。\n[插图]: 窗边的猫\n" }, CancellationToken.None));
            Assert.Equal(2, rewritten.GetProperty("workflowVersion").GetInt32());
            var result = await LiteraryIllustrationHistory.RestoreAsync(db, ws, "old", 0, 1, CancellationToken.None);
            Assert.Equal(LiteraryIllustrationHistory.RestoreFailure.VersionChanged, result.Failure);
            var after = (await db.ImageMasterWorkspaces.Find(x => x.Id == id).SingleAsync()).ArticleWorkflow!;
            Assert.Empty(after.AssetIdByMarkerIndex);
            Assert.Empty(after.AdoptedAssetIds);
            Assert.Equal("窗边的猫", LiteraryMcpWorkflow.EffectivePrompt(after.Markers.Single()));
        }
        finally { await new MongoClient(connection).DropDatabaseAsync(name); }
    }

    [Fact]
    public async Task 换稿前在用的那组被存档_带标记写回自动沿用_历史标出换下时间()
    {
        // MCP-LIT-06：客户说「恢复成上传前最后用的」，智能体只能按生成时间猜；
        // 手动放回过旧图时，最晚生成的那张恰恰不是在用的那张
        var (db, name, connection) = NewDb("literary_lit06");
        try
        {
            var drafts = WithUser(new LiteraryOpenApiController(db), "writer");
            var id = Data(await drafts.CreateWorkspace(new()
            {
                Title = "六号债", MarkedContent = "一。\n[插图]: 书店门口\n二。\n[插图]: 窗边的猫\n", ClientRequestId = "lit06",
            }, CancellationToken.None)).GetProperty("workspaceId").GetString()!;
            var t0 = DateTime.UtcNow.AddMinutes(-10);
            await db.ImageAssets.InsertManyAsync(new[]
            {
                new ImageAsset { Id = "a0", OwnerUserId = "writer", WorkspaceId = id, ArticleInsertionIndex = 0, ArticleWorkflowVersion = 1, Url = "https://example.test/a0.png", OriginalMarkerText = "书店门口", CreatedAt = t0 },
                new ImageAsset { Id = "a1-old", OwnerUserId = "writer", WorkspaceId = id, ArticleInsertionIndex = 1, ArticleWorkflowVersion = 1, Url = "https://example.test/a1-old.png", OriginalMarkerText = "窗边的猫", CreatedAt = t0 },
                new ImageAsset { Id = "a1-new", OwnerUserId = "writer", WorkspaceId = id, ArticleInsertionIndex = 1, ArticleWorkflowVersion = 1, Url = "https://example.test/a1-new.png", OriginalMarkerText = "窗边的猫", CreatedAt = t0.AddMinutes(1) },
            });
            await LiteraryMarkerWrites.PointMarkerAsync(db, id, 1, 0, "a0");
            await LiteraryMarkerWrites.PointMarkerAsync(db, id, 1, 1, "a1-new");
            await LiteraryMarkerWrites.PointMarkerAsync(db, id, 1, 1, "a1-old"); // 用户又放回了旧的那张
            await db.ImageAssets.UpdateOneAsync(x => x.Id == "a0", Builders<ImageAsset>.Update.Set(x => x.OriginalMarkerText, "粉色系，书店门口")); // 早期数据：图上记的是带风格前缀的整段

            // 网页上换了正文：标记作废
            var ui = WithAdminUser(new LiteraryAgentWorkspaceController(db, null!, NullLogger<LiteraryAgentWorkspaceController>.Instance), "writer");
            Data(await ui.UpdateWorkspace(id, new UpdateWorkspaceRequest { ArticleContent = "一。本文为验收用稿。\n二。\n" }, CancellationToken.None));

            // 历史：上一组是存档时真正在用的 a0 + a1-old，不是最晚生成的 a1-new
            var history = Data(await drafts.GetHistory(id, CancellationToken.None));
            var lastSet = history.GetProperty("previousSets").EnumerateArray().First();
            Assert.Equal("网页上换了正文", lastSet.GetProperty("reason").GetString());
            Assert.Equal(new[] { "a0", "a1-old" }, lastSet.GetProperty("images").EnumerateArray().Select(i => i.GetProperty("assetId").GetString()));
            var images = history.GetProperty("images").EnumerateArray().ToDictionary(i => i.GetProperty("assetId").GetString()!);
            Assert.True(images["a1-old"].GetProperty("inLastSet").GetBoolean());
            Assert.Equal("网页上换了正文", images["a1-old"].GetProperty("replacedReason").GetString());
            Assert.False(images["a1-new"].GetProperty("inLastSet").GetBoolean());
            Assert.StartsWith("同一位置换上了别的图", images["a1-new"].GetProperty("replacedReason").GetString());
            Assert.NotEqual(JsonValueKind.Null, images["a1-new"].GetProperty("replacedAt").ValueKind);

            // 智能体照着上一组给的描述写回：两张都自动接上换稿前那组，不用逐张放回
            var descriptions = lastSet.GetProperty("images").EnumerateArray().Select(i => i.GetProperty("description").GetString()).ToList();
            var written = Data(await drafts.WriteContent(id, new()
            {
                MarkedContent = $"一。本文为验收用稿。\n[插图]: {descriptions[0]}\n二。\n[插图]: {descriptions[1]}\n",
            }, CancellationToken.None));
            Assert.Equal(new[] { 0, 1 }, written.GetProperty("reusedImages").EnumerateArray().Select(x => x.GetInt32()));
            var read = Data(await drafts.GetWorkspace(id, 0, 0, CancellationToken.None)).GetProperty("illustrations").EnumerateArray().ToList();
            Assert.Equal("https://example.test/a1-old.png", read[1].GetProperty("url").GetString());

            // 这次整篇重写也留了档：上一组变成刚才写回前的那份（空的不算一组）
            var again = Data(await drafts.GetHistory(id, CancellationToken.None)).GetProperty("previousSets").EnumerateArray().First();
            Assert.Equal("网页上换了正文", again.GetProperty("reason").GetString());

            // 沿用回来的 a1-old 再被「放回」a1-new 顶掉：换下时间是被顶掉的那一刻，不是早先那次换稿
            var beforeRestore = DateTime.UtcNow;
            Data(await drafts.RestoreImage(id, 1, new() { AssetId = "a1-new", WorkflowVersion = 3 }, CancellationToken.None));
            var after = Data(await drafts.GetHistory(id, CancellationToken.None)).GetProperty("images").EnumerateArray()
                .ToDictionary(i => i.GetProperty("assetId").GetString()!);
            Assert.StartsWith("同一位置换上了别的图", after["a1-old"].GetProperty("replacedReason").GetString());
            Assert.True(after["a1-old"].GetProperty("replacedAt").GetDateTime() >= beforeRestore.AddSeconds(-1));
            Assert.True(after["a1-new"].GetProperty("isCurrent").GetBoolean());
        }
        finally { await new MongoClient(connection).DropDatabaseAsync(name); }
    }

    [Fact]
    public void 配图方案进历史只许走统一存档_原始描述统一限长_挂图必看结果()
    {
        // 三处换稿各抄一份「原样塞进历史」：存下的不是当时真正在用的图，也没有换下时间与原因。
        // 新增入口若再手抄一份，「恢复成上传前的」就又回到按生成时间去猜。
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir != null && !(File.Exists(Path.Combine(dir.FullName, "CLAUDE.md")) && Directory.Exists(Path.Combine(dir.FullName, "prd-api"))))
            dir = dir.Parent;
        Assert.NotNull(dir);
        var src = Path.Combine(dir!.FullName, "prd-api", "src");
        var offenders = new List<string>();
        foreach (var file in Directory.GetFiles(src, "*.cs", SearchOption.AllDirectories).Where(f => !f.Contains($"{Path.DirectorySeparatorChar}obj{Path.DirectorySeparatorChar}")))
        {
            var text = File.ReadAllText(file);
            if (text.Contains("Insert(0, ws.ArticleWorkflow") && !file.EndsWith("LiteraryIllustrationArchive.cs"))
                offenders.Add($"{Path.GetFileName(file)}：手抄了「把当前方案塞进历史」");
            if (text.Contains(".Set(x => x.ArticleWorkflowHistory") && !file.EndsWith("LiteraryIllustrationArchive.cs")
                && !text.Contains("ArchiveCurrent(") && !text.Contains("ContentResetUpdate("))
                offenders.Add($"{Path.GetFileName(file)}：写了配图方案历史却没走 LiteraryIllustrationArchive.ArchiveCurrent");
            // 图上记的原始描述放回时会原样写回标记：只许经 ClampOriginalMarkerText 限长，别处再截一刀就会把标记悄悄改短
            if (System.Text.RegularExpressions.Regex.IsMatch(text, @"OriginalMarkerText(\.Length\s*>|\[\.\.)") && !file.EndsWith("LiteraryMcpWorkflow.cs"))
                offenders.Add($"{Path.GetFileName(file)}：自行截短了 OriginalMarkerText，应改用 LiteraryMcpWorkflow.ClampOriginalMarkerText");
            // 挂图带版本条件，挂不上（期间换了稿）必须让调用方知道，丢掉返回值就会把失败报成成功
            if (System.Text.RegularExpressions.Regex.IsMatch(text, @"(?m)^\s*await\s+[\w.]*PointMarkerAsync\("))
                offenders.Add($"{Path.GetFileName(file)}：调用 PointMarkerAsync 却没看返回值");
            // 详情接口按「指针表有没有值」决定只给当前图：改稿后指针清空、旧图保留，就会把旧版图当成当前图
            if (text.Contains("currentAssetIds.Count > 0"))
                offenders.Add($"{Path.GetFileName(file)}：按指针表是否为空决定详情给不给全部图，应改用 LiteraryIllustrationHistory.ShowsCurrentOnly");
        }
        foreach (var detail in new[] { "LiteraryAgentWorkspaceController.cs", "ImageMasterController.cs" })
        {
            var path = Directory.GetFiles(src, detail, SearchOption.AllDirectories).Single();
            if (!File.ReadAllText(path).Contains("LiteraryIllustrationHistory.ShowsCurrentOnly(ws)"))
                offenders.Add($"{detail}：工作区详情没有走 LiteraryIllustrationHistory.ShowsCurrentOnly");
        }
        Assert.True(offenders.Count == 0, string.Join("\n", offenders));
    }

    [Fact]
    public async Task 网页上重画也按这篇文章的风格水印来_顶栏改的是这篇文章()
    {
        // 验收里撞出来的：智能体按「水印配置1」配好图，客户在网页上重画一张，水印变成了账号默认
        var (db, name, connection) = NewDb("literary_web_prefs");
        try
        {
            await db.ReferenceImageConfigs.InsertOneAsync(new ReferenceImageConfig { Id = "pink", AppKey = "literary-agent", CreatedByAdminId = "writer", Name = "全域粉销风格", ImageSha256 = "PINK", Prompt = "粉色系" });
            await db.WatermarkConfigs.InsertManyAsync(new[]
            {
                new WatermarkConfig { Id = "wm-default", UserId = "writer", Name = "黑白", AppKeys = new() { "literary-agent" } },
                new WatermarkConfig { Id = "wm-1", UserId = "writer", Name = "水印配置1", AppKeys = new() },
            });
            var drafts = WithUser(new LiteraryOpenApiController(db), "writer");
            var images = WithUser(new LiteraryImageOpenApiController(db, new FixedModelSelection()), "writer");
            var id = Data(await drafts.CreateWorkspace(new()
            {
                MarkedContent = "正文。\n[插图]: 书店\n", ClientRequestId = "web-1",
            }, CancellationToken.None)).GetProperty("workspaceId").GetString()!;
            Data(await images.Generate(id, new() { MarkerIndex = 0, WorkflowVersion = 1, ClientRequestId = "g", Style = "全域粉销风格", Watermark = "水印配置1" }, CancellationToken.None));

            // 网页详情告诉页面：这篇文章有自己的风格与水印
            var ui = WithAdminUser(new LiteraryAgentWorkspaceController(db, null!, NullLogger<LiteraryAgentWorkspaceController>.Instance), "writer");
            var detail = Data(await ui.GetWorkspaceDetail(id));
            Assert.Equal("wm-1", detail.GetProperty("illustrationChoice").GetProperty("watermark").GetProperty("watermarkId").GetString());

            // 网页上重画（页面还钉着按账号默认挑的文生图模型）
            var web = WithAdminUser(new LiteraryAgentImageGenController(db, new InMemoryRunEventStore(), null!, new LLMRequestContextAccessor(),
                NullLogger<LiteraryAgentImageGenController>.Instance), "writer");
            var created = Data(await web.CreateRun(new CreateImageGenRunRequest
            {
                WorkspaceId = id, ArticleMarkerIndex = 0, PlatformId = "p-text2img", ModelId = "m-text2img",
                Items = new() { new() { Prompt = "书店", Count = 1 } },
            }, CancellationToken.None));
            var run = await db.ImageGenRuns.Find(x => x.Id == created.GetProperty("runId").GetString()).SingleAsync();
            Assert.Equal("wm-1", run.WatermarkConfigId);
            Assert.Equal("pink", run.InitImageAssetSha256);
            Assert.StartsWith("粉色系", run.Items[0].Prompt);
            Assert.Equal(AppCallerRegistry.LiteraryAgent.Illustration.Img2Img, run.AppCallerCode);
            Assert.Null(run.ModelId); // 场景翻转后不带过去另一个池的模型

            // 只有文字提示词、没有参考图的风格：网页重画同样要带上它（智能体那条路一直带）
            await db.ReferenceImageConfigs.InsertOneAsync(new ReferenceImageConfig { Id = "ink", AppKey = "literary-agent", CreatedByAdminId = "writer", Name = "水墨", Prompt = "水墨淡彩" });
            Assert.IsType<OkObjectResult>(await ui.SetIllustrationPrefs(id, new() { Style = "水墨" }, CancellationToken.None));
            var inkCreated = Data(await web.CreateRun(new CreateImageGenRunRequest
            {
                WorkspaceId = id, ArticleMarkerIndex = 0, Items = new() { new() { Prompt = "书店", Count = 1 } },
            }, CancellationToken.None));
            var inkRun = await db.ImageGenRuns.Find(x => x.Id == inkCreated.GetProperty("runId").GetString()).SingleAsync();
            Assert.Null(inkRun.InitImageAssetSha256);
            Assert.StartsWith("水墨淡彩", inkRun.Items[0].Prompt);
            Assert.Equal(AppCallerRegistry.LiteraryAgent.Illustration.Text2Img, inkRun.AppCallerCode);
            Assert.IsType<OkObjectResult>(await ui.SetIllustrationPrefs(id, new() { Style = "全域粉销风格" }, CancellationToken.None));

            // 网页顶栏改水印：写进这篇文章，不动账号绑定
            Assert.IsType<OkObjectResult>(await ui.SetIllustrationPrefs(id, new() { Watermark = "none" }, CancellationToken.None));
            Assert.Equal(WatermarkSelection.None, (await db.ImageMasterWorkspaces.Find(x => x.Id == id).SingleAsync()).IllustrationPrefs!.WatermarkId);
            Assert.Contains("literary-agent", (await db.WatermarkConfigs.Find(x => x.Id == "wm-default").SingleAsync()).AppKeys);
            // 协作者：文章记住的是作者账号里的 ID，他那边查不到——不套、不给改，照旧按他自己账号的设定
            await db.ImageMasterWorkspaces.UpdateOneAsync(x => x.Id == id, Builders<ImageMasterWorkspace>.Update.Set(x => x.MemberUserIds, new List<string> { "helper" }));
            var helperUi = WithAdminUser(new LiteraryAgentWorkspaceController(db, null!, NullLogger<LiteraryAgentWorkspaceController>.Instance), "helper");
            Assert.Equal(403, Assert.IsType<ObjectResult>(await helperUi.SetIllustrationPrefs(id, new() { Watermark = "none" }, CancellationToken.None)).StatusCode);
            Assert.Equal(JsonValueKind.Null, Data(await helperUi.GetWorkspaceDetail(id)).GetProperty("illustrationChoice").ValueKind);
            var helperWeb = WithAdminUser(new LiteraryAgentImageGenController(db, new InMemoryRunEventStore(), null!, new LLMRequestContextAccessor(),
                NullLogger<LiteraryAgentImageGenController>.Instance), "helper");
            var helperCreated = Data(await helperWeb.CreateRun(new CreateImageGenRunRequest
            {
                WorkspaceId = id, ArticleMarkerIndex = 0, Items = new() { new() { Prompt = "书店", Count = 1 } },
            }, CancellationToken.None));
            var helperRun = await db.ImageGenRuns.Find(x => x.Id == helperCreated.GetProperty("runId").GetString()).SingleAsync();
            Assert.Null(helperRun.WatermarkConfigId);
            Assert.Null(helperRun.InitImageAssetSha256);

            // 记住的风格被删了：页面拿到结构化的失效标记，按账号默认出图但要提示，不能再说成「本文自己的设定」
            Assert.False(Data(await ui.GetWorkspaceDetail(id)).GetProperty("illustrationChoice").GetProperty("style").GetProperty("missing").GetBoolean());
            await db.ReferenceImageConfigs.DeleteOneAsync(x => x.Id == "pink");
            var afterDelete = Data(await ui.GetWorkspaceDetail(id)).GetProperty("illustrationChoice");
            Assert.True(afterDelete.GetProperty("style").GetProperty("missing").GetBoolean());
            Assert.Equal("account-default", afterDelete.GetProperty("style").GetProperty("source").GetString());
            Assert.False(afterDelete.GetProperty("watermark").GetProperty("missing").GetBoolean()); // 水印仍是本文记住的「不打」
            // 只指定过水印、风格本来就跟随账号默认：不算失效
            var onlyWm = Data(await ui.SetIllustrationPrefs(id, new() { Style = "none" }, CancellationToken.None)).GetProperty("effective");
            Assert.False(onlyWm.GetProperty("style").GetProperty("missing").GetBoolean());

            // 清除后回到账号默认
            Assert.IsType<OkObjectResult>(await ui.SetIllustrationPrefs(id, new() { Clear = true }, CancellationToken.None));
            Assert.Null((await db.ImageMasterWorkspaces.Find(x => x.Id == id).SingleAsync()).IllustrationPrefs);
            var plain = Data(await web.CreateRun(new CreateImageGenRunRequest
            {
                WorkspaceId = id, ArticleMarkerIndex = 0, Items = new() { new() { Prompt = "书店", Count = 1 } },
            }, CancellationToken.None));
            var plainRun = await db.ImageGenRuns.Find(x => x.Id == plain.GetProperty("runId").GetString()).SingleAsync();
            Assert.Null(plainRun.WatermarkConfigId);
            Assert.Null(plainRun.InitImageAssetSha256);
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

    // 与线上一致用驼峰命名（Program.cs 配的是 CamelCase）；否则带类型的返回对象在测试里是另一套字段名
    private static JsonElement Data(IActionResult result) => JsonSerializer.SerializeToElement(
        Assert.IsType<ApiResponse<object>>(Assert.IsType<OkObjectResult>(result).Value).Data,
        new JsonSerializerOptions(JsonSerializerDefaults.Web));

    private sealed class FixedModelSelection : ILiteraryMcpModelSelectionService
    {
        public Task<LiteraryMcpModelSelection> ResolveForRunAsync(
            string ownerUserId, string agentApiKeyId, string appCallerCode, CancellationToken ct)
            => Task.FromResult(LiteraryMcpModelSelection.Selected("gpt-image-2"));

        public Task<LiteraryMcpModelSelection> ValidateFixedModelAsync(string logicalModelPublicId, CancellationToken ct)
            => Task.FromResult(LiteraryMcpModelSelection.Selected(logicalModelPublicId));
    }
}
