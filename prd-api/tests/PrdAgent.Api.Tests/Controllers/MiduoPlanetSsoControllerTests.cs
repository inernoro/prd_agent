using System.Reflection;
using PrdAgent.Api.Controllers;
using Xunit;

namespace PrdAgent.Api.Tests.Controllers;

public class MiduoPlanetSsoControllerTests
{
    [Fact]
    public void BuildAutoUsername_ShouldBeStableAndNotExposeMobile()
    {
        var first = Invoke<string>("BuildAutoUsername", "APP00013", "mobile", "18620111008");
        var second = Invoke<string>("BuildAutoUsername", "app00013", "mobile", "186 2011 1008");

        Assert.Equal(first, second);
        Assert.StartsWith("miduo_", first);
        Assert.DoesNotContain("186", first);
        Assert.DoesNotContain("1008", first);
        Assert.InRange(first.Length, 10, 32);
    }

    [Fact]
    public void NormalizeDisplayName_ShouldFallbackToMaskedSubject()
    {
        var displayName = Invoke<string>("NormalizeDisplayName", "", "mobile", "18620111008", "miduo_test");

        Assert.Equal("米多用户 186****1008", displayName);
    }

    [Fact]
    public void MaskSubjectValue_ShouldMaskMobile()
    {
        var masked = Invoke<string>("MaskSubjectValue", "mobile", "18620111008");

        Assert.Equal("186****1008", masked);
    }

    private static T Invoke<T>(string name, params object?[] args)
    {
        var method = typeof(MiduoPlanetSsoController).GetMethod(
            name,
            BindingFlags.Static | BindingFlags.NonPublic);
        Assert.NotNull(method);
        return Assert.IsType<T>(method.Invoke(null, args));
    }
}
