using System.Security.Claims;
using System.Text;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Moq;
using MongoDB.Bson;
using PrdAgent.Api.Controllers.Api;
using PrdAgent.Api.Services;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.LlmGateway;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using Xunit;
using GatewayContract=PrdAgent.Core.LlmGateway.ILlmGateway;

namespace PrdAgent.Api.Tests.Services;

public sealed class ModelLabLogicalReferenceTests
{
    private static readonly IReadOnlyList<BusinessModelOption> Options=new[] { new BusinessModelOption("logical-one","official-version","Authorized model",true,null),
        new BusinessModelOption("disabled","disabled-version","Unavailable",false,"No available route") };
    [Fact]
    public void NewSelection_RequiresAuthorizedLogicalIdentity_AndDoesNotGuessSamePhysicalName()
    {
        Assert.True(ModelLabModelReferences.TryNormalize(Options,new[] { new ModelLabSelectedModel { LogicalModelId="logical-one",ModelId="old-name",PlatformId="old-platform" } },null,out var models,out _));
        var model=Assert.Single(models);Assert.Equal("logical-model",model.PlatformId);Assert.Equal("official-version",model.ModelId);Assert.Equal(model.ModelId,model.ModelName);
        Assert.False(ModelLabModelReferences.TryNormalize(Options,new[] { new ModelLabSelectedModel { PlatformId="old-platform",ModelId="official-version" } },null,out _,out _));
        Assert.False(ModelLabModelReferences.TryNormalize(Options,new[] { new ModelLabSelectedModel { LogicalModelId="disabled" } },null,out _,out _));
    }
    [Fact]
    public void OldInvalidSelection_CanRemainForDisplayRepair_ButCannotExecuteOrMultiply()
    {
        var old=new ModelLabSelectedModel { PlatformId="deleted-platform",ModelId="old-physical-name",Name="kept" };
        Assert.True(ModelLabModelReferences.TryNormalize(Options,new[] { old },new[] { old },out var saved,out _));
        Assert.Equal("deleted-platform",saved[0].PlatformId);Assert.Equal("legacy",saved[0].ModelReferenceStatus);
        Assert.False(ModelLabModelReferences.TryNormalize(Options,saved,null,out _,out _));
        Assert.False(ModelLabModelReferences.TryNormalize(Options,new[] { old,old },new[] { old },out _,out _));
        ModelLabModelReferences.Annotate(new[] { old },Options);Assert.Equal("old-physical-name",old.ModelId);
        Assert.False(old.ToBsonDocument().Contains("ModelReferenceStatus"));
    }
    [Fact]
    public async Task SaveAndRepair_PreservesModelSetIdentityAndCreationTime()
    {
        var f=new Fixture();var old=new ModelLabModelSet { Id="original-set",OwnerAdminId="owner",CreatedAt=new DateTime(2026,1,1),
            Models=new() { new() { PlatformId="deleted",ModelId="legacy" } } };
        f.Repo.Setup(x=>x.GetModelSetAsync(old.Id,"owner")).ReturnsAsync(old);
        f.Repo.Setup(x=>x.UpsertModelSetAsync(It.IsAny<ModelLabModelSet>(),It.IsAny<DateTime?>())).ReturnsAsync((ModelLabModelSet set,DateTime? expected)=>set);
        var response=await f.Controller.UpsertModelSet(new UpsertModelSetRequest { Id=old.Id,Name="repaired",Models=new() { new() { LogicalModelId="logical-one" } } });
        Assert.IsType<OkObjectResult>(response);Assert.Equal("original-set",old.Id);Assert.Equal(new DateTime(2026,1,1),old.CreatedAt);
        Assert.Equal("logical-one",old.Models[0].LogicalModelId);Assert.Equal("official-version",old.Models[0].ModelId);
    }
    [Fact]
    public async Task ReadDuringCatalogFailure_PreservesOldConfigurationAndMarksUnknown()
    {
        var f=new Fixture();var exp=new ModelLabExperiment { Id="saved-experiment",SelectedModels=new() { new() { PlatformId="old",ModelId="kept" } } };
        f.Repo.Setup(x=>x.GetExperimentAsync(exp.Id,"owner")).ReturnsAsync(exp);
        f.Gateway.Setup(x=>x.GetAvailablePoolsAsync(AppCallerRegistry.Admin.ModelLab.Run,ModelTypes.Chat,It.IsAny<CancellationToken>())).ThrowsAsync(new HttpRequestException("synthetic"));
        Assert.IsType<OkObjectResult>(await f.Controller.GetExperiment(exp.Id));
        Assert.Equal("kept",exp.SelectedModels[0].ModelId);Assert.Equal("unknown",exp.SelectedModels[0].ModelReferenceStatus);
        Assert.DoesNotContain("synthetic",exp.SelectedModels[0].ModelReferenceReason);
    }
    [Fact]
    public async Task InvalidLegacyRun_IsRejectedBeforeCreatingRunOrGatewayClient()
    {
        var f=new Fixture();await f.Controller.RunStream(new RunStreamRequest { Models=new() { new() { PlatformId="deleted",ModelId="official-version" } },PromptText="hi" },default);
        Assert.Contains("MODEL_REFERENCE_INVALID",f.Output);
        f.Repo.Verify(x=>x.InsertRunAsync(It.IsAny<ModelLabRun>()),Times.Never);
        f.Gateway.Verify(x=>x.CreateClient(It.IsAny<string>(),It.IsAny<string>(),It.IsAny<int>(),It.IsAny<double>(),It.IsAny<bool>(),It.IsAny<string?>(),It.IsAny<string?>(),It.IsAny<string?>()),Times.Never);
    }
    [Theory]
    [InlineData(true,false)]
    [InlineData(false,true)]
    public async Task LegacyAutomaticSelection_IsNotSilentlyMappedToDefault(bool main,bool oldIds)
    {
        var f=new Fixture();await f.Controller.RunStream(new RunStreamRequest { IncludeMainModelAsStandard=main,ModelIds=oldIds?new() { "old-physical-id" }:null,
            Models=oldIds?null:new() { new() { LogicalModelId="logical-one" } } },default);
        Assert.Contains("MODEL_REFERENCE_REQUIRED",f.Output);f.Repo.Verify(x=>x.InsertRunAsync(It.IsAny<ModelLabRun>()),Times.Never);
    }
    [Fact]
    public async Task AuthorizedRun_UsesCanonicalPublicIdWithoutPhysicalPins_AndPersistsLogicalSnapshot()
    {
        var f=new Fixture();var client=new Mock<ILLMClient>(MockBehavior.Strict);
        client.Setup(x=>x.StreamGenerateAsync(It.IsAny<string>(),It.IsAny<List<LLMMessage>>(),true,It.IsAny<CancellationToken>())).Returns(Chunks());
        f.Gateway.Setup(x=>x.CreateClient(AppCallerRegistry.Admin.ModelLab.Run,ModelTypes.Chat,4096,.2,false,"official-version",null,null)).Returns(client.Object);
        f.Repo.Setup(x=>x.InsertRunAsync(It.IsAny<ModelLabRun>())).ReturnsAsync((ModelLabRun run)=>run);
        f.Repo.Setup(x=>x.UpdateRunAsync(It.IsAny<ModelLabRun>())).Returns(Task.CompletedTask);
        ModelLabRunItem? captured=null;
        f.Repo.Setup(x=>x.InsertRunItemAsync(It.IsAny<ModelLabRunItem>())).Callback<ModelLabRunItem>(x=>captured=x).ReturnsAsync((ModelLabRunItem item)=>item);
        f.Repo.Setup(x=>x.UpdateRunItemAsync(It.IsAny<ModelLabRunItem>())).Returns(Task.CompletedTask);
        await f.Controller.RunStream(new RunStreamRequest { PromptText="hi",Models=new() { new() { LogicalModelId="logical-one" } } },default);
        Assert.Contains("runDone",f.Output);Assert.NotNull(captured);Assert.True(captured.Success);Assert.Equal("logical-one",captured.LogicalModelId);Assert.Equal("logical-model",captured.PlatformId);
        f.Gateway.Verify(x=>x.CreateClient(AppCallerRegistry.Admin.ModelLab.Run,ModelTypes.Chat,4096,.2,false,"official-version",null,null),Times.Once);
        f.Gateway.Verify(x=>x.ResolveModelAsync(It.IsAny<string>(),It.IsAny<string>(),It.IsAny<string?>(),It.IsAny<string?>(),It.IsAny<string?>(),It.IsAny<CancellationToken>()),Times.Never);
    }
    [Theory]
    [InlineData("image",AppCallerRegistry.VisualAgent.Image.Text2Img)]
    [InlineData("image-batch",AppCallerRegistry.VisualAgent.ImageGen.BatchGenerate)]
    public async Task ImagePurpose_UsesExistingVisualPolicyCaller(string purpose,string caller)
    {
        var f=new Fixture();Assert.IsType<OkObjectResult>(await f.Controller.GetModelOptions(purpose));
        f.VisualModels.Verify(x=>x.ListAsync(caller,It.IsAny<CancellationToken>()),Times.Once);
        f.Gateway.Verify(x=>x.GetAvailablePoolsAsync(AppCallerRegistry.Admin.ModelLab.Run,It.IsAny<string>(),It.IsAny<CancellationToken>()),Times.Never);
    }
    [Fact]
    public async Task PartialCatalogFailure_KeepsKnownAvailableAndMarksOtherReferencesUnknown()
    {
        var f=new Fixture();var exp=new ModelLabExperiment { Id="partial",SelectedModels=new() { new() { LogicalModelId="logical-one",PlatformId="logical-model",ModelId="official-version" },new() { PlatformId="legacy",ModelId="kept" } } };
        f.Repo.Setup(x=>x.GetExperimentAsync(exp.Id,"owner")).ReturnsAsync(exp);
        f.VisualModels.Setup(x=>x.ListAsync(It.IsAny<string?>(),It.IsAny<CancellationToken>())).ThrowsAsync(new HttpRequestException("synthetic"));
        Assert.IsType<OkObjectResult>(await f.Controller.GetExperiment(exp.Id));
        Assert.Equal("available",exp.SelectedModels[0].ModelReferenceStatus);Assert.Equal("unknown",exp.SelectedModels[1].ModelReferenceStatus);Assert.Equal("kept",exp.SelectedModels[1].ModelId);
    }
    [Fact]
    public async Task ImageSelection_CanBeSavedThroughAuthorizedUnionButNotRunAsChat()
    {
        var f=new Fixture();f.VisualModels.Setup(x=>x.ListAsync(AppCallerRegistry.VisualAgent.Image.Text2Img,It.IsAny<CancellationToken>())).ReturnsAsync(new List<AvailableModelPool> { new() {
            Id="logical-image",Code="image-quality",Name="Image",ResolutionType="LogicalModel",Models=new() { new() { HealthStatus="Healthy" } } } });
        ModelLabModelSet? saved=null;f.Repo.Setup(x=>x.UpsertModelSetAsync(It.IsAny<ModelLabModelSet>(),null)).Callback<ModelLabModelSet,DateTime?>((set,_)=>saved=set).ReturnsAsync((ModelLabModelSet set,DateTime? _)=>set);
        Assert.IsType<OkObjectResult>(await f.Controller.UpsertModelSet(new UpsertModelSetRequest { Models=new() { new() { LogicalModelId="logical-image" } } }));
        Assert.Equal("image-quality",Assert.Single(saved!.Models).ModelId);
        await f.Controller.RunStream(new RunStreamRequest { Models=saved.Models,PromptText="hi" },default);
        Assert.Contains("MODEL_REFERENCE_INVALID",f.Output);f.Repo.Verify(x=>x.InsertRunAsync(It.IsAny<ModelLabRun>()),Times.Never);
    }
    [Fact]
    public async Task ConcurrentRepairConflict_DoesNotRetryWithOldModelList()
    {
        var f=new Fixture();var version=new DateTime(2026,11,11,1,2,3,DateTimeKind.Utc);
        var exp=new ModelLabExperiment { Id="existing",UpdatedAt=version,SelectedModels=new() { new() { PlatformId="old",ModelId="kept" } } };
        f.Repo.Setup(x=>x.GetExperimentAsync(exp.Id,"owner")).ReturnsAsync(exp);
        f.Repo.Setup(x=>x.UpdateExperimentAsync(exp,version)).ReturnsAsync(false);
        var result=Assert.IsType<ConflictObjectResult>(await f.Controller.UpdateExperiment(exp.Id,new UpsertExperimentRequest { Name="rename only" }));
        Assert.Equal(409,result.StatusCode);f.Repo.Verify(x=>x.UpdateExperimentAsync(exp,version),Times.Once);
    }
    [Fact]
    public async Task CatalogFailure_DoesNotCreateRunOrSaveUnverifiedNewReference()
    {
        var f=new Fixture();f.Gateway.Setup(x=>x.GetAvailablePoolsAsync(AppCallerRegistry.Admin.ModelLab.Run,ModelTypes.Chat,It.IsAny<CancellationToken>())).ThrowsAsync(new HttpRequestException("synthetic"));
        var response=Assert.IsType<ObjectResult>(await f.Controller.UpsertModelSet(new UpsertModelSetRequest { Models=new() { new() { LogicalModelId="logical-one" } } }));
        Assert.Equal(503,response.StatusCode);
        await f.Controller.RunStream(new RunStreamRequest { Models=new() { new() { LogicalModelId="logical-one" } } },default);
        Assert.Contains("MODEL_CATALOG_UNAVAILABLE",f.Output);f.Repo.Verify(x=>x.InsertRunAsync(It.IsAny<ModelLabRun>()),Times.Never);
        f.Repo.Verify(x=>x.UpsertModelSetAsync(It.IsAny<ModelLabModelSet>(),It.IsAny<DateTime?>()),Times.Never);
    }

    private static async IAsyncEnumerable<LLMStreamChunk> Chunks(){yield return new() { Type="delta",Content="OK" };await Task.CompletedTask;yield return new() { Type="done" };}
    private sealed class Fixture
    {
        public Mock<IModelLabRepository> Repo { get; }=new(MockBehavior.Strict);
        public Mock<GatewayContract> Gateway { get; }=new(MockBehavior.Strict);
        public Mock<IVisualModelPolicyService> VisualModels { get; }=new(MockBehavior.Strict);
        public ModelLabController Controller { get; }
        private readonly MemoryStream output=new();public string Output=>Encoding.UTF8.GetString(output.ToArray());
        public Fixture()
        {
            Gateway.Setup(x=>x.GetAvailablePoolsAsync(AppCallerRegistry.Admin.ModelLab.Run,ModelTypes.Chat,It.IsAny<CancellationToken>())).ReturnsAsync(new List<AvailableModelPool> {
                new() { Id="logical-one",Code="official-version",Name="Authorized model",ResolutionType="LogicalModel",Models=new() { new() { HealthStatus="Healthy" } } } });
            VisualModels.Setup(x=>x.ListAsync(It.IsAny<string?>(),It.IsAny<CancellationToken>())).ReturnsAsync(new List<AvailableModelPool>());
            var contexts=new Mock<ILLMRequestContextAccessor>();contexts.Setup(x=>x.BeginScope(It.IsAny<LlmRequestContext>())).Returns(Mock.Of<IDisposable>());
            Controller=new ModelLabController(new MongoDbContext("mongodb://127.0.0.1:1/?serverSelectionTimeoutMS=10","unit-test-no-network"),Repo.Object,contexts.Object,Gateway.Object,new BusinessModelReferenceService(Gateway.Object),VisualModels.Object);
            Controller.ControllerContext=new ControllerContext { HttpContext=new DefaultHttpContext() };
            Controller.HttpContext.User=new ClaimsPrincipal(new ClaimsIdentity(new[] { new Claim(ClaimTypes.NameIdentifier,"owner") },"Test"));
            Controller.Response.Body=output;
        }
    }
}
