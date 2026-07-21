using PrdAgent.Api.Services;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public class QuickCaptureStorePolicyTests
{
    [Fact]
    public void BuildStoreId_IsStableAndMongoIdShaped()
    {
        var first = QuickCaptureStorePolicy.BuildStoreId("user-1");
        var second = QuickCaptureStorePolicy.BuildStoreId("user-1");

        first.ShouldBe(second);
        first.Length.ShouldBe(32);
        first.ShouldMatch("^[0-9a-f]{32}$");
    }

    [Fact]
    public void BuildStoreId_SeparatesUsers()
    {
        QuickCaptureStorePolicy.BuildStoreId("user-1")
            .ShouldNotBe(QuickCaptureStorePolicy.BuildStoreId("user-2"));
    }

    [Fact]
    public void BuildStoreId_RejectsMissingUser()
    {
        Should.Throw<ArgumentException>(() => QuickCaptureStorePolicy.BuildStoreId(" "));
    }
}
