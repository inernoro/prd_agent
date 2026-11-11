using Microsoft.Extensions.Configuration;
using MongoDB.Bson;
using PrdAgent.Api.Services.BackgroundTasks;
using PrdAgent.Core.LlmGateway;
using PrdAgent.Core.Models;
using PrdAgent.LlmGatewayHost;
using System.Reflection;
using PrdAgent.Infrastructure.LlmGateway;
using System.Text.Json.Nodes;
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
            ("Deployment:Identity","prd-agent:production"),
            ("LlmGateway:ModelUpgrades:CanaryDeployment","prd-agent:production"))));
        Assert.False(ModelUpgradeCanaryWorker.Enabled(C(("LlmGateway:ModelUpgrades:CanaryEnabled","true"),
            ("LlmGateway:ModelUpgrades:CanaryDeployment","prd-agent:production"))));
        Assert.True(ModelUpgradeCanaryWorker.Enabled(C(("LlmGateway:ModelUpgrades:CanaryEnabled","true"),
            ("CDS_PROJECT_ID","prd-agent"),("VITE_GIT_BRANCH","main"),
            ("LlmGateway:ModelUpgrades:CanaryDeployment","prd-agent::main"))));
        Assert.False(ModelUpgradeCanaryWorker.Enabled(C(("LlmGateway:ModelUpgrades:CanaryEnabled","true"),
            ("CDS_PROJECT_ID","prd-agent"),("VITE_GIT_BRANCH","codex/preview"),
            ("LlmGateway:ModelUpgrades:CanaryDeployment","prd-agent::codex/preview"))));
        Assert.False(ModelUpgradeCanaryWorker.Enabled(C(("LlmGateway:ModelUpgrades:CanaryEnabled","true"),
            ("CDS_PROJECT_ID","prd-agent"),("LlmGateway:ModelUpgrades:CanaryDeployment","prd-agent::main"))));
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

    [Fact]
    public void PendingClaim_ExcludesExpiredJobsAndKeepsScheduledOptIn()
    {
        var now = new DateTime(2026,11,11,10,0,0,DateTimeKind.Utc);
        var filter = ModelUpgradeCanaryWorker.PendingClaimFilter("tenant",now,false);
        Assert.Equal(now,filter["ExpiresAt"]["$gt"].ToUniversalTime());
        Assert.Equal("pending",filter["Status"].AsString);
        Assert.Equal("manual",filter["ExecutionRequestedBy"].AsString);
        Assert.False(ModelUpgradeCanaryWorker.PendingClaimFilter("tenant",now,true).Contains("ExecutionRequestedBy"));
    }

    [Theory]
    [InlineData(false,"failed",true)]
    [InlineData(true,"failed",false)]
    [InlineData(true,"unknown",false)]
    [InlineData(true,"succeeded",false)]
    public void RefundEvidence_OnlyConfirmsUnsentBeforeEnteringPaidClient(bool entered,string status,bool unsent)
    {
        var fields = ModelUpgradeCanaryWorker.CompletionFields(status,"message",entered,DateTime.UtcNow);
        Assert.Equal(unsent,fields["UnsentConfirmed"].AsBoolean);
    }

    [Fact]
    public void OfferingWireSnapshot_IgnoresHealthButRejectsChangedWireOrMissingVersion()
    {
        var at = new DateTime(2026,11,11,10,0,0,DateTimeKind.Utc);
        var offering = new BsonDocument { {"_id","route"},{"LogicalModelId","logical"},{"TargetKind","model"},{"TargetId","physical"},
            {"UpstreamModelId","candidate"},{"Protocol","openai"},{"EndpointPath","chat/completions"},{"Enabled",true},{"UpdatedAt",at} };
        var job = new BsonDocument { {"OfferingVersion",ModelUpgradeCanaryWorker.OfferingWireVersion(offering)},
            {"EndpointPath","chat/completions"},{"Protocol","openai"} };
        Assert.True(ModelUpgradeCanaryWorker.MatchesOfferingSnapshot(job,offering,"openai"));
        Assert.False(ModelUpgradeCanaryWorker.MatchesOfferingSnapshot(job,offering,"claude"));
        offering["EndpointPath"]="responses";
        Assert.False(ModelUpgradeCanaryWorker.MatchesOfferingSnapshot(job,offering,"openai"));
        offering["EndpointPath"]="chat/completions";offering["UpdatedAt"]=at.AddSeconds(1);
        offering["HealthStatus"]="healthy";offering["Priority"]=50;
        Assert.True(ModelUpgradeCanaryWorker.MatchesOfferingSnapshot(job,offering,"openai"));
        foreach (var field in new[] { "_id", "LogicalModelId", "TargetKind", "TargetId", "UpstreamModelId", "Protocol", "EndpointPath" })
        {
            var changed = offering.DeepClone().AsBsonDocument;changed[field]="changed";
            Assert.False(ModelUpgradeCanaryWorker.MatchesOfferingSnapshot(job,changed,"openai"));
        }
        var disabled = offering.DeepClone().AsBsonDocument;disabled["Enabled"]=false;
        Assert.False(ModelUpgradeCanaryWorker.MatchesOfferingSnapshot(job,disabled,"openai"));
        job.Remove("OfferingVersion");
        Assert.False(ModelUpgradeCanaryWorker.MatchesOfferingSnapshot(job,offering,"openai"));
    }

    [Fact]
    public void ChatCanaryRequest_PinsCandidateOfferingAndSmallOutput()
    {
        var job = new BsonDocument { {"CandidateLogicalModelPublicId","fixed-candidate"},{"CandidateOfferingId","candidate-route"},
            {"AppCallerCode","chat.test"},{"EndpointPath","custom/chat/completions"} };
        var request = ModelUpgradeCanaryWorker.CreateChatCanaryRequest(job,new GatewayRequestContext { RequestId="existing-request" });
        Assert.Equal("fixed-candidate",request.RequiredLogicalModelPublicId);
        Assert.Equal("candidate-route",request.RequiredOfferingId);
        Assert.Equal("custom/chat/completions",request.EndpointPath);
        Assert.Equal(16,request.RequestBody!["max_tokens"]!.GetValue<int>());
        Assert.Equal("existing-request",request.Context!.RequestId);
    }

    [Theory]
    [InlineData("{}",false)]
    [InlineData("{\"choices\":[{\"message\":{\"refusal\":\"no\"}}]}",false)]
    [InlineData("{\"choices\":[{\"message\":{\"content\":\" \"}}]}",false)]
    [InlineData("{\"choices\":[{\"message\":{\"content\":\"OK\"}}]}",true)]
    [InlineData("{\"choices\":[{\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"OK\"}]}}]}",true)]
    public void ChatCompletion_RequiresRealAnswer(string body,bool expected)
        => Assert.Equal(expected,ModelUpgradeCanaryWorker.HasChatOutput(body));

    [Fact]
    public void ChatRawBudget_RemainsRestrictedToSingleCanaryPermitAndFrozenRoute()
    {
        var job = new BsonDocument { {"CandidateLogicalModelPublicId","fixed"},{"CandidateOfferingId","route"},{"AppCallerCode","chat.test"},{"EndpointPath",BsonNull.Value} };
        var request = ModelUpgradeCanaryWorker.CreateChatCanaryRequest(job,new GatewayRequestContext());
        var permit = new GatewayTaskPermitRecord { SourceTask="ModelUpgradeCanaryWorker:request",MaxCalls=1,MaxRuns=1 };
        var scope = new GatewayRuntimeBudgetScopeRecord { MaxPhysicalCalls=1,MaxOutputTokens=16,ExpectedOfferingId="route",
            ExpectedLogicalModelPublicId="fixed",ExpectedProvider="Official",ExpectedModel="chat-version",PriceProtocol="openai",ExpiresAt=DateTime.UtcNow.AddMinutes(5) };
        var resolution = new GatewayModelResolution { LogicalModelPublicId="fixed",OfferingId="route",ActualPlatformName="Official",ActualModel="chat-version",Protocol="openai" };
        bool Allowed() => (bool)typeof(TaskBudgetGateway).GetMethod("AllowsBoundedChatCanary",BindingFlags.NonPublic|BindingFlags.Static)!
            .Invoke(null,new object?[]{permit,scope,request,resolution})!;
        Assert.True(Allowed());
        permit.MaxCalls=2;Assert.False(Allowed());permit.MaxCalls=1;
        permit.AllowDelegatedSubjects=true;Assert.False(Allowed());permit.AllowDelegatedSubjects=false;
        scope.ExpectedOfferingId="other";Assert.False(Allowed());scope.ExpectedOfferingId="route";
        scope.CanaryUnitCostUpperBoundUsd=.05m;Assert.False(Allowed());scope.CanaryUnitCostUpperBoundUsd=null;
        request.RequestBody!["max_tokens"]=32;Assert.False(Allowed());
    }

    [Fact]
    public void FinalChatWire_RejectsExpandedTokensImagesAndChangedOffering()
    {
        var request = ModelUpgradeCanaryWorker.CreateChatCanaryRequest(new BsonDocument {
            {"CandidateLogicalModelPublicId","fixed"},{"CandidateOfferingId","route"},{"AppCallerCode","chat.test"} },new GatewayRequestContext());
        var body = request.RequestBody!.DeepClone().AsObject();body["model"]="chat-version";
        bool Wire(string route="route") => LlmGateway.IsBoundedCanaryChatWire(request,route,"openai",body.ToJsonString());
        Assert.True(Wire());Assert.False(Wire("other"));
        body["max_tokens"]=32;Assert.False(Wire());body["max_tokens"]=16;
        body["messages"]![0]!["content"]=new JsonArray(new JsonObject { ["type"]="image_url",["image_url"]="image" });
        Assert.False(Wire());
        body["messages"]![0]!["content"]="Reply OK.";body["stream"]=true;
        Assert.False(Wire());
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
