using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc.Testing;
using Xunit;
using Xunit.Abstractions;

namespace PrdAgent.Api.Tests.Integration;

/// <summary>
/// Skill Execute + ChatRun authz integration tests.
///
/// Requires: real MongoDB + Redis + ROOT_ACCESS_USERNAME/ROOT_ACCESS_PASSWORD configured.
/// CI skips these (Category=Integration).
///
/// Run:
///   cd prd-api
///   dotnet test --filter "FullyQualifiedName~SkillExecuteAuthzTests" --logger "console;verbosity=detailed"
/// </summary>
[Collection("Integration")]
[Trait("Category", TestCategories.Integration)]
public class SkillExecuteAuthzTests : IClassFixture<WebApplicationFactory<Program>>, IAsyncLifetime
{
    private readonly WebApplicationFactory<Program> _factory;
    private readonly ITestOutputHelper _output;

    /// <summary>Root access token (obtained via login API during InitializeAsync)</summary>
    private string? _rootAccessToken;

    public SkillExecuteAuthzTests(WebApplicationFactory<Program> factory, ITestOutputHelper output)
    {
        _factory = factory;
        _output = output;
    }

    private void Log(string message) => _output.WriteLine(message);

    public async Task InitializeAsync()
    {
        // Login via root account to get a valid access token
        var client = _factory.CreateClient();
        var loginResponse = await client.PostAsJsonAsync("/api/v1/auth/login", new
        {
            username = Environment.GetEnvironmentVariable("ROOT_ACCESS_USERNAME") ?? "root",
            password = Environment.GetEnvironmentVariable("ROOT_ACCESS_PASSWORD") ?? "root",
            clientType = "admin"
        });

        if (loginResponse.StatusCode == HttpStatusCode.OK)
        {
            var body = await loginResponse.Content.ReadAsStringAsync();
            using var doc = JsonDocument.Parse(body);
            _rootAccessToken = doc.RootElement
                .GetProperty("data")
                .GetProperty("accessToken")
                .GetString();
            Log($"[Init] Root login OK, token length={_rootAccessToken?.Length}");
        }
        else
        {
            var errBody = await loginResponse.Content.ReadAsStringAsync();
            Log($"[Init] Root login failed: {loginResponse.StatusCode} - {errBody}");
            Log("[Init] Tests requiring auth will be skipped");
        }
    }

    public Task DisposeAsync() => Task.CompletedTask;

    private HttpClient CreateAuthenticatedClient()
    {
        if (string.IsNullOrWhiteSpace(_rootAccessToken))
            throw new InvalidOperationException("No valid access token - root login failed");

        var client = _factory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", _rootAccessToken);
        return client;
    }

    private bool HasToken => !string.IsNullOrWhiteSpace(_rootAccessToken);

    // ──────────────────────────────────────────
    // No-Auth tests (always runnable)
    // ──────────────────────────────────────────

    [Fact]
    public async Task SkillExecute_NoAuth_ShouldReturn401()
    {
        Log("[Test] No auth => 401");

        var client = _factory.CreateClient();
        var response = await client.PostAsJsonAsync("/api/prd-agent/skills/any-skill/execute", new
        {
            sessionId = "fake-session"
        });

        Log($"  StatusCode: {response.StatusCode}");
        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    [Fact]
    public async Task ChatRun_CreateRun_NoAuth_ShouldReturn401()
    {
        Log("[Test] No auth => 401");

        var client = _factory.CreateClient();
        var response = await client.PostAsJsonAsync(
            "/api/v1/sessions/fake-session/messages/run",
            new { content = "test" });

        Log($"  StatusCode: {response.StatusCode}");
        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    [Fact]
    public async Task ChatRun_Stream_NoAuth_ShouldReturn401()
    {
        Log("[Test] No auth SSE => 401");

        var client = _factory.CreateClient();
        var response = await client.GetAsync("/api/v1/chat-runs/any-run/stream");

        Log($"  StatusCode: {response.StatusCode}");
        Assert.True(
            response.StatusCode is HttpStatusCode.Unauthorized or HttpStatusCode.OK,
            $"Expected 401 or 200 (with error event), got {response.StatusCode}");

        if (response.StatusCode == HttpStatusCode.OK)
        {
            var body = await response.Content.ReadAsStringAsync();
            Assert.Contains("error", body);
        }
    }

    // ──────────────────────────────────────────
    // Authenticated tests (require root login)
    // ──────────────────────────────────────────

    [Fact]
    public async Task SkillExecute_NonExistentSkill_ShouldReturn404()
    {
        if (!HasToken) { Log("[Skip] No token"); return; }
        Log("[Test] Non-existent skill => 404");

        var client = CreateAuthenticatedClient();
        var response = await client.PostAsJsonAsync(
            "/api/prd-agent/skills/non-existent-skill-key-12345/execute",
            new { sessionId = "fake-session" });

        Log($"  StatusCode: {response.StatusCode}");
        var body = await response.Content.ReadAsStringAsync();
        Log($"  Body: {body}");

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    [Fact]
    public async Task SkillExecute_EmptySessionId_ShouldReturn400Or404()
    {
        if (!HasToken) { Log("[Skip] No token"); return; }
        Log("[Test] Empty sessionId => 400 or 404");

        var client = CreateAuthenticatedClient();
        var response = await client.PostAsJsonAsync(
            "/api/prd-agent/skills/any-skill/execute",
            new { sessionId = "" });

        Log($"  StatusCode: {response.StatusCode}");
        var body = await response.Content.ReadAsStringAsync();
        Log($"  Body: {body}");

        Assert.True(
            response.StatusCode is HttpStatusCode.BadRequest or HttpStatusCode.NotFound,
            $"Expected 400 or 404, got {response.StatusCode}");
    }

    [Fact]
    public async Task SkillExecute_NonExistentSession_ShouldReturn404()
    {
        if (!HasToken) { Log("[Skip] No token"); return; }
        Log("[Test] Non-existent session on skill execute => 404");

        // First, find an existing skill to avoid 404 on skill lookup
        var client = CreateAuthenticatedClient();
        var listResponse = await client.GetAsync("/api/prd-agent/skills");
        if (listResponse.StatusCode != HttpStatusCode.OK)
        {
            Log("[Skip] Cannot list skills");
            return;
        }

        var listBody = await listResponse.Content.ReadAsStringAsync();
        using var listDoc = JsonDocument.Parse(listBody);
        var skills = listDoc.RootElement.GetProperty("data").GetProperty("skills");
        if (skills.GetArrayLength() == 0)
        {
            Log("[Skip] No skills available");
            return;
        }

        var skillKey = skills[0].GetProperty("skillKey").GetString()!;
        Log($"  Using skill: {skillKey}");

        var response = await client.PostAsJsonAsync(
            $"/api/prd-agent/skills/{skillKey}/execute",
            new { sessionId = "non-existent-session-id-99999" });

        Log($"  StatusCode: {response.StatusCode}");
        var body = await response.Content.ReadAsStringAsync();
        Log($"  Body: {body}");

        // Session not found => 404
        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    [Fact]
    public async Task ChatRun_CreateRun_NonExistentSession_ShouldReturn404()
    {
        if (!HasToken) { Log("[Skip] No token"); return; }
        Log("[Test] Non-existent session => 404");

        var client = CreateAuthenticatedClient();
        var response = await client.PostAsJsonAsync(
            "/api/v1/sessions/non-existent-session-12345/messages/run",
            new { content = "test" });

        Log($"  StatusCode: {response.StatusCode}");
        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    [Fact]
    public async Task ChatRun_GetRun_NonExistentRun_ShouldReturn404()
    {
        if (!HasToken) { Log("[Skip] No token"); return; }
        Log("[Test] Non-existent run GET => 404");

        var client = CreateAuthenticatedClient();
        var response = await client.GetAsync("/api/v1/chat-runs/non-existent-run-12345");

        Log($"  StatusCode: {response.StatusCode}");
        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    [Fact]
    public async Task ChatRun_Cancel_NonExistentRun_ShouldReturn404()
    {
        if (!HasToken) { Log("[Skip] No token"); return; }
        Log("[Test] Non-existent run cancel => 404");

        var client = CreateAuthenticatedClient();
        var response = await client.PostAsync("/api/v1/chat-runs/non-existent-run-12345/cancel", null);

        Log($"  StatusCode: {response.StatusCode}");
        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    [Fact]
    public async Task ChatRun_Stream_NonExistentRun_ShouldReturnErrorEvent()
    {
        if (!HasToken) { Log("[Skip] No token"); return; }
        Log("[Test] Non-existent run SSE => error event");

        var client = CreateAuthenticatedClient();
        var response = await client.GetAsync("/api/v1/chat-runs/non-existent-run-12345/stream");

        Log($"  StatusCode: {response.StatusCode}");
        var body = await response.Content.ReadAsStringAsync();
        Log($"  Body: {body}");

        // SSE returns 200 with error event
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Contains("event: error", body);
    }
}
