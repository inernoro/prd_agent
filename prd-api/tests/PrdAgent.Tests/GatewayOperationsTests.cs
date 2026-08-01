using PrdAgent.Core.Models;
using Xunit;

namespace PrdAgent.Tests;

public sealed class GatewayOperationsTests
{
    [Theory]
    [InlineData("POST", "/api/v3/contents/generations/tasks", null, "submit")]
    [InlineData("GET", "/api/v3/contents/generations/tasks/cgt-123", "status", "status")]
    [InlineData("GET", "/videos/job-123", null, "status")]
    [InlineData("GET", "/videos/job-123/content", null, "download")]
    [InlineData("DELETE", "/videos/job-123", null, "cancel")]
    public void Resolve_VideoPhysicalCalls_AreClassifiedByRole(
        string method,
        string path,
        string? declared,
        string expected)
    {
        var actual = GatewayOperations.Resolve(
            ModelTypes.VideoGen,
            method,
            path,
            declaredOperation: declared);

        Assert.Equal(expected, actual);
    }

    [Fact]
    public void Resolve_HealthProbe_OverridesRequestShape()
    {
        var actual = GatewayOperations.Resolve(
            ModelTypes.VideoGen,
            "POST",
            "/videos",
            declaredOperation: "submit",
            isHealthProbe: true);

        Assert.Equal(GatewayOperations.Probe, actual);
    }

    [Fact]
    public void Resolve_NonVideoRequest_CannotSelfDeclareControlOperation()
    {
        var actual = GatewayOperations.Resolve(
            ModelTypes.Chat,
            "GET",
            "/chat/status",
            declaredOperation: "status");

        Assert.Equal(GatewayOperations.Invoke, actual);
    }

    [Theory]
    [InlineData("invoke", true)]
    [InlineData("submit", true)]
    [InlineData("status", false)]
    [InlineData("download", false)]
    [InlineData("cancel", false)]
    [InlineData("probe", false)]
    public void CountsPricePerCall_OnlyBusinessOperationsAreBillable(string operation, bool expected)
    {
        Assert.Equal(expected, GatewayOperations.CountsPricePerCall(operation));
    }
}
