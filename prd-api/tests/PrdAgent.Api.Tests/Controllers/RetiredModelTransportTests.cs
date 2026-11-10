using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using PrdAgent.Api.Controllers.Api;
using PrdAgent.Core.Models;
using Xunit;

namespace PrdAgent.Api.Tests.Controllers;

public sealed class RetiredModelTransportTests
{
    [Fact]
    public async Task LegacyPoolTest_StopsEvenWhenCalledWithoutGlobalMdsFilter()
    {
        var controller = new ModelGroupsController(null!, null!, NullLogger<ModelGroupsController>.Instance,
            new ConfigurationBuilder().Build());
        var result = Assert.IsType<ObjectResult>(await controller.TestModelPool("legacy-pool"));
        Assert.Equal(410, result.StatusCode);
        Assert.Equal("MDS_WRITE_RETIRED", Assert.IsType<ApiResponse<object>>(result.Value).Error!.Code);
    }

    [Fact]
    public async Task LegacyExchangePaidTest_StopsBeforeDatabaseOrVendorAccess()
    {
        var controller = new ExchangeController(null!, NullLogger<ExchangeController>.Instance,
            new ConfigurationBuilder().Build());
        var result = Assert.IsType<ObjectResult>(await controller.TestExchange("legacy-exchange",
            new ExchangeTestRequest { DryRun = false, StandardRequestBody = "{}" }, CancellationToken.None));
        Assert.Equal(410, result.StatusCode);
        Assert.Equal("MDS_WRITE_RETIRED", Assert.IsType<ApiResponse<object>>(result.Value).Error!.Code);
    }
}
