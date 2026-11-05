using MongoDB.Bson;
using PrdAgent.LlmGw.Costs;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Gateway;

public sealed class GatewayCostReconciliationPolicyTests
{
    [Fact]
    public void LegacyOfficialPlatformWithMultipleIdentityFieldsKeepsItsPriceEvidence()
    {
        var document = new BsonDocument
        {
            { "CostStatus", "priced" }, { "EstimatedCost", new BsonDecimal128(0.01m) }, { "EstimatedCostCurrency", "USD" },
            { "PriceSource", "upstream" }, { "Provider", "OpenAI" }, { "PlatformId", "platform-guid" }, { "PlatformName", "OpenAI" },
        };
        Resolve(document).ShouldBe("official_baseline_estimate");
        var actualMapper = typeof(LegacyLogCostKindPolicy).Assembly.GetType("Program")!
            .GetMethods(System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Static)
            .Single(method => method.Name.Contains("g__ResolveLogCostKind|", StringComparison.Ordinal));
        actualMapper.Invoke(null, [document]).ShouldBe("official_baseline_estimate");

        document["PlatformName"] = "OpenRouter";
        document["Protocol"] = "openai";
        document["PlatformType"] = "openai";
        Resolve(document).ShouldBe("provider_policy_estimate");
        document["PlatformName"] = "APIYI";
        Resolve(document).ShouldBe("official_baseline_estimate");

        document["CostKind"] = "provider_policy_estimate";
        Resolve(document).ShouldBe("provider_policy_estimate");
        document["ProviderReportedCost"] = new BsonDecimal128(0m);
        Resolve(document).ShouldBe("provider_actual");
        document.Remove("ProviderReportedCost");
        document.Remove("CostKind");
        foreach (var status in new[] { "unpriced", "stale_currency", "no_usage" })
        {
            document["CostStatus"] = status;
            Resolve(document).ShouldBe(status == "no_usage" ? "no_usage" : "unpriced");
        }

        static string Resolve(BsonDocument input)
        {
            var before = input.ToJson();
            var result = LegacyLogCostKindPolicy.Resolve(input, input["CostStatus"].AsString);
            input.ToJson().ShouldBe(before);
            return result;
        }
    }

    [Fact]
    public void UnknownEstimate_RemainsUnknownInsteadOfZero()
    {
        var result = CostReconciliationPolicy.Evaluate(null, null, 2.5m, "USD", null, null);

        result.Status.ShouldBe("estimated-unavailable");
        result.Delta.ShouldBeNull();
        result.ProviderCostInEstimatedCurrency.ShouldBeNull();
    }

    [Fact]
    public void SameCurrency_ComputesDeltaWithoutFx()
    {
        var result = CostReconciliationPolicy.Evaluate(2m, "usd", 2.5m, "USD", null, null);

        result.Status.ShouldBe("reconciled");
        result.Delta.ShouldBe(0.5m);
        result.DeltaCurrency.ShouldBe("USD");
    }

    [Fact]
    public void MixedCurrency_RequiresAuditableFxSnapshot()
    {
        var missingFx = CostReconciliationPolicy.Evaluate(7m, "CNY", 1m, "USD", null, 7m);
        var reconciled = CostReconciliationPolicy.Evaluate(7m, "CNY", 1m, "USD", "fx-2026-07-15", 7.2m);

        missingFx.Status.ShouldBe("fx-unavailable");
        missingFx.Delta.ShouldBeNull();
        reconciled.Status.ShouldBe("reconciled");
        reconciled.Delta.ShouldBe(0.2m);
        reconciled.DeltaCurrency.ShouldBe("CNY");
    }
}
