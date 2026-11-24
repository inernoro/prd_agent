using MongoDB.Bson;
using PrdAgent.LlmGw.ModelUpgrades;
using Xunit;

namespace PrdAgent.Api.Tests.Gateway;

public class ModelUpgradePolicyTests
{
    [Fact]
    public void RotationOnlyAdoptsNewerUnambiguousCatalogVersions()
    {
        var family = new ModelUpgradeFamily("official", "future-text", "https://example.com/models");
        var catalog = new Dictionary<string, long?> { ["future-text-1"] = 10, ["future-text-2"] = 20,
            ["future-text-3"] = 30, ["future-text-preview"] = null, ["future-textlite-10"] = 50 };
        var current = new ModelUpgradeTarget { ProviderId = "official", UpstreamModelId = "future-text-1" };
        Assert.Equal("future-text-3", ModelUpgradeRules.LatestFamilyCandidate(family, current, catalog));
        catalog["future-text-3b"] = 30;
        Assert.Null(ModelUpgradeRules.LatestFamilyCandidate(family, current, catalog));
        catalog.Remove("future-text-3b");
        catalog["future-text-3"] = null;
        Assert.Equal("future-text-2", ModelUpgradeRules.LatestFamilyCandidate(family, current, catalog));
    }

    [Fact]
    public void TapdRotationNeeds48HoursOfDistinctEvidenceAndTrafficTrial()
    {
        var now = DateTime.UtcNow;
        var policy = new ModelUpgradePolicy { ValidationAppCallerCode = "tapd-bug-agent.extract::chat", Family = new("official", "future-text", "https://example.com/models") };
        var candidate = new ModelUpgradeCandidate { ValidatedAt = now, ValidationRoute = new() { OfferingId = "line", OfferingVersion = "wire" } };
        var state = new ModelUpgradeState { Candidate = candidate, Policy = policy, Gates = new() { Validation = true, Capabilities = true } };
        candidate.BusinessSmokeSamples = [new("a", "wire", 0, now.AddHours(-47)), new("b", "wire", 1, now.AddHours(-24)), new("c", "wire", 2, now)];
        Assert.False(ModelUpgradeRules.TapdSmokePasses(candidate, now));
        candidate.BusinessSmokeSamples[0] = new("a", "wire", 0, now.AddHours(-48));
        Assert.True(ModelUpgradeRules.TapdSmokePasses(candidate, now));
        Assert.False(ModelUpgradeRules.CanPromote(state, false, now));
        candidate.TrafficTrialPassedAt = now;
        Assert.True(ModelUpgradeRules.CanPromote(state, false, now));
        candidate.ValidationRoute.OfferingVersion = "other";
        Assert.False(ModelUpgradeRules.CanPromote(state, false, now));
    }
    private static BsonDocument Price(decimal input = 5, decimal output = 30) => new()
    { { "PriceCurrency", "USD" }, { "InputPricePerMillion", new Decimal128(input) }, { "OutputPricePerMillion", new Decimal128(output) }, { "PriceObservedAt", DateTime.UtcNow } };
    private static ModelUpgradePolicy Policy() => new() { Enabled = true, Mode = "auto", AutoValidate = true,
        ValidationAppCallerCode = "visual-agent.image::generation", CanaryUnitCostUpperBoundUsd = .05m, MaxValidationCostUsd = .1m, MaxDailyCostUsd = .2m,
        Successors = [new() { ProviderId = "official", FromModel = "version-a", ToModel = "version-b", DocumentationUrl = "https://openai.com/models", Capabilities = ["image_generation"] }] };
    [Theory]
    [InlineData(true, true, "promote")]
    [InlineData(true, false, "promote")]
    [InlineData(false, true, "validate")]
    [InlineData(false, false, "")]
    public void ScheduledCheckReusesValidEvidenceBeforeConsideringAnotherPaidCanary(bool valid, bool autoValidate, string expected)
    {
        var state = new ModelUpgradeState { ExecutionRequestedBy = "scheduled", Policy = Policy(),
            Current = new() { ModelId = "old" }, Candidate = new() { ModelId = "new", ValidationRoute = new() { OfferingId = "fixed-offering", OfferingVersion = "wire" }, ValidatedAt = valid ? DateTime.UtcNow : DateTime.UtcNow.AddDays(-2) },
            Gates = new() { Capabilities = true, Price = true, Budget = true, Validation = valid } };
        state.Policy.AutoValidate = autoValidate;
        Assert.Equal(expected, ModelUpgradeRules.NextAutomaticAction(state, DateTime.UtcNow));
        Assert.Equal(0, state.ReservedCostUsd);
        state.OutcomeUnknown = true; Assert.Equal("", ModelUpgradeRules.NextAutomaticAction(state, DateTime.UtcNow));
    }
    [Fact] public void DefaultCallerPrefersClaimsAndRequiresRegistryAuthorizationAndScenario()
    {
        var logical = new BsonDocument { { "ModelType", "generation" }, { "Capabilities", new BsonArray { "text2img" } },
            { "AllowedAppCallerCodes", new BsonArray { "visual-agent.image.text2img::generation" } },
            { "DefaultForAppCallerCodes", new BsonArray { "visual-agent.image.text2img::generation" } } };
        var caller = new BsonDocument { { "AppCallerCode", "visual-agent.image.text2img::generation" }, { "RequestType", "generation" }, { "Status", "active" } };
        Assert.Equal("visual-agent.image.text2img::generation", ModelUpgradeRules.DefaultValidationCaller(logical, new[] { caller }));
        caller["RequestType"] = "chat"; Assert.Equal("", ModelUpgradeRules.DefaultValidationCaller(logical, new[] { caller }));
        caller["RequestType"] = "generation"; logical["Capabilities"] = new BsonArray { "img2img" };
        Assert.Equal("", ModelUpgradeRules.DefaultValidationCaller(logical, new[] { caller }));
    }
    [Fact] public void NewStableModelCanValidateWithoutTakingOverAnExistingBusinessDefault()
    {
        var logical = new BsonDocument { { "ModelType", "generation" }, { "Capabilities", new BsonArray { "text2img" } },
            { "AllowedAppCallerCodes", new BsonArray { "visual-agent.image.text2img::generation" } },
            { "DefaultForAppCallerCodes", new BsonArray() } };
        var caller = new BsonDocument { { "AppCallerCode", "visual-agent.image.text2img::generation" }, { "RequestType", "generation" }, { "Status", "active" } };
        Assert.Equal("visual-agent.image.text2img::generation", ModelUpgradeRules.DefaultValidationCaller(logical, new[] { caller }));
        Assert.Empty(logical["DefaultForAppCallerCodes"].AsBsonArray);
        caller["Status"] = "disabled";
        Assert.Equal("", ModelUpgradeRules.DefaultValidationCaller(logical, new[] { caller }));
    }
    [Fact] public void CandidateCanaryTargetsFixedIdentityAndKnownMediaEnvelope()
    {
        var fixedModel = new BsonDocument { { "IdentityKind", "fixed" }, { "Enabled", true }, { "ModelType", "generation" } };
        Assert.True(ModelUpgradeRules.IsFixedValidationTarget(fixedModel, "generation"));
        fixedModel["IdentityKind"] = "stable"; Assert.False(ModelUpgradeRules.IsFixedValidationTarget(fixedModel, "generation"));
        Assert.True(ModelUpgradeRules.HasCanaryEnvelope("gpt-image-2.6", .05m, 5m, 30m));
        Assert.False(ModelUpgradeRules.HasCanaryEnvelope("gpt-image-2.6", .02m, 5m, 30m));
        Assert.False(ModelUpgradeRules.HasCanaryEnvelope("gpt-image-next", .05m, 5m, 30m));
    }
    [Fact] public void OfficialTokenPricesAreKnownWithoutInventedPerCallPrice()
    {
        var model = Price();
        Assert.True(ModelUpgradeRules.HasKnownPrice(model)); Assert.False(model.Contains("PricePerCall"));
        Assert.True(ModelUpgradeRules.PricePass(Price(8, 32), model, "generation", 0));
        Assert.False(ModelUpgradeRules.PricePass(Price(5, 20), model, "generation", 10));
    }
    [Fact] public void MissingOrStalePricesFailAutomaticPriceGate()
    {
        var unknown = Price(); unknown.Remove("OutputPricePerMillion");
        Assert.False(ModelUpgradeRules.HasKnownPrice(unknown));
        var stale = Price(); stale["PriceObservedAt"] = DateTime.UtcNow.AddYears(-1);
        Assert.False(ModelUpgradeRules.HasKnownPrice(stale));
        Assert.False(ModelUpgradeRules.PricePass(Price(), new BsonDocument(), "generation", 100));
    }
    [Fact] public void DifferentPricingBasesCannotBeComparedAsEquivalent()
    {
        var perCall = Price(); perCall["PricePerCall"] = new Decimal128(.05m);
        Assert.False(ModelUpgradeRules.PricePass(perCall, Price(), "generation", 100));
    }
    [Fact] public void BudgetUpperBoundIsExplicitAndDailyReservationsAreConservative()
    {
        var s = new ModelUpgradeState { Policy = Policy(), BudgetDate = DateTime.UtcNow.ToString("yyyy-MM-dd"), ReservedCostUsd = .18m };
        Assert.False(ModelUpgradeRules.BudgetPass(s, .05m, DateTime.UtcNow));
        Assert.True(ModelUpgradeRules.BudgetPass(s, .05m, DateTime.UtcNow.AddDays(1)));
        Assert.False(ModelUpgradeRules.BudgetPass(s, null, DateTime.UtcNow));
    }
    [Fact] public void AutoValidationRequiresExplicitUpperBoundAndCaller()
    {
        var p = Policy(); ModelUpgradeRules.ValidatePolicy(p);
        p.CanaryUnitCostUpperBoundUsd = null; Assert.Throws<ModelUpgradeException>(() => ModelUpgradeRules.ValidatePolicy(p));
        p.CanaryUnitCostUpperBoundUsd = .05m; p.ValidationAppCallerCode = ""; Assert.Throws<ModelUpgradeException>(() => ModelUpgradeRules.ValidatePolicy(p));
    }
    [Fact] public void DuplicateSuccessorsAreRejectedRatherThanGuessed()
    {
        var p = Policy(); p.Successors.Add(new() { FromModel = "version-a" });
        Assert.Throws<ModelUpgradeException>(() => ModelUpgradeRules.ValidatePolicy(p));
    }
    [Theory] [InlineData("fixed", false)] [InlineData("stable", true)] [InlineData("", false)]
    public void OnlyExplicitStableIdentityCanUpgrade(string kind, bool expected)
        => Assert.Equal(expected, ModelUpgradeRules.IsStable(new BsonDocument("IdentityKind", kind)));
    [Fact] public void ManualUnknownPriceExceptionStillRequiresRealRecentValidation()
    {
        var s = new ModelUpgradeState { Candidate = new() { ValidatedAt = DateTime.UtcNow, ValidationRoute = new() { OfferingId = "fixed-offering", OfferingVersion = "wire" } }, Gates = new() { Capabilities = true, Validation = true } };
        Assert.True(ModelUpgradeRules.CanPromote(s, false, DateTime.UtcNow));
        Assert.False(ModelUpgradeRules.CanPromote(s, true, DateTime.UtcNow));
        s.OutcomeUnknown = true; Assert.False(ModelUpgradeRules.CanPromote(s, false, DateTime.UtcNow));
        s.OutcomeUnknown = false; s.Candidate.ValidatedAt = DateTime.UtcNow.AddDays(-2); Assert.False(ModelUpgradeRules.CanPromote(s, false, DateTime.UtcNow));
    }
    [Fact] public void FirstDailyCheckIsBeijingThreeAndManualCheckDoesNotDriftSchedule()
    {
        var now = new DateTime(2026, 11, 11, 18, 0, 0, DateTimeKind.Utc);
        var due = ModelUpgradeRules.NextCheckAt(null, now, 24);
        Assert.Equal(now.Date.AddHours(19), due);
        Assert.Equal(due, ModelUpgradeRules.NextCheckAt(due, now, 24));
        Assert.Equal(due.AddDays(2), ModelUpgradeRules.NextCheckAt(due, due.AddDays(1).AddMinutes(2), 24));
    }
    [Fact] public void StateIdentityIsTenantScopedAndFingerprintChangesWithConfiguration()
    {
        Assert.NotEqual(ModelUpgradeRules.StateId("a", "same"), ModelUpgradeRules.StateId("b", "same"));
        var d = new BsonDocument { { "_id", "model" }, { "UpdatedAt", DateTime.UtcNow } };
        var first = ModelUpgradeRules.Fingerprint(d, d, d); d["UpdatedAt"] = DateTime.UtcNow.AddMinutes(1);
        Assert.NotEqual(first, ModelUpgradeRules.Fingerprint(d, d, d));
    }
    private static BsonDocument Log() => new() { { "TenantId", "tenant" }, { "PlatformId", "official" }, { "Model", "version-b" },
        { "Status", "succeeded" }, { "StatusCode", 200 }, { "EndedAt", DateTime.UtcNow }, { "ImageSuccessCount", 1 } };
    private static bool Pass(BsonDocument log) => ModelUpgradeRules.EvidencePasses(log, "tenant", new() { ProviderId = "official", UpstreamModelId = "version-b" }, "generation");
    [Theory] [InlineData(401)] [InlineData(403)] [InlineData(429)] [InlineData(500)]
    public void ResponsesAreNotServiceSuccess(int status) { var log = Log(); log["StatusCode"] = status; Assert.False(Pass(log)); }
    [Fact] public void RealOutputMustMatchTenantProviderAndExactCandidate()
    {
        Assert.True(Pass(Log()));
        foreach (var field in new[] { "TenantId", "PlatformId", "Model" }) { var log = Log(); log[field] = "other"; Assert.False(Pass(log)); }
        var noOutput = Log(); noOutput["ImageSuccessCount"] = 0; Assert.False(Pass(noOutput));
        var expired = Log(); expired["EndedAt"] = DateTime.UtcNow.AddDays(-2); Assert.False(Pass(expired));
    }
    [Fact] public void OfficialProviderCheckRejectsLookalikesAndHttp()
    {
        Assert.NotNull(ModelUpgradeDiscovery.RequireOfficial(new BsonDocument("ApiUrl", "https://api.openai.com/v1")));
        foreach (var url in new[] { "http://api.openai.com/v1", "https://api.openai.com.evil.test/v1", "https://apiyi.com/v1", "https://user:secret@api.openai.com/v1" })
            Assert.Throws<ModelUpgradeException>(() => ModelUpgradeDiscovery.RequireOfficial(new BsonDocument("ApiUrl", url)));
    }
}
