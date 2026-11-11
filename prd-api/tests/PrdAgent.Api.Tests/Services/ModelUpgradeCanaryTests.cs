using Microsoft.Extensions.Configuration;
using MongoDB.Bson;
using PrdAgent.Api.Services.BackgroundTasks;
using PrdAgent.Core.LlmGateway;
using PrdAgent.Core.Models;
using PrdAgent.LlmGatewayHost;
using System.Reflection;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public sealed class ModelUpgradeCanaryTests
{
    [Fact]
    public void DeploymentAuthorization_IsExplicitAndScoped()
    {
        IConfiguration C(params (string, string)[] items) => new ConfigurationBuilder().AddInMemoryCollection(
            items.Select(x => new KeyValuePair<string,string?>(x.Item1,x.Item2))).Build();
        Assert.False(ModelUpgradeCanaryWorker.Enabled(C()));
        Assert.False(ModelUpgradeCanaryWorker.Enabled(C(("LlmGateway:ModelUpgrades:CanaryEnabled","true"))));
        Assert.False(ModelUpgradeCanaryWorker.Enabled(C(("LlmGateway:ModelUpgrades:CanaryEnabled","true"),
            ("LlmGateway:ModelUpgrades:CanaryDeployment","different"))));
        Assert.True(ModelUpgradeCanaryWorker.Enabled(C(("LlmGateway:ModelUpgrades:CanaryEnabled","true"),
            ("LlmGateway:ModelUpgrades:CanaryDeployment","prd-agent:production"))));
    }

    [Fact]
    public void PolicyRecheck_AllowsPollingVersionButRejectsChangedCandidateActorAndBudget()
    {
        var (job, state) = Pair();
        Assert.True(ModelUpgradeCanaryWorker.MatchesPolicy(job,state));
        state["Version"] = 5;
        Assert.True(ModelUpgradeCanaryWorker.MatchesPolicy(job,state));
        foreach (var field in new[] { "ActorUserId", "ActorConsoleUserId", "TenantId" })
        {
            var copy = state.DeepClone().AsBsonDocument; copy[field] = "other";
            Assert.False(ModelUpgradeCanaryWorker.MatchesPolicy(job,copy));
        }
        foreach (var field in new[] { "ValidationRequestId", "Fingerprint", "ModelId", "ProviderId", "UpstreamModelId" })
        {
            var copy = state.DeepClone().AsBsonDocument; copy["Candidate"][field] = "other";
            Assert.False(ModelUpgradeCanaryWorker.MatchesPolicy(job,copy));
        }
        state["ReservedCostUsd"] = 0;
        Assert.False(ModelUpgradeCanaryWorker.MatchesPolicy(job,state));
    }

    [Fact]
    public void ScheduledValidation_RequiresExplicitPolicyOptIn()
    {
        var (job,state)=Pair(); job["ExecutionRequestedBy"]="scheduled";
        Assert.False(ModelUpgradeCanaryWorker.MatchesPolicy(job,state));
        state["Policy"]["Enabled"]=true; state["Policy"]["AutoValidate"]=true;
        Assert.True(ModelUpgradeCanaryWorker.MatchesPolicy(job,state));
        state["Policy"]["AutoValidate"]=false;
        Assert.False(ModelUpgradeCanaryWorker.MatchesPolicy(job,state));
    }

    [Fact]
    public void ResolutionMustMatchFrozenOfferingAndPhysicalIdentity()
    {
        var (job,_) = Pair();
        var resolution = new GatewayModelResolution { Success=true, ActualPlatformId="provider", ActualPlatformName="Official",
            ActualModel="candidate", OfferingId="route", LogicalModelPublicId="fixed", Protocol="openai" };
        job["Provider"]="Official"; job["CandidateOfferingId"]="route";job["CandidateLogicalModelPublicId"]="fixed";job["Protocol"]="openai";
        Assert.True(ModelUpgradeCanaryWorker.MatchesResolution(job,resolution));
        job["CandidateOfferingId"]="replacement";
        Assert.False(ModelUpgradeCanaryWorker.MatchesResolution(job,resolution));
    }

    [Theory]
    [InlineData("{}",false)]
    [InlineData("{\"data\":[]}",false)]
    [InlineData("{\"error\":\"rejected\"}",false)]
    [InlineData("{\"data\":[{\"b64_json\":\"image-output\"}]}",true)]
    public void CanaryCompletionRequiresActualOutput(string body,bool expected)
        => Assert.Equal(expected,ModelUpgradeCanaryWorker.HasImageOutput(body));

    [Fact]
    public void BoundedCanaryContract_DoesNotInventProviderPerCallPrice()
    {
        var policy = new TaskBudgetContractPolicy { AuthorizedLimitUsd=.05m, CanaryUnitCostUpperBoundUsd=.05m,
            ExpectedOfferingId="route", MaxOutputTokens=1, LogicalModelPublicId="fixed", Provider="Official",Model="candidate",
            Protocol="openai",PriceVersion="version",CachedInputUsdPerMillion=0,CacheWriteUsdPerMillion=0 };
        Assert.True(policy.Valid());
        policy.ExpectedOfferingId=null;Assert.False(policy.Valid());
        policy.ExpectedOfferingId="route";policy.CanaryUnitCostUpperBoundUsd=.06m;Assert.False(policy.Valid());
        policy.CanaryUnitCostUpperBoundUsd=null;Assert.False(policy.Valid());
    }

    [Theory]
    [InlineData("gpt-image-2.6",.05,true)]
    [InlineData("gpt-image-2.6",.0001,false)]
    [InlineData("gpt-image-future",.05,false)]
    public void ImageEnvelope_RequiresKnownSpecificationAndSufficientBudget(string model,double upper,bool expected)
        => Assert.Equal(expected,ModelUpgradeCanaryWorker.HasSufficientKnownImageEnvelope(model,(decimal)upper,5m,30m));

    [Fact]
    public void MediaBudgetGuard_RequiresCanaryPermitExactRouteAndSmallLowImage()
    {
        var permit = new GatewayTaskPermitRecord { SourceTask="ModelUpgradeCanaryWorker:test",MaxCalls=1,MaxRuns=1 };
        var scope = new GatewayRuntimeBudgetScopeRecord { CanaryUnitCostUpperBoundUsd=.05m,AuthorizedLimitUsd=.05m,
            MaxPhysicalCalls=1,ExpectedOfferingId="route",ExpectedLogicalModelPublicId="fixed",ExpectedProvider="Official",
            ExpectedModel="gpt-image-2",PriceProtocol="openai",ExpiresAt=DateTime.UtcNow.AddMinutes(5) };
        var resolution = new GatewayModelResolution { LogicalModelPublicId="fixed",ActualPlatformName="Official",ActualModel="gpt-image-2",
            OfferingId="route",Protocol="openai" };
        GatewayRawRequest Request(int n=1,string quality="low") => new() { AppCallerCode="visual.image",ModelType=ModelTypes.ImageGen,
            RequiredOfferingId="route",CanonicalImageRequest=new() { Prompt="A circle",Count=n,Size="1024x1024",Quality=quality } };
        bool Allowed(GatewayRawRequest r) => (bool)typeof(TaskBudgetGateway).GetMethod("AllowsBoundedImageCanary",BindingFlags.NonPublic|BindingFlags.Static)!
            .Invoke(null,new object?[]{permit,scope,r,resolution})!;
        Assert.True(Allowed(Request()));
        Assert.False(Allowed(Request(2)));
        Assert.False(Allowed(Request(1,"high")));
        scope.ExpectedOfferingId="other";Assert.False(Allowed(Request()));scope.ExpectedOfferingId="route";
        permit.SourceTask="OrdinaryImageWorker:test";Assert.False(Allowed(Request()));
    }

    private static (BsonDocument Job,BsonDocument State) Pair()
    {
        var job = new BsonDocument { {"_id","request"},{"TenantId","tenant"},{"LogicalModelId","stable"},{"PolicyVersion",1L},
            {"CandidateFingerprint","hash"},{"ModelId","model"},{"ProviderId","provider"},{"UpstreamModelId","candidate"},
            {"ActorUserId","owner"},{"ActorConsoleUserId","console-owner"},{"ActorUsername","owner-name"},
            {"ExecutionRequestedBy","manual"},{"AppCallerCode","visual.image"},{"MaxCostUsd",.1m},{"MaxDailyCostUsd",1m},
            {"UnitCostUpperBoundUsd",.05m},{"EstimatedCostUsd",.05m} };
        var state = new BsonDocument { {"TenantId","tenant"},{"LogicalModelId","stable"},{"Version",1L},
            {"ActorUserId","owner"},{"ActorConsoleUserId","console-owner"},{"ActorUsername","owner-name"},
            {"ReservedCostUsd",.05m},{"BudgetDate",DateTime.UtcNow.ToString("yyyy-MM-dd")},
            {"Candidate",new BsonDocument { {"ValidationRequestId","request"},{"Fingerprint","hash"},{"ModelId","model"},{"ProviderId","provider"},{"UpstreamModelId","candidate"} }},
            {"Policy",new BsonDocument { {"Enabled",false},{"AutoValidate",false},{"ValidationAppCallerCode","visual.image"},
                {"MaxValidationCostUsd",.1m},{"MaxDailyCostUsd",1m},{"CanaryUnitCostUpperBoundUsd",.05m} }} };
        return(job,state);
    }
}
