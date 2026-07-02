using PrdAgent.Core.Models;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public sealed class AdminNotificationSourceCatalogTests
{
    [Theory]
    [InlineData("defect-agent")]
    [InlineData("report-agent")]
    [InlineData("speech-to-text")]
    [InlineData("voice-transcript")]
    public void ResolveSection_ShouldTreatPersonalWorkflowSourcesAsPersonal(string source)
    {
        Assert.Equal(AdminNotificationSections.Personal, AdminNotificationSourceCatalog.ResolveSection(source));
        Assert.Contains(source, AdminNotificationSourceCatalog.AllowedEventSources);
    }

    [Theory]
    [InlineData("user-voice")]
    [InlineData("llm-gateway-quota")]
    [InlineData("api-request-alert")]
    [InlineData("server-expiry")]
    public void ResolveSection_ShouldTreatOperationalSourcesAsAdmin(string source)
    {
        Assert.Equal(AdminNotificationSections.Admin, AdminNotificationSourceCatalog.ResolveSection(source));
        Assert.Contains(source, AdminNotificationSourceCatalog.AllowedEventSources);
    }

    [Fact]
    public void ResolveSection_ShouldAllowExplicitOverrideForExceptionalCases()
    {
        Assert.Equal(AdminNotificationSections.Admin, AdminNotificationSourceCatalog.ResolveSection("defect-agent", "admin"));
        Assert.Equal(AdminNotificationSections.Personal, AdminNotificationSourceCatalog.ResolveSection("user-voice", "personal"));
    }
}
