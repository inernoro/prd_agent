using PrdAgent.Api.Controllers.Api;
using System.Security.Cryptography;
using System.Text;
using MongoDB.Bson;
using MongoDB.Driver;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging.Abstractions;
using Moq;
using PrdAgent.Api.Services;
using PrdAgent.Infrastructure.Database;
using PrdAgent.LlmGatewayHost;
using PrdAgent.Api.Services.MdToPpt;
using PrdAgent.Core.LlmGateway;
using PrdAgent.Core.Models;
using PrdAgent.Core.Interfaces;
using PrdAgent.Infrastructure.Services;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public sealed class HtmlPptContinuationTests
{
    [Fact]
    public void RestoredCurrentVersionRetainsRealSourceAndFreezesCurrentBytes()
    {
        var f = Fixture();
        var before = f.Source.ToJson();
        var resolved = HtmlPptContinuationService.ResolveSnapshot(f.Source, f.Artifact, f.Site,
            f.Origin, f.Current, [f.Current, f.Origin], "owner");
        Assert.Equal("saved-run", resolved.Context.SourceRunId);
        Assert.Equal("restored", resolved.Context.BaseRevisionId);
        Assert.Equal("restored", resolved.Context.BasePublishedRevisionId);
        Assert.Equal(f.Site.ContentVersion, resolved.Context.BaseContentVersion);
        Assert.Equal(f.Current.Html, resolved.Html);
        Assert.Equal(before, f.Source.ToJson());
        Assert.Equal("original", f.Artifact.ProducedArtifactRevisionId);
    }

    [Fact]
    public void ForeignOwnerAndTamperedSidecarNeverBecomeTrustedBases()
    {
        var f = Fixture();
        Assert.ThrowsAny<InvalidOperationException>(() => HtmlPptContinuationService.ResolveSnapshot(
            f.Source, f.Artifact, f.Site, f.Origin, f.Current, [f.Current, f.Origin], "other-user"));
        f.Current.VerifiedFiles[1].Content[0] ^= 1;
        Assert.ThrowsAny<InvalidOperationException>(() => HtmlPptContinuationService.ResolveSnapshot(
            f.Source, f.Artifact, f.Site, f.Origin, f.Current, [f.Current, f.Origin], "owner"));
    }

    [Fact]
    public void OwnCompletedDraftCanContinueOnlyAgainstUnchangedPublishedFence()
    {
        var f = Fixture();
        f.Current.Id = "draft";
        f.Current.Source = HostedSiteRevisionSources.AiEdit;
        f.Current.Status = HostedSiteRevisionStatuses.Draft;
        f.Current.SourceRunId = f.Source.Id;
        f.Current.ParentRevisionId = "restored";
        f.Current.BasedOnContentVersion = f.Site.ContentVersion;
        // CompletePresentationAsync 对未发布稿只记录 Produced*；Published binding 仍为空。
        f.Artifact.ArtifactSiteId = null;
        f.Artifact.ArtifactRevisionId = null;
        f.Artifact.ProducedArtifactRevisionId = "draft";
        var resolved = HtmlPptContinuationService.ResolveSnapshot(f.Source, f.Artifact, f.Site,
            f.Current, f.Current, [f.Current], "owner");
        Assert.Equal("draft", resolved.Context.BaseRevisionId);
        Assert.Equal("restored", resolved.Context.BasePublishedRevisionId);
        f.Site.ContentVersion = f.Site.ContentVersion.AddSeconds(1);
        Assert.ThrowsAny<InvalidOperationException>(() => HtmlPptContinuationService.ResolveSnapshot(
            f.Source, f.Artifact, f.Site, f.Current, f.Current, [f.Current], "owner"));
        Assert.Equal(HtmlPptContinuationService.OperationRunId("tenant", "owner", "same-key"),
            HtmlPptContinuationService.OperationRunId("tenant", "owner", "same-key"));
    }

    [Fact]
    public async Task NewModificationGetsIndependentContractWithoutReopeningExpiredHistory()
    {
        var f = Fixture();
        var template = new GatewayRuntimeBudgetScopeRecord
        {
            Id = "old-scope", TenantId = "tenant", UserId = "owner", RootOutlineRunId = "outline",
            SourcePlanHash = new string('a', 64), Status = "active", ExpiresAt = DateTime.UtcNow.AddDays(-4),
            ImmutableCarryUsd = 57m, SpentUsd = 72m, InputUsdPerMillion = 4m, OutputUsdPerMillion = 20m,
            LongContextThresholdTokens = 272_000, LongContextInputUsdPerMillion = 8m,
            LongContextOutputUsdPerMillion = 30m, InputByteTokenMultiplier = 1, MaxOutputTokens = 8192,
            ExpectedLogicalModelPublicId = "default-chat-curated", ExpectedProvider = "test-provider",
            ExpectedModel = "test-model", Reservations = Enumerable.Range(0,96).Select(i =>
                new GatewayRuntimeBudgetReservationRecord { RequestId = "old-" + i, Status = "settled" }).ToList(),
            PptCompletion = new GatewayPptCompletionBudgetRecord
            {
                Id = "old-completion", CandidateCommit = new string('e', 40), Status = "manual-active",
                GenerationRunId = "original-generation", ManualRunId = "saved-run",
                GenerationAndRepairs = new() { MaxPhysicalCalls = 2, MaxBodyUtf8Bytes = 30_000, MaxOutputTokens = 8192 },
                ManualSave = new() { MaxPhysicalCalls = 3, MaxBodyUtf8Bytes = 60_000, MaxOutputTokens = 8192 },
                ExpiresAt = DateTime.UtcNow.AddDays(-4),
            },
        };
        // 同一组合继续验证真实 Mongo 准入/幂等与 serving 预占/未知用量结算；没有模型或外部 HTTP。
        await using var store = await RunMongoFixture.CreateAsync("ppt_continuation");
        var connection = Environment.GetEnvironmentVariable("MONGODB_TEST_CONNECTION") ?? "mongodb://127.0.0.1:27017";
        var gw = new LlmGatewayDataContext(connection, store.Db.Database.DatabaseNamespace.DatabaseName);
        var config = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string,string?>
        {
            ["LlmGateway:InternalTenantId"] = "tenant",
            ["LlmGateway:ServeBaseUrl"] = "http://gateway/gw",
            ["DesignArtifactRuntime:Model"] = "default-chat-curated",
            ["MdToPpt:ModificationBudgetPolicy:PolicyId"] = "current-policy",
            ["MdToPpt:ModificationBudgetPolicy:Active"] = "true",
            ["MdToPpt:ModificationBudgetPolicy:OperationLifetimeHours"] = "4",
            ["MdToPpt:ModificationBudgetPolicy:LogicalModelPublicId"] = "default-chat-curated",
            ["MdToPpt:ModificationBudgetPolicy:FallbackEstimateProvider"] = "fallback-provider",
            ["MdToPpt:ModificationBudgetPolicy:Model"] = "current-model",
            ["MdToPpt:ModificationBudgetPolicy:PriceCurrency"] = "USD",
            ["MdToPpt:ModificationBudgetPolicy:EstimateSource"] = "official-benchmark-test-fixture",
            ["MdToPpt:ModificationBudgetPolicy:SourceUrl"] = "https://example.test/model-price-fixture",
            ["MdToPpt:ModificationBudgetPolicy:IsEstimate"] = "true",
            ["MdToPpt:ModificationBudgetPolicy:PriceObservedAtUtc"] = DateTime.UtcNow.AddMinutes(-1).ToString("O"),
            ["MdToPpt:ModificationBudgetPolicy:EstimatedInputUsdPerMillion"] = "7",
            ["MdToPpt:ModificationBudgetPolicy:EstimatedOutputUsdPerMillion"] = "28",
            ["MdToPpt:ModificationBudgetPolicy:LongContextThresholdTokens"] = "272000",
            ["MdToPpt:ModificationBudgetPolicy:LongPriceInputMultiplier"] = "2",
            ["MdToPpt:ModificationBudgetPolicy:LongPriceOutputMultiplier"] = "1.5",
            ["MdToPpt:ModificationBudgetPolicy:DocumentedMaxOutputTokens"] = "128000",
            ["MdToPpt:ModificationBudgetPolicy:MaxOutputTokens"] = "8192",
            ["MdToPpt:ModificationBudgetPolicy:GenerationAndRepairs:MaxPhysicalCalls"] = "5",
            ["MdToPpt:ModificationBudgetPolicy:GenerationAndRepairs:MaxBodyUtf8Bytes"] = "50000",
            ["MdToPpt:ModificationBudgetPolicy:GenerationAndRepairs:MaxOutputTokens"] = "8192",
            ["MdToPpt:ModificationBudgetPolicy:ManualSave:MaxPhysicalCalls"] = "4",
            ["MdToPpt:ModificationBudgetPolicy:ManualSave:MaxBodyUtf8Bytes"] = "90000",
            ["MdToPpt:ModificationBudgetPolicy:ManualSave:MaxOutputTokens"] = "8192",
            ["MdToPpt:ModificationBudgetPolicy:TailHeldUsd"] = "1",
        }).Build();
        var catalog = MdToPptSourcePlan.Create("# 已有演示稿\n保留原稿并定向修改。", []);
        var sourceJson = catalog.SerializeCatalog();
        var sourceHash = MdToPptController.ComputeHtmlHash(sourceJson);
        template.SourcePlanHash = catalog.Fingerprint;
        f.Source.ParentOutlineRunId = "outline";
        f.Source.SourcePlanJson = sourceJson;
        f.Source.SourcePlanHash = sourceHash;
        f.Artifact.DeploymentSlug = DeploymentScope.Current;
        await store.Db.MdToPptRuns.InsertManyAsync([f.Source, new MdToPptRun
        {
            Id="outline", UserId="owner", Op="outline", Status="done", SourcePlanVersion=MdToPptSourcePlan.Version,
            SourcePlanJson=sourceJson, SourcePlanHash=sourceHash,
        }]);
        await store.Db.DesignArtifactRuns.InsertOneAsync(f.Artifact);
        await store.Db.HostedSites.InsertOneAsync(f.Site);
        await store.Db.HostedSiteRevisions.InsertManyAsync([f.Origin, f.Current]);
        var scopes = gw.Database.GetCollection<GatewayRuntimeBudgetScopeRecord>("llmgw_runtime_budget_scopes");
        await scopes.InsertOneAsync(template);
        var oldBytes = (await scopes.Find(x => x.Id==template.Id).SingleAsync()).ToJson();
        GatewayModelResolution CurrentRoute(bool priced) => new()
        {
            Success=true,LogicalModelPublicId="default-chat-curated",OfferingId="current-offering",
            OfferingTargetKind="model",ActualPlatformName=priced?"current-provider":"fallback-provider",ActualModel="current-model",
            MaxTokens=priced?4096:null,PriceCurrency=priced?"USD":"CNY",
            InputPricePerMillion=priced?6m:null,OutputPricePerMillion=priced?24m:null,
            PriceSource=priced?"current-gateway-price":null,PriceObservedAt=priced?DateTime.UtcNow.AddMinutes(-1):null,
        };
        var activeRoute=CurrentRoute(true);
        var currentGateway=new Mock<ILlmGateway>(MockBehavior.Strict);
        currentGateway.Setup(x=>x.ResolveRequiredLogicalModelAsync(AppCallerRegistry.MdToPptAgent.Generation.Patch,
            "chat","default-chat-curated",It.IsAny<CancellationToken>())).ReturnsAsync(()=>activeRoute);
        var service = new HtmlPptContinuationService(store.Db, gw, config,currentGateway.Object);
        var context = await service.ResolveCurrentEditContextAsync(f.Source.Id, "owner", CancellationToken.None);
        var key = Guid.NewGuid().ToString("N");
        var admissions = await Task.WhenAll(Enumerable.Range(0, 2).Select(_ =>
            service.AdmitModificationAsync(f.Source.Id, "owner", context.Context, key,
                new string('f',64), CancellationToken.None)));
        var first = admissions[0];
        var replay = admissions[1];
        Assert.Equal(first.RunId, replay.RunId);
        Assert.Equal(first.ScopeId, replay.ScopeId);
        var currentScope=await scopes.Find(x=>x.Id==first.ScopeId).SingleAsync();
        Assert.Equal(6m,currentScope.InputUsdPerMillion);
        Assert.Equal(24m,currentScope.OutputUsdPerMillion);
        Assert.Equal(12m,currentScope.LongContextInputUsdPerMillion);
        Assert.Equal(36m,currentScope.LongContextOutputUsdPerMillion);
        Assert.Equal(0m,currentScope.SpentUsd);
        Assert.Equal(0m,currentScope.ImmutableCarryUsd);
        Assert.Empty(currentScope.Reservations);
        Assert.True(currentScope.ExpiresAt>DateTime.UtcNow);
        Assert.True(currentScope.ExpiresAt<=DateTime.UtcNow.AddHours(4));
        Assert.Equal(4096,currentScope.MaxOutputTokens);
        Assert.Equal(4096,currentScope.PptCompletion!.GenerationAndRepairs.MaxOutputTokens);
        Assert.Equal("current-route-estimate",currentScope.PptModificationPriceBasis);
        Assert.Equal("current-gateway-price",currentScope.PptModificationPriceSource);
        Assert.Equal("current-provider",currentScope.ExpectedProvider);
        Assert.Equal("current-model",currentScope.ExpectedModel);
        Assert.Equal(5,currentScope.PptCompletion!.GenerationAndRepairs.MaxPhysicalCalls);
        Assert.Equal(50_000,currentScope.PptCompletion.GenerationAndRepairs.MaxBodyUtf8Bytes);
        Assert.Equal(1m,currentScope.PptCompletion.TailHeldUsd);
        Assert.Equal(2, await scopes.CountDocumentsAsync(FilterDefinition<GatewayRuntimeBudgetScopeRecord>.Empty));
        await Assert.ThrowsAsync<HtmlPptContinuationException>(() => service.AdmitModificationAsync(f.Source.Id,
            "owner", context.Context, key, new string('0',64), CancellationToken.None));
        // 生产同类缺价可用明确当前模型基准估算；双重缺价或当前包络缺项必须在插入scope前拒绝。
        activeRoute=CurrentRoute(false);
        var fallback=await service.AdmitModificationAsync(f.Source.Id,"owner",context.Context,
            Guid.NewGuid().ToString("N"),new string('1',64),CancellationToken.None);
        var estimated=await scopes.Find(x=>x.Id==fallback.ScopeId).SingleAsync();
        Assert.Equal(7m,estimated.InputUsdPerMillion);
        Assert.Equal(28m,estimated.OutputUsdPerMillion);
        Assert.Equal(14m,estimated.LongContextInputUsdPerMillion);
        Assert.Equal(42m,estimated.LongContextOutputUsdPerMillion);
        Assert.Equal(8192,estimated.MaxOutputTokens);
        Assert.Equal("official-benchmark-estimate",estimated.PptModificationPriceBasis);
        Assert.True(estimated.PptModificationPriceIsEstimate);
        config["MdToPpt:ModificationBudgetPolicy:FallbackEstimateProvider"]="other-provider";
        var noFallback=await Assert.ThrowsAsync<HtmlPptContinuationException>(()=>service.AdmitModificationAsync(f.Source.Id,
            "owner",context.Context,Guid.NewGuid().ToString("N"),new string('4',64),CancellationToken.None));
        Assert.Equal("ppt_edit_policy_missing",noFallback.Code);
        config["MdToPpt:ModificationBudgetPolicy:FallbackEstimateProvider"]="fallback-provider";
        config["MdToPpt:ModificationBudgetPolicy:EstimatedInputUsdPerMillion"]=null;
        var noPrice=await Assert.ThrowsAsync<HtmlPptContinuationException>(()=>service.AdmitModificationAsync(f.Source.Id,
            "owner",context.Context,Guid.NewGuid().ToString("N"),new string('2',64),CancellationToken.None));
        Assert.Equal("ppt_edit_policy_missing",noPrice.Code);
        config["MdToPpt:ModificationBudgetPolicy:EstimatedInputUsdPerMillion"]="7";
        config["MdToPpt:ModificationBudgetPolicy:TailHeldUsd"]=null;
        var noEnvelope=await Assert.ThrowsAsync<HtmlPptContinuationException>(()=>service.AdmitModificationAsync(f.Source.Id,
            "owner",context.Context,Guid.NewGuid().ToString("N"),new string('3',64),CancellationToken.None));
        Assert.Equal("ppt_edit_policy_missing",noEnvelope.Code);
        config["MdToPpt:ModificationBudgetPolicy:TailHeldUsd"]="1";
        activeRoute=CurrentRoute(true);
        Assert.Equal(3,await scopes.CountDocumentsAsync(FilterDefinition<GatewayRuntimeBudgetScopeRecord>.Empty));
        var edit = new DesignArtifactRun
        {
            Id=first.RunId, UserId="owner", DeploymentSlug=DeploymentScope.Current, ArtifactType="html-ppt", Operation="edit",
            RuntimeBudgetScopeId=first.ScopeId, PptCompletionId=first.CompletionId,
            PptEditContext=context.Context, PptModificationRequestHash=first.RequestHash,
            PresentationInput=new() { ParentRunId=f.Source.Id, ParentPackageHash=f.Artifact.WorkspaceResultSha256,
                SourcePlanJson=sourceJson, SourcePlanHash=sourceHash },
        };
        await store.Db.MdToPptRuns.InsertOneAsync(new MdToPptRun
        { Id=edit.Id, UserId="owner", Op="patch", ParentRunId=f.Source.Id, SourcePlanJson=sourceJson, SourcePlanHash=sourceHash });
        await store.Db.DesignArtifactRuns.InsertOneAsync(edit);
        var environment = new Mock<IHostEnvironment>();
        environment.SetupGet(x => x.EnvironmentName).Returns("Production");
        var issuer = new DesignArtifactGatewayGrantService(gw, store.Db, config, environment.Object);
        var wrongRun = new DesignArtifactRun
        {
            Id="wrong-generation", UserId="owner", Operation=DesignArtifactOperations.Generate, ArtifactType="html-ppt",
            RuntimeBudgetScopeId=first.ScopeId, PptCompletionId=first.CompletionId, PresentationInput=edit.PresentationInput,
        };
        await store.Db.MdToPptRuns.InsertOneAsync(new MdToPptRun
        { Id=wrongRun.Id, UserId="owner", ParentOutlineRunId="outline", SourcePlanJson=sourceJson, SourcePlanHash=sourceHash });
        var denied = await Assert.ThrowsAsync<MdToPptSourcePlanException>(() =>
            issuer.IssueAsync(wrongRun, DateTime.UtcNow.AddMinutes(5), CancellationToken.None));
        Assert.Equal("task_budget_modification_binding_invalid", denied.Code);
        var issued = await issuer.IssueAsync(edit, DateTime.UtcNow.AddMinutes(5), CancellationToken.None);
        var grant = await gw.Database.GetCollection<GatewayRuntimeGrantRecord>("llmgw_runtime_grants")
            .Find(x => x.Id==issued.Id).SingleAsync();
        Assert.Equal(GatewayPptCompletionPhases.Generation, grant.PptCompletionPhase);
        var counter = new GatewayRuntimeGrantCallCounter(gw);
        var decision = await counter.TryReserveAsync(grant, new GatewayRuntimeGrantCallRequest(
            "new-request", 1_000, 4_096, "default-chat-curated", "current-provider", "current-model"), CancellationToken.None);
        Assert.True(decision.Allowed, decision.ErrorCode);
        await counter.FinalizeAsync(grant, "new-request", null, "usage-unavailable", CancellationToken.None);
        var settled = await scopes.Find(x => x.Id==first.ScopeId).SingleAsync();
        Assert.True(settled.SpentUsd > 0);
        Assert.Equal("settled-unknown", Assert.Single(settled.Reservations).Status);
        Assert.Equal(oldBytes, (await scopes.Find(x => x.Id==template.Id).SingleAsync()).ToJson());

        // 同一新合同：修改稿 D3 已完成但未发布，手动提案必须进入它的 ManualSave 阶段。
        edit.Status = RunStatuses.Done;
        edit.ProducedArtifactSiteId = f.Site.Id;
        edit.ProducedArtifactRevisionId = "new-edit-draft";
        edit.WorkspaceResultSha256 = new string('e',64);
        await store.Db.DesignArtifactRuns.ReplaceOneAsync(x => x.Id==edit.Id, edit);
        var editHtmlHash = MdToPptController.ComputeHtmlHash(f.Current.Html);
        await store.Db.MdToPptRuns.UpdateOneAsync(x => x.Id==edit.Id, Builders<MdToPptRun>.Update
            .Set(x => x.Status, "done").Set(x => x.Html, f.Current.Html).Set(x => x.HtmlHash, editHtmlHash));
        await store.Db.HostedSiteRevisions.InsertOneAsync(new HostedSiteRevision
        {
            Id="new-edit-draft", SiteId=f.Site.Id, CreatedByUserId="owner", SourceRunId=edit.Id,
            Status=HostedSiteRevisionStatuses.Draft, Source=HostedSiteRevisionSources.AiEdit,
            ParentRevisionId=f.Current.Id, BasedOnContentVersion=f.Site.ContentVersion,
            Html=f.Current.Html, VerifiedFiles=f.Current.VerifiedFiles,
        });
        var manualBase = await service.ResolveCurrentEditContextAsync(edit.Id,"owner",CancellationToken.None);
        var proposal = f.Current.Html.Replace("现有演示稿", "现有演示稿：交接有据可查", StringComparison.Ordinal);
        var manualHash = HtmlPptContinuationService.RequestFingerprint(edit.Id, manualBase.Context,
            "保存手动编辑并检查", null, null, null, proposal);
        var manualSaveKey=Guid.NewGuid().ToString("N");
        var manualAdmission = await service.AdmitModificationAsync(edit.Id,"owner",manualBase.Context,
            manualSaveKey,manualHash,CancellationToken.None,isManualSave:true);
        Assert.Equal(first.ScopeId,manualAdmission.ScopeId);
        Assert.Equal(first.CompletionId,manualAdmission.CompletionId);
        Assert.Equal(3,await scopes.CountDocumentsAsync(FilterDefinition<GatewayRuntimeBudgetScopeRecord>.Empty));
        var manual = new DesignArtifactRun
        {
            Id=manualAdmission.RunId,UserId="owner",DeploymentSlug=DeploymentScope.Current,
            ArtifactType="html-ppt",Operation=DesignArtifactOperations.Edit,
            RuntimeBudgetScopeId=first.ScopeId,PptCompletionId=first.CompletionId,
            PptEditContext=manualBase.Context,PptModificationRequestHash=manualHash,
            PresentationInput=new() {ParentRunId=edit.Id,ParentPackageHash=edit.WorkspaceResultSha256,
                SourcePlanJson=sourceJson,SourcePlanHash=sourceHash,ManualEditHtml=proposal},
        };
        await store.Db.MdToPptRuns.InsertOneAsync(new MdToPptRun
        { Id=manual.Id,UserId="owner",Op="patch",ParentRunId=edit.Id,ParentHtmlHash=editHtmlHash,
          SourcePlanJson=sourceJson,SourcePlanHash=sourceHash });
        await store.Db.DesignArtifactRuns.InsertOneAsync(manual);
        var manualIssued=await issuer.IssueAsync(manual,DateTime.UtcNow.AddMinutes(5),CancellationToken.None);
        var manualGrant=await gw.Database.GetCollection<GatewayRuntimeGrantRecord>("llmgw_runtime_grants")
            .Find(x=>x.Id==manualIssued.Id).SingleAsync();
        Assert.Equal(GatewayPptCompletionPhases.ManualSave,manualGrant.PptCompletionPhase);
        var manualDecision=await counter.TryReserveAsync(manualGrant,new GatewayRuntimeGrantCallRequest(
            "manual-request",1_000,4_096,"default-chat-curated","current-provider","current-model"),CancellationToken.None);
        Assert.True(manualDecision.Allowed,manualDecision.ErrorCode);
        await counter.FinalizeAsync(manualGrant,"manual-request",null,"usage-unavailable",CancellationToken.None);
        var completedBudget=await scopes.Find(x=>x.Id==first.ScopeId).SingleAsync();
        Assert.Equal(1,completedBudget.PptCompletion!.ManualSave.UsedPhysicalCalls);
        Assert.Equal(2,completedBudget.Reservations.Count);
        Assert.All(completedBudget.Reservations,x=>Assert.Equal("settled-unknown",x.Status));
        // 客户端接纳后失去SSE，再次手动保存须重放同一身份，不认领第二个ManualSave或新增预占。
        var budgetBeforeReplay=completedBudget.ToJson();
        var grantCountBeforeReplay=await gw.Database.GetCollection<GatewayRuntimeGrantRecord>("llmgw_runtime_grants")
            .CountDocumentsAsync(FilterDefinition<GatewayRuntimeGrantRecord>.Empty);
        var manualReplay=await service.AdmitModificationAsync(edit.Id,"owner",manualBase.Context,
            manualSaveKey,manualHash,CancellationToken.None,isManualSave:true);
        Assert.Equal(manualAdmission.RunId,manualReplay.RunId);
        Assert.Equal(manualAdmission.ScopeId,manualReplay.ScopeId);
        Assert.Equal(manualAdmission.CompletionId,manualReplay.CompletionId);
        Assert.Equal(budgetBeforeReplay,(await scopes.Find(x=>x.Id==first.ScopeId).SingleAsync()).ToJson());
        Assert.Equal(grantCountBeforeReplay,await gw.Database.GetCollection<GatewayRuntimeGrantRecord>("llmgw_runtime_grants")
            .CountDocumentsAsync(FilterDefinition<GatewayRuntimeGrantRecord>.Empty));
        Assert.Equal(oldBytes,(await scopes.Find(x=>x.Id==template.Id).SingleAsync()).ToJson());

        // M 完成后走真实协调器与版本发布服务；仅对象存储替换使用桩，仍核线上 ContentVersion CAS。
        manual.Status = RunStatuses.Done;
        manual.Runtime = DesignArtifactRuntimes.OpenDesign;
        manual.TargetSiteId = f.Site.Id;
        manual.ProducedArtifactSiteId = f.Site.Id;
        manual.ProducedArtifactRevisionId = "manual-draft";
        manual.WorkspaceResultSha256 = new string('9',64);
        await store.Db.DesignArtifactRuns.ReplaceOneAsync(x=>x.Id==manual.Id,manual);
        var manualRun = await store.Db.MdToPptRuns.Find(x=>x.Id==manual.Id).SingleAsync();
        manualRun.Status = "done";
        manualRun.Html = proposal;
        manualRun.HtmlHash = MdToPptController.ComputeHtmlHash(proposal);
        await store.Db.MdToPptRuns.ReplaceOneAsync(x=>x.Id==manual.Id,manualRun);
        var manualFiles = f.Current.VerifiedFiles.Select(x=>new HostedSiteRevisionFile
        { Path=x.Path,Content=x.Content.ToArray(),Sha256=x.Sha256,MimeType=x.MimeType }).ToList();
        manualFiles[0].Content = Encoding.UTF8.GetBytes(proposal);
        manualFiles[0].Sha256 = manualRun.HtmlHash;
        var manualDraft = new HostedSiteRevision
        {
            Id="manual-draft",SiteId=f.Site.Id,CreatedByUserId="owner",SourceRunId=manual.Id,
            Runtime=DesignArtifactRuntimes.OpenDesign,Status=HostedSiteRevisionStatuses.Draft,
            ParentRevisionId="new-edit-draft",BasedOnContentVersion=f.Site.ContentVersion,
            Html=proposal,VerifiedFiles=manualFiles,
        };
        await store.Db.HostedSiteRevisions.InsertOneAsync(manualDraft);
        f.Site.Files = f.Current.VerifiedFiles.Select(x=>new HostedSiteFile
        { Path=x.Path,Size=x.Content.Length,MimeType=x.MimeType,CosKey="test/"+x.Path }).ToList();
        await store.Db.HostedSites.ReplaceOneAsync(x=>x.Id==f.Site.Id,f.Site);
        var onlineHtml = f.Current.Html;
        var sites = new Mock<IHostedSiteService>(MockBehavior.Strict);
        sites.Setup(x=>x.GetTeamsNotPublishableAsync("owner",It.IsAny<IReadOnlyCollection<string>>(),It.IsAny<CancellationToken>()))
            .ReturnsAsync(Array.Empty<string>());
        sites.Setup(x=>x.GetEditableEntryHtmlAsync(f.Site.Id,"owner",It.IsAny<CancellationToken>()))
            .ReturnsAsync(()=>new HostedSiteEditableEntry(f.Site,onlineHtml,f.Site.ContentVersion));
        sites.Setup(x=>x.GetRevisionEntryHtmlAsync(f.Site.Id,"owner",It.IsAny<CancellationToken>()))
            .ReturnsAsync(()=>new HostedSiteEditableEntry(f.Site,onlineHtml,f.Site.ContentVersion));
        sites.Setup(x=>x.ReplaceWithVerifiedFilesAsync(f.Site.Id,"owner",It.IsAny<IReadOnlyList<HostedSiteVerifiedFile>>(),
                It.IsAny<DateTime>(),"manual-draft",It.IsAny<CancellationToken>()))
            .Returns(async (string _,string _,IReadOnlyList<HostedSiteVerifiedFile> files,DateTime fence,string revisionId,CancellationToken _) =>
            {
                Assert.Equal(f.Site.ContentVersion,fence);
                Assert.Equal(2,files.Count);
                onlineHtml=Encoding.UTF8.GetString(files.Single(x=>x.Path=="index.html").Content);
                f.Site.ContentVersion=f.Site.ContentVersion.AddSeconds(1);
                f.Site.PublishedRevisionId=revisionId;
                await store.Db.HostedSites.ReplaceOneAsync(x=>x.Id==f.Site.Id,f.Site);
                return f.Site;
            });
        var lifecycle = new Mock<IWebPageDesignArtifactLifecycleAdapter>(MockBehavior.Strict);
        lifecycle.Setup(x=>x.BindPublishedAsync(manual.Id,f.Site.Id,"manual-draft",It.IsAny<CancellationToken>()))
            .Returns(async () => { await store.Db.DesignArtifactRuns.UpdateOneAsync(x=>x.Id==manual.Id,
                Builders<DesignArtifactRun>.Update.Set(x=>x.ArtifactSiteId,f.Site.Id).Set(x=>x.ArtifactRevisionId,"manual-draft")); });
        var publisher = new HtmlPptPublishCoordinator(store.Db,sites.Object,new HostedSiteRevisionService(store.Db,sites.Object),
            Mock.Of<IHtmlPptDesignArtifactAdapter>(MockBehavior.Strict),NullLogger<HtmlPptPublishCoordinator>.Instance,lifecycle.Object,service);
        var published = await publisher.PublishAsync(manualRun,"现有演示稿",null,[],[]);
        Assert.Equal("manual-draft",published.Revision.Id);
        Assert.Equal(HostedSiteRevisionStatuses.Published,published.Revision.Status);
        Assert.Equal(proposal,onlineHtml);
        Assert.Equal("new-edit-draft",published.Revision.ParentRevisionId);
        Assert.Equal("restored",manual.PptEditContext!.BasePublishedRevisionId);
        // 同一线上围栏已被 M 推进，另一条旧草稿不得覆盖；未带新合同的旧发布路径也不能借道。
        foreach (var legacy in new[] { false, true })
        {
            var blockedId=legacy?"legacy-edit":"stale-edit";
            var blockedRun=new MdToPptRun
            { Id=blockedId,UserId="owner",Status="done",Op="patch",Html=proposal,HtmlHash=manualRun.HtmlHash };
            await store.Db.MdToPptRuns.InsertOneAsync(blockedRun);
            await store.Db.DesignArtifactRuns.InsertOneAsync(new DesignArtifactRun
            {
                Id=blockedId,UserId="owner",DeploymentSlug=DeploymentScope.Current,
                ArtifactType=DesignArtifactTypes.HtmlPpt,Runtime=DesignArtifactRuntimes.OpenDesign,
                Operation=DesignArtifactOperations.Edit,Status=RunStatuses.Done,TargetSiteId=f.Site.Id,
                ProducedArtifactSiteId=f.Site.Id,ProducedArtifactRevisionId=blockedId+"-draft",
                WorkspaceResultSha256=new string('9',64),PptEditContext=legacy?null:manualBase.Context,
                PresentationInput=manual.PresentationInput,
            });
            await store.Db.HostedSiteRevisions.InsertOneAsync(new HostedSiteRevision
            {
                Id=blockedId+"-draft",SiteId=f.Site.Id,CreatedByUserId="owner",SourceRunId=blockedId,
                Runtime=DesignArtifactRuntimes.OpenDesign,Status=HostedSiteRevisionStatuses.Draft,
                ParentRevisionId="new-edit-draft",BasedOnContentVersion=manualBase.Context.BaseContentVersion,
                Html=proposal,VerifiedFiles=manualFiles,
            });
            await Assert.ThrowsAsync<HtmlPptPublishPendingException>(()=>publisher.PublishAsync(blockedRun,"演示稿",null,[],[]));
        }
        var finished=await store.Db.MdToPptRuns.Find(x=>x.Id==manual.Id).SingleAsync();
        var replayed=await publisher.PublishAsync(finished,"无效重放标题",null,[],[]);
        Assert.Equal(published.Revision.Id,replayed.Revision.Id);
        sites.Verify(x=>x.ReplaceWithVerifiedFilesAsync(f.Site.Id,"owner",It.IsAny<IReadOnlyList<HostedSiteVerifiedFile>>(),
            It.IsAny<DateTime>(),"manual-draft",It.IsAny<CancellationToken>()),Times.Once);
        Assert.Equal("manual-draft",(await store.Db.HostedSites.Find(x=>x.Id==f.Site.Id).SingleAsync()).PublishedRevisionId);
        Assert.Equal(oldBytes,(await scopes.Find(x=>x.Id==template.Id).SingleAsync()).ToJson());
    }

    private static (MdToPptRun Source, DesignArtifactRun Artifact, HostedSite Site,
        HostedSiteRevision Origin, HostedSiteRevision Current) Fixture()
    {
        const string html = "<!doctype html><html><head></head><body><h1>现有演示稿</h1></body></html>";
        static HostedSiteRevisionFile File(string path, string mime, string value)
        {
            var bytes = Encoding.UTF8.GetBytes(value);
            return new() { Path=path, MimeType=mime, Content=bytes,
                Sha256=Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant() };
        }
        List<HostedSiteRevisionFile> Files() => [File("index.html", "text/html", html), File("assets/style.css", "text/css", "body{color:#111}")];
        var now = new DateTime(2026,10,24,14,14,51,DateTimeKind.Utc);
        var source = new MdToPptRun { Id="saved-run", UserId="owner", Status="done", Op="patch", Html=html };
        var artifact = new DesignArtifactRun { Id=source.Id, UserId="owner", Status="Done", ArtifactType="html-ppt",Runtime=DesignArtifactRuntimes.OpenDesign,
            ArtifactSiteId="site", ProducedArtifactSiteId="site", ArtifactRevisionId="original", ProducedArtifactRevisionId="original",
            WorkspaceResultSha256=new string('d',64), PresentationInput=new() };
        var site = new HostedSite { Id="site", OwnerUserId="owner", SourceType="design-agent", PublishedRevisionId="restored", ContentVersion=now };
        var origin = new HostedSiteRevision { Id="original", SiteId="site", CreatedByUserId="owner", SourceRunId=source.Id,
            Source=HostedSiteRevisionSources.AiEdit, Status="published", Html=html, VerifiedFiles=Files() };
        var current = new HostedSiteRevision { Id="restored", SiteId="site", CreatedByUserId="owner", Source="rollback",
            RollbackTargetRevisionId=origin.Id, Status="published", Html=html, VerifiedFiles=Files(), PublishedContentVersion=now };
        return (source, artifact, site, origin, current);
    }
}
