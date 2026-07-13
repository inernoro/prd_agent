using PrdAgent.Api.Services.ReportAgent;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.LlmGateway;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public class ReportGenerationFallbackReasonTests
{
    [Fact]
    public void ResolveFallbackReasonCode_UpstreamFailure_DoesNotExposeErrorMessage()
    {
        var response = new GatewayResponse
        {
            Success = false,
            ErrorMessage = "sensitive upstream message"
        };

        var reason = ReportGenerationService.ResolveFallbackReasonCode(response, null);

        Assert.Equal(ReportGenerationFallbackReason.UpstreamFailed, reason);
        Assert.DoesNotContain("sensitive", reason);
    }

    [Fact]
    public void ResolveFallbackReasonCode_EmptyResponse_ReturnsStableCode()
    {
        var response = new GatewayResponse { Success = true, Content = "  " };

        var reason = ReportGenerationService.ResolveFallbackReasonCode(response, null);

        Assert.Equal(ReportGenerationFallbackReason.EmptyResponse, reason);
    }

    [Fact]
    public void ResolveFallbackReasonCode_ValidItems_DoesNotMarkFallback()
    {
        var response = new GatewayResponse { Success = true, Content = "{}" };
        var sections = new List<WeeklyReportSection>
        {
            new()
            {
                Items = new List<WeeklyReportItem>
                {
                    new() { Content = "已完成事项", Source = "map-platform" }
                }
            }
        };

        var reason = ReportGenerationService.ResolveFallbackReasonCode(response, sections);

        Assert.Null(reason);
    }
}
