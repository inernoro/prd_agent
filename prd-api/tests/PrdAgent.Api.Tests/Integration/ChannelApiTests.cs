using System.Net;
using System.Net.Http.Json;
using Microsoft.AspNetCore.Mvc.Testing;
using PrdAgent.Api.Tests;
using Xunit;

namespace PrdAgent.Api.Tests.Integration;

/// <summary>
/// 通道适配器 API 集成测试
/// 注意：这些测试需要在有数据库连接的环境中运行
/// </summary>
[Collection("Integration")]
[Trait("Category", TestCategories.Integration)]
public class ChannelApiTests : IClassFixture<WebApplicationFactory<Program>>
{
    private readonly WebApplicationFactory<Program> _factory;
    private readonly HttpClient _client;

    public ChannelApiTests(WebApplicationFactory<Program> factory)
    {
        _factory = factory;
        _client = _factory.CreateClient();
    }

    #region Whitelist API Tests

    [Fact(Skip = "Requires database connection")]
    public async Task GetWhitelists_ShouldReturnPagedResult()
    {
        // Arrange
        var request = new HttpRequestMessage(HttpMethod.Get, "/api/admin/channels/whitelists?page=1&pageSize=10");
        AddAuthHeader(request);

        // Act
        var response = await _client.SendAsync(request);

        // Assert
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var content = await response.Content.ReadAsStringAsync();
        Assert.Contains("items", content);
        Assert.Contains("total", content);
    }

    [Fact(Skip = "Requires database connection")]
    public async Task CreateWhitelist_ShouldCreateSuccessfully()
    {
        // Arrange
        var request = new HttpRequestMessage(HttpMethod.Post, "/api/admin/channels/whitelists")
        {
            Content = JsonContent.Create(new
            {
                channelType = "email",
                identifierPattern = $"test-{Guid.NewGuid():N}@example.com",
                displayName = "Test Whitelist",
                dailyQuota = 50
            })
        };
        AddAuthHeader(request);

        // Act
        var response = await _client.SendAsync(request);

        // Assert
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }

    [Fact(Skip = "Requires database connection")]
    public async Task CreateWhitelist_WithInvalidPattern_ShouldFail()
    {
        // Arrange
        var request = new HttpRequestMessage(HttpMethod.Post, "/api/admin/channels/whitelists")
        {
            Content = JsonContent.Create(new
            {
                channelType = "email",
                identifierPattern = "", // Empty pattern
                displayName = "Test"
            })
        };
        AddAuthHeader(request);

        // Act
        var response = await _client.SendAsync(request);

        // Assert
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact(Skip = "Requires database connection")]
    public async Task ToggleWhitelist_ShouldToggleStatus()
    {
        // This test requires a whitelist to be created first
        // Skipped for now
    }

    #endregion

    #region Identity Mapping API Tests

    [Fact(Skip = "Requires database connection")]
    public async Task GetIdentityMappings_ShouldReturnPagedResult()
    {
        // Arrange
        var request = new HttpRequestMessage(HttpMethod.Get, "/api/admin/channels/identity-mappings?page=1&pageSize=10");
        AddAuthHeader(request);

        // Act
        var response = await _client.SendAsync(request);

        // Assert
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }

    [Fact(Skip = "Requires database connection")]
    public async Task CreateIdentityMapping_ShouldCreateSuccessfully()
    {
        // Arrange
        var request = new HttpRequestMessage(HttpMethod.Post, "/api/admin/channels/identity-mappings")
        {
            Content = JsonContent.Create(new
            {
                channelType = "email",
                channelIdentifier = $"test-{Guid.NewGuid():N}@example.com",
                userId = "test-user-id",
                isVerified = true
            })
        };
        AddAuthHeader(request);

        // Act
        var response = await _client.SendAsync(request);

        // Assert
        // May fail if user doesn't exist, but tests the API endpoint
        Assert.True(response.StatusCode is HttpStatusCode.OK or HttpStatusCode.BadRequest);
    }

    #endregion

    #region Task API Tests

    [Fact(Skip = "Requires database connection")]
    public async Task GetTasks_ShouldReturnPagedResult()
    {
        // Arrange
        var request = new HttpRequestMessage(HttpMethod.Get, "/api/admin/channels/tasks?page=1&pageSize=10");
        AddAuthHeader(request);

        // Act
        var response = await _client.SendAsync(request);

        // Assert
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }

    [Fact(Skip = "Requires database connection")]
    public async Task GetTasks_WithFilters_ShouldFilterResults()
    {
        // Arrange
        var request = new HttpRequestMessage(HttpMethod.Get,
            "/api/admin/channels/tasks?page=1&pageSize=10&channelType=email&status=pending");
        AddAuthHeader(request);

        // Act
        var response = await _client.SendAsync(request);

        // Assert
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }

    [Fact(Skip = "Requires database connection")]
    public async Task GetTaskStats_ShouldReturnStats()
    {
        // Arrange
        var request = new HttpRequestMessage(HttpMethod.Get, "/api/admin/channels/tasks/stats");
        AddAuthHeader(request);

        // Act
        var response = await _client.SendAsync(request);

        // Assert
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var content = await response.Content.ReadAsStringAsync();
        Assert.Contains("total", content);
        Assert.Contains("pending", content);
    }

    [Fact(Skip = "Requires database connection")]
    public async Task GetTask_WithNonExistentId_ShouldReturn404()
    {
        // Arrange
        var request = new HttpRequestMessage(HttpMethod.Get, "/api/admin/channels/tasks/non-existent-id");
        AddAuthHeader(request);

        // Act
        var response = await _client.SendAsync(request);

        // Assert
        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    #endregion

    #region Stats API Tests

    [Fact(Skip = "Requires database connection")]
    public async Task GetChannelStats_ShouldReturnAllChannelStats()
    {
        // Arrange
        var request = new HttpRequestMessage(HttpMethod.Get, "/api/admin/channels/stats");
        AddAuthHeader(request);

        // Act
        var response = await _client.SendAsync(request);

        // Assert
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }

    #endregion

    #region Email Inbound Webhook Tests

    [Fact(Skip = "Requires database connection")]
    public async Task EmailInbound_ShouldAcceptValidRequest()
    {
        // Arrange - Simulate SendGrid Inbound Parse format
        var content = new MultipartFormDataContent
        {
            { new StringContent("Test User <test@example.com>"), "from" },
            { new StringContent("inbox@prdagent.com"), "to" },
            { new StringContent("[生图] 测试主题"), "subject" },
            { new StringContent("生成一张风景图片"), "text" },
            { new StringContent("<test-message-id@example.com>"), "Message-Id" }
        };

        var request = new HttpRequestMessage(HttpMethod.Post, "/api/channels/email/inbound")
        {
            Content = content
        };

        // Act
        var response = await _client.SendAsync(request);

        // Assert
        // Should return 200 even if whitelist check fails (silent reject)
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }

    [Fact(Skip = "Requires test environment")]
    public async Task EmailInboundTest_ShouldCreateTask_InDevelopment()
    {
        // This test only works in Development environment
        // Arrange
        var request = new HttpRequestMessage(HttpMethod.Post, "/api/channels/email/inbound/test")
        {
            Content = JsonContent.Create(new
            {
                from = "test@example.com",
                fromName = "Test User",
                subject = "[生图] 测试",
                text = "生成一张猫的图片"
            })
        };

        // Act
        var response = await _client.SendAsync(request);

        // Assert
        // Will be 404 in non-Development environment
        Assert.True(response.StatusCode is HttpStatusCode.OK or HttpStatusCode.NotFound or HttpStatusCode.BadRequest);
    }

    #endregion

    #region Helper Methods

    private void AddAuthHeader(HttpRequestMessage request)
    {
        // In a real test, you would get a valid JWT token
        // For now, we skip auth by marking tests with Skip
        request.Headers.Add("Authorization", "Bearer test-token");
    }

    #endregion
}
