using PrdAgent.LlmGw.Costs;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Gateway;

public sealed class GatewayCostReconciliationPolicyTests
{
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
