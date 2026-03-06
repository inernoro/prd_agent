using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc.Testing;
using Xunit;
using Xunit.Abstractions;

namespace PrdAgent.Api.Tests.Integration;

/// <summary>
/// Cross-validation integration tests: verify that skill execute, chat-run create,
/// and run access endpoints enforce identical authorization rules.
///
/// Test matrix:
///   1. Owner session: root user => skill execute OK, chat-run OK, run get/cancel/stream OK
///   2. Other user's session: userB => skill execute 403, chat-run 403
///   3. Non-existent session: both paths return 404
///   4. Run created by root => only root can get/cancel/stream, userB gets 403
///
/// Requires: real MongoDB + Redis, root + at least one normal user.
/// CI skips these (Category=Integration).
///
/// Run:
///   cd prd-api
///   dotnet test --filter "FullyQualifiedName~AuthzCrossValidationTests" --logger "console;verbosity=detailed"
/// </summary>
[Collection("Integration")]
[Trait("Category", TestCategories.Integration)]
public class AuthzCrossValidationTests : IClassFixture<WebApplicationFactory<Program>>, IAsyncLifetime
{
    private readonly WebApplicationFactory<Program> _factory;
    private readonly ITestOutputHelper _output;

    // Root user context (admin, owns personal sessions)
    private string? _rootToken;
    private string? _rootUserId;

    // Root's first available session (personal)
    private string? _rootSessionId;

    // Root's first available skill
    private string? _availableSkillKey;

    // A second user context (to test cross-user denial)
    private string? _userBToken;
    private string? _userBUserId;

    public AuthzCrossValidationTests(WebApplicationFactory<Program> factory, ITestOutputHelper output)
    {
        _factory = factory;
        _output = output;
    }

    private void Log(string message) => _output.WriteLine(message);

    public async Task InitializeAsync()
    {
        // ── Step 1: Root login ──
        _rootToken = await LoginAsync("root", "root", "admin");
        if (_rootToken != null)
        {
            _rootUserId = ExtractUserId(_rootToken);
            Log($"[Init] Root login OK, userId={_rootUserId}");
        }
        else
        {
            // Retry with env vars
            var username = Environment.GetEnvironmentVariable("ROOT_ACCESS_USERNAME");
            var password = Environment.GetEnvironmentVariable("ROOT_ACCESS_PASSWORD");
            if (!string.IsNullOrWhiteSpace(username) && !string.IsNullOrWhiteSpace(password))
            {
                _rootToken = await LoginAsync(username, password, "admin");
                if (_rootToken != null)
                    _rootUserId = ExtractUserId(_rootToken);
            }

            if (_rootToken == null)
            {
                Log("[Init] Root login failed, all auth tests will be skipped");
                return;
            }
        }

        // ── Step 2: Get root's sessions ──
        var rootClient = CreateClient(_rootToken);
        var sessionsResp = await rootClient.GetAsync("/api/v1/sessions");
        if (sessionsResp.StatusCode == HttpStatusCode.OK)
        {
            var body = await sessionsResp.Content.ReadAsStringAsync();
            using var doc = JsonDocument.Parse(body);
            var items = doc.RootElement.GetProperty("data").GetProperty("items");
            if (items.GetArrayLength() > 0)
            {
                _rootSessionId = items[0].GetProperty("sessionId").GetString();
                Log($"[Init] Root session: {_rootSessionId}");
            }
            else
            {
                Log("[Init] Root has no sessions, session-dependent tests will skip");
            }
        }

        // ── Step 3: Get available skills ──
        var skillsResp = await rootClient.GetAsync("/api/prd-agent/skills");
        if (skillsResp.StatusCode == HttpStatusCode.OK)
        {
            var body = await skillsResp.Content.ReadAsStringAsync();
            using var doc = JsonDocument.Parse(body);
            var skills = doc.RootElement.GetProperty("data").GetProperty("skills");
            if (skills.GetArrayLength() > 0)
            {
                _availableSkillKey = skills[0].GetProperty("skillKey").GetString();
                Log($"[Init] Available skill: {_availableSkillKey}");
            }
            else
            {
                Log("[Init] No skills available, skill tests will skip");
            }
        }

        // ── Step 4: Try login as second user ──
        // Use env var or try common test accounts
        var userBName = Environment.GetEnvironmentVariable("TEST_USER_B_USERNAME");
        var userBPass = Environment.GetEnvironmentVariable("TEST_USER_B_PASSWORD");

        if (!string.IsNullOrWhiteSpace(userBName) && !string.IsNullOrWhiteSpace(userBPass))
        {
            _userBToken = await LoginAsync(userBName, userBPass, "desktop");
            if (_userBToken != null)
            {
                _userBUserId = ExtractUserId(_userBToken);
                Log($"[Init] UserB login OK, userId={_userBUserId}");
            }
        }

        if (_userBToken == null)
        {
            Log("[Init] No second user available (set TEST_USER_B_USERNAME/PASSWORD), cross-user tests will skip");
        }
    }

    public Task DisposeAsync() => Task.CompletedTask;

    // ══════════════════════════════════════════
    // Cross-validation 1: Owner CAN access own session
    // Both skill execute and chat-run should succeed
    // ══════════════════════════════════════════

    [Fact]
    public async Task CV1_SkillExecute_OwnerSession_ShouldNotReturn403()
    {
        if (_rootToken == null || _rootSessionId == null || _availableSkillKey == null)
        {
            Log("[Skip] Missing root token / session / skill");
            return;
        }

        Log($"[CV1] Skill execute: owner({_rootUserId}) + ownSession({_rootSessionId}) + skill({_availableSkillKey})");

        var client = CreateClient(_rootToken);
        var response = await client.PostAsJsonAsync(
            $"/api/prd-agent/skills/{_availableSkillKey}/execute",
            new { sessionId = _rootSessionId });

        var body = await response.Content.ReadAsStringAsync();
        Log($"  StatusCode: {response.StatusCode}");
        Log($"  Body: {Truncate(body, 300)}");

        // Should NOT be 403 (could be 200 success, or other business error, but not permission denied)
        Assert.NotEqual(HttpStatusCode.Forbidden, response.StatusCode);
        Assert.NotEqual(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    [Fact]
    public async Task CV1_ChatRunCreate_OwnerSession_ShouldNotReturn403()
    {
        if (_rootToken == null || _rootSessionId == null)
        {
            Log("[Skip] Missing root token / session");
            return;
        }

        Log($"[CV1] ChatRun create: owner({_rootUserId}) + ownSession({_rootSessionId})");

        var client = CreateClient(_rootToken);
        var response = await client.PostAsJsonAsync(
            $"/api/v1/sessions/{_rootSessionId}/messages/run",
            new { content = "[test] cross-validation owner access" });

        var body = await response.Content.ReadAsStringAsync();
        Log($"  StatusCode: {response.StatusCode}");
        Log($"  Body: {Truncate(body, 300)}");

        Assert.NotEqual(HttpStatusCode.Forbidden, response.StatusCode);
        Assert.NotEqual(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    // ══════════════════════════════════════════
    // Cross-validation 2: Non-owner CANNOT access other's session
    // Both skill execute and chat-run should return 403
    // ══════════════════════════════════════════

    [Fact]
    public async Task CV2_SkillExecute_OtherUserSession_ShouldReturn403()
    {
        if (_userBToken == null || _rootSessionId == null || _availableSkillKey == null)
        {
            Log("[Skip] Missing userB token / root session / skill");
            return;
        }

        Log($"[CV2] Skill execute: userB({_userBUserId}) + rootSession({_rootSessionId}) + skill({_availableSkillKey})");

        var client = CreateClient(_userBToken);
        var response = await client.PostAsJsonAsync(
            $"/api/prd-agent/skills/{_availableSkillKey}/execute",
            new { sessionId = _rootSessionId });

        var body = await response.Content.ReadAsStringAsync();
        Log($"  StatusCode: {response.StatusCode}");
        Log($"  Body: {Truncate(body, 300)}");

        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
        AssertErrorCode(body, "PERMISSION_DENIED");
    }

    [Fact]
    public async Task CV2_ChatRunCreate_OtherUserSession_ShouldReturn403()
    {
        if (_userBToken == null || _rootSessionId == null)
        {
            Log("[Skip] Missing userB token / root session");
            return;
        }

        Log($"[CV2] ChatRun create: userB({_userBUserId}) + rootSession({_rootSessionId})");

        var client = CreateClient(_userBToken);
        var response = await client.PostAsJsonAsync(
            $"/api/v1/sessions/{_rootSessionId}/messages/run",
            new { content = "[test] cross-user denial" });

        var body = await response.Content.ReadAsStringAsync();
        Log($"  StatusCode: {response.StatusCode}");
        Log($"  Body: {Truncate(body, 300)}");

        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
        AssertErrorCode(body, "PERMISSION_DENIED");
    }

    // ══════════════════════════════════════════
    // Cross-validation 3: Non-existent session => 404 (both paths)
    // ══════════════════════════════════════════

    [Fact]
    public async Task CV3_SkillExecute_NonExistentSession_Returns404()
    {
        if (_rootToken == null || _availableSkillKey == null)
        {
            Log("[Skip] Missing root token / skill");
            return;
        }

        Log("[CV3] Skill execute: non-existent session");

        var client = CreateClient(_rootToken);
        var response = await client.PostAsJsonAsync(
            $"/api/prd-agent/skills/{_availableSkillKey}/execute",
            new { sessionId = "non-existent-session-cv3-" + Guid.NewGuid().ToString("N")[..8] });

        Log($"  StatusCode: {response.StatusCode}");
        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    [Fact]
    public async Task CV3_ChatRunCreate_NonExistentSession_Returns404()
    {
        if (_rootToken == null)
        {
            Log("[Skip] Missing root token");
            return;
        }

        Log("[CV3] ChatRun create: non-existent session");

        var client = CreateClient(_rootToken);
        var response = await client.PostAsJsonAsync(
            $"/api/v1/sessions/non-existent-session-cv3-{Guid.NewGuid().ToString("N")[..8]}/messages/run",
            new { content = "test" });

        Log($"  StatusCode: {response.StatusCode}");
        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    // ══════════════════════════════════════════
    // Cross-validation 4: Run access — owner OK, other user 403
    // Creates a run via chat-run, then verifies get/cancel/stream
    // ══════════════════════════════════════════

    [Fact]
    public async Task CV4_RunAccess_OwnerCanGetRun()
    {
        var runId = await CreateRunAsRoot();
        if (runId == null)
        {
            Log("[Skip] Could not create run");
            return;
        }

        Log($"[CV4] Owner GetRun: runId={runId}");

        var client = CreateClient(_rootToken!);
        var response = await client.GetAsync($"/api/v1/chat-runs/{runId}");

        Log($"  StatusCode: {response.StatusCode}");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }

    [Fact]
    public async Task CV4_RunAccess_OtherUserCannotGetRun()
    {
        if (_userBToken == null)
        {
            Log("[Skip] No userB token");
            return;
        }

        var runId = await CreateRunAsRoot();
        if (runId == null)
        {
            Log("[Skip] Could not create run");
            return;
        }

        Log($"[CV4] OtherUser GetRun: userB({_userBUserId}) + runId={runId}");

        var client = CreateClient(_userBToken);
        var response = await client.GetAsync($"/api/v1/chat-runs/{runId}");
        var body = await response.Content.ReadAsStringAsync();

        Log($"  StatusCode: {response.StatusCode}");
        Log($"  Body: {Truncate(body, 300)}");

        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
        AssertErrorCode(body, "PERMISSION_DENIED");
    }

    [Fact]
    public async Task CV4_RunAccess_OtherUserCannotCancelRun()
    {
        if (_userBToken == null)
        {
            Log("[Skip] No userB token");
            return;
        }

        var runId = await CreateRunAsRoot();
        if (runId == null)
        {
            Log("[Skip] Could not create run");
            return;
        }

        Log($"[CV4] OtherUser CancelRun: userB({_userBUserId}) + runId={runId}");

        var client = CreateClient(_userBToken);
        var response = await client.PostAsync($"/api/v1/chat-runs/{runId}/cancel", null);
        var body = await response.Content.ReadAsStringAsync();

        Log($"  StatusCode: {response.StatusCode}");
        Log($"  Body: {Truncate(body, 300)}");

        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
        AssertErrorCode(body, "PERMISSION_DENIED");
    }

    [Fact]
    public async Task CV4_RunAccess_OtherUserStreamGetsDenied()
    {
        if (_userBToken == null)
        {
            Log("[Skip] No userB token");
            return;
        }

        var runId = await CreateRunAsRoot();
        if (runId == null)
        {
            Log("[Skip] Could not create run");
            return;
        }

        Log($"[CV4] OtherUser StreamRun: userB({_userBUserId}) + runId={runId}");

        var client = CreateClient(_userBToken);
        var response = await client.GetAsync($"/api/v1/chat-runs/{runId}/stream");
        var body = await response.Content.ReadAsStringAsync();

        Log($"  StatusCode: {response.StatusCode}");
        Log($"  Body: {Truncate(body, 200)}");

        // SSE returns 200 with error event
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Contains("event: error", body);
        Assert.Contains("PERMISSION_DENIED", body);
    }

    // ══════════════════════════════════════════
    // Cross-validation 5: Consistency check
    // Skill list visible items match execute permission
    // ══════════════════════════════════════════

    [Fact]
    public async Task CV5_SkillListAndExecute_ShouldBeConsistent()
    {
        if (_rootToken == null || _rootSessionId == null)
        {
            Log("[Skip] Missing root token / session");
            return;
        }

        Log("[CV5] Skill list vs execute consistency");

        var client = CreateClient(_rootToken);

        // Get all visible skills
        var listResp = await client.GetAsync("/api/prd-agent/skills");
        Assert.Equal(HttpStatusCode.OK, listResp.StatusCode);

        var listBody = await listResp.Content.ReadAsStringAsync();
        using var listDoc = JsonDocument.Parse(listBody);
        var skills = listDoc.RootElement.GetProperty("data").GetProperty("skills");

        Log($"  Visible skills: {skills.GetArrayLength()}");

        // Try executing the first 3 skills — they should NOT return 403
        // (they may return other errors like missing context, but not permission denied)
        var count = 0;
        foreach (var skill in skills.EnumerateArray())
        {
            if (count >= 3) break;
            var key = skill.GetProperty("skillKey").GetString()!;

            var execResp = await client.PostAsJsonAsync(
                $"/api/prd-agent/skills/{key}/execute",
                new { sessionId = _rootSessionId });

            Log($"  Skill [{key}] execute => {execResp.StatusCode}");
            Assert.NotEqual(HttpStatusCode.Forbidden, execResp.StatusCode);

            count++;
        }

        if (count == 0)
            Log("  No skills to validate");
        else
            Log($"  Validated {count} skills: all accessible (no 403)");
    }

    // ══════════════════════════════════════════
    // Helpers
    // ══════════════════════════════════════════

    private async Task<string?> LoginAsync(string username, string password, string clientType)
    {
        var client = _factory.CreateClient();
        var response = await client.PostAsJsonAsync("/api/v1/auth/login", new
        {
            username,
            password,
            clientType
        });

        if (response.StatusCode != HttpStatusCode.OK)
        {
            var err = await response.Content.ReadAsStringAsync();
            Log($"[Login] {username} failed: {response.StatusCode} - {Truncate(err, 200)}");
            return null;
        }

        var body = await response.Content.ReadAsStringAsync();
        using var doc = JsonDocument.Parse(body);
        return doc.RootElement.GetProperty("data").GetProperty("accessToken").GetString();
    }

    private static string? ExtractUserId(string jwtToken)
    {
        // Decode JWT payload (no verification needed, just read claims)
        var parts = jwtToken.Split('.');
        if (parts.Length < 2) return null;

        var payload = parts[1];
        // Pad base64
        switch (payload.Length % 4)
        {
            case 2: payload += "=="; break;
            case 3: payload += "="; break;
        }

        var bytes = Convert.FromBase64String(payload.Replace('-', '+').Replace('_', '/'));
        using var doc = JsonDocument.Parse(bytes);
        return doc.RootElement.TryGetProperty("sub", out var sub) ? sub.GetString() : null;
    }

    private HttpClient CreateClient(string token)
    {
        var client = _factory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);
        return client;
    }

    private async Task<string?> CreateRunAsRoot()
    {
        if (_rootToken == null || _rootSessionId == null) return null;

        var client = CreateClient(_rootToken);
        var response = await client.PostAsJsonAsync(
            $"/api/v1/sessions/{_rootSessionId}/messages/run",
            new { content = $"[test] cv4-run-{Guid.NewGuid().ToString("N")[..6]}" });

        if (response.StatusCode != HttpStatusCode.OK)
        {
            var err = await response.Content.ReadAsStringAsync();
            Log($"[CreateRun] Failed: {response.StatusCode} - {Truncate(err, 200)}");
            return null;
        }

        var body = await response.Content.ReadAsStringAsync();
        using var doc = JsonDocument.Parse(body);
        var runId = doc.RootElement.GetProperty("data").GetProperty("runId").GetString();
        Log($"[CreateRun] OK, runId={runId}");
        return runId;
    }

    private static void AssertErrorCode(string responseBody, string expectedCode)
    {
        using var doc = JsonDocument.Parse(responseBody);
        if (doc.RootElement.TryGetProperty("error", out var error) &&
            error.TryGetProperty("code", out var code))
        {
            Assert.Equal(expectedCode, code.GetString());
        }
    }

    private static string Truncate(string s, int maxLen)
        => s.Length <= maxLen ? s : s[..maxLen] + "...";
}
