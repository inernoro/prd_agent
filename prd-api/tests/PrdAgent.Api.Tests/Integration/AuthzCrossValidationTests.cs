using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Xunit;
using Xunit.Abstractions;

namespace PrdAgent.Api.Tests.Integration;

/// <summary>
/// Cross-validation integration tests: verify that skill execute, chat-run create,
/// and run access endpoints enforce identical authorization rules.
///
/// Uses X-AI-Access-Key + X-AI-Impersonate to simulate any user (no JWT needed).
///
/// Test matrix:
///   CV1: Owner CAN access own session (skill execute + chat-run, no 403)
///   CV2: Non-owner CANNOT access other's session (both paths -> 403)
///   CV3: Non-existent session -> 404 (both paths)
///   CV4: Run access — owner OK, other user 403 (get/cancel/stream)
///   CV5: Skill list visibility consistent with execute permission
///
/// Requires: real MongoDB + Redis + AI_ACCESS_KEY configured.
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

    private string? _aiAccessKey;

    // UserA: the owner of a personal session (first human user found)
    private string? _userAUsername;
    private string? _userASessionId;

    // UserB: a different user who should NOT be able to access UserA's session
    private string? _userBUsername;

    // Available skill key
    private string? _availableSkillKey;

    public AuthzCrossValidationTests(WebApplicationFactory<Program> factory, ITestOutputHelper output)
    {
        _factory = factory;
        _output = output;
    }

    private void Log(string message) => _output.WriteLine(message);

    public async Task InitializeAsync()
    {
        // Read AI_ACCESS_KEY from app config (same as the running server)
        using var scope = _factory.Services.CreateScope();
        var config = scope.ServiceProvider.GetRequiredService<IConfiguration>();
        _aiAccessKey = (config["AI_ACCESS_KEY"] ?? "").Trim();

        if (string.IsNullOrWhiteSpace(_aiAccessKey))
        {
            Log("[Init] AI_ACCESS_KEY not configured, all tests will skip");
            return;
        }
        Log("[Init] AI_ACCESS_KEY found");

        // Find all human users
        var adminClient = CreateClient("admin");
        var usersResp = await adminClient.GetAsync("/api/users");
        if (usersResp.StatusCode != HttpStatusCode.OK)
        {
            // Try "root" as impersonation target
            adminClient = CreateClient("root");
            usersResp = await adminClient.GetAsync("/api/users");
        }

        if (usersResp.StatusCode != HttpStatusCode.OK)
        {
            Log($"[Init] Cannot list users: {usersResp.StatusCode}");
            return;
        }

        var usersBody = await usersResp.Content.ReadAsStringAsync();
        using var usersDoc = JsonDocument.Parse(usersBody);
        var users = usersDoc.RootElement.GetProperty("data").GetProperty("items");

        // Collect human (non-bot) usernames
        var humanUsers = new List<(string username, string userId)>();
        foreach (var u in users.EnumerateArray())
        {
            var userType = u.TryGetProperty("userType", out var ut) ? ut.GetString() : null;
            var botKind = u.TryGetProperty("botKind", out var bk) ? bk.GetString() : null;
            var username = u.GetProperty("username").GetString()!;
            var userId = u.GetProperty("userId").GetString()!;

            // Skip bots
            if (userType == "Bot" || !string.IsNullOrWhiteSpace(botKind)) continue;
            humanUsers.Add((username, userId));
        }

        Log($"[Init] Found {humanUsers.Count} human users: {string.Join(", ", humanUsers.Select(u => u.username))}");

        // Find UserA: a human user who has at least one personal session
        foreach (var (username, userId) in humanUsers)
        {
            var client = CreateClient(username);
            var sessResp = await client.GetAsync("/api/v1/sessions");
            if (sessResp.StatusCode != HttpStatusCode.OK) continue;

            var sessBody = await sessResp.Content.ReadAsStringAsync();
            using var sessDoc = JsonDocument.Parse(sessBody);
            var items = sessDoc.RootElement.GetProperty("data").GetProperty("items");
            if (items.GetArrayLength() == 0) continue;

            _userAUsername = username;
            _userASessionId = items[0].GetProperty("sessionId").GetString();
            Log($"[Init] UserA: {username} (userId={userId}), session: {_userASessionId}");
            break;
        }

        if (_userAUsername == null)
            Log("[Init] No user with sessions found, session-dependent tests will skip");

        // Find UserB: any different human user
        foreach (var (username, _) in humanUsers)
        {
            if (username != _userAUsername)
            {
                _userBUsername = username;
                Log($"[Init] UserB: {username}");
                break;
            }
        }

        if (_userBUsername == null)
            Log("[Init] No second user found, cross-user tests will skip");

        // Find an available skill (impersonate UserA if available, else admin)
        var skillClient = CreateClient(_userAUsername ?? "admin");
        var skillsResp = await skillClient.GetAsync("/api/prd-agent/skills");
        if (skillsResp.StatusCode == HttpStatusCode.OK)
        {
            var skillsBody = await skillsResp.Content.ReadAsStringAsync();
            using var skillsDoc = JsonDocument.Parse(skillsBody);
            var skills = skillsDoc.RootElement.GetProperty("data").GetProperty("skills");
            if (skills.GetArrayLength() > 0)
            {
                _availableSkillKey = skills[0].GetProperty("skillKey").GetString();
                Log($"[Init] Available skill: {_availableSkillKey}");
            }
        }

        if (_availableSkillKey == null)
            Log("[Init] No skills available, skill tests will skip");
    }

    public Task DisposeAsync() => Task.CompletedTask;

    private HttpClient CreateClient(string impersonateUsername)
    {
        var client = _factory.CreateClient();
        client.DefaultRequestHeaders.Add("X-AI-Access-Key", _aiAccessKey);
        client.DefaultRequestHeaders.Add("X-AI-Impersonate", impersonateUsername);
        return client;
    }

    private bool Ready => !string.IsNullOrWhiteSpace(_aiAccessKey);

    // ══════════════════════════════════════════
    // CV1: Owner CAN access own session
    // ══════════════════════════════════════════

    [Fact]
    public async Task CV1_SkillExecute_OwnerSession_ShouldNotReturn403()
    {
        if (!Ready || _userAUsername == null || _userASessionId == null || _availableSkillKey == null)
        { Log("[Skip] Missing prerequisites"); return; }

        Log($"[CV1] Skill execute: {_userAUsername} + own session + skill({_availableSkillKey})");
        var client = CreateClient(_userAUsername);
        var response = await client.PostAsJsonAsync(
            $"/api/prd-agent/skills/{_availableSkillKey}/execute",
            new { sessionId = _userASessionId });

        var body = await response.Content.ReadAsStringAsync();
        Log($"  => {response.StatusCode} | {Truncate(body, 200)}");

        Assert.NotEqual(HttpStatusCode.Forbidden, response.StatusCode);
        Assert.NotEqual(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    [Fact]
    public async Task CV1_ChatRunCreate_OwnerSession_ShouldNotReturn403()
    {
        if (!Ready || _userAUsername == null || _userASessionId == null)
        { Log("[Skip] Missing prerequisites"); return; }

        Log($"[CV1] ChatRun create: {_userAUsername} + own session");
        var client = CreateClient(_userAUsername);
        var response = await client.PostAsJsonAsync(
            $"/api/v1/sessions/{_userASessionId}/messages/run",
            new { content = "[cv-test] owner access check" });

        var body = await response.Content.ReadAsStringAsync();
        Log($"  => {response.StatusCode} | {Truncate(body, 200)}");

        Assert.NotEqual(HttpStatusCode.Forbidden, response.StatusCode);
        Assert.NotEqual(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    // ══════════════════════════════════════════
    // CV2: Non-owner CANNOT access other's session
    // ══════════════════════════════════════════

    [Fact]
    public async Task CV2_SkillExecute_OtherUserSession_ShouldReturn403()
    {
        if (!Ready || _userBUsername == null || _userASessionId == null || _availableSkillKey == null)
        { Log("[Skip] Missing prerequisites"); return; }

        Log($"[CV2] Skill execute: {_userBUsername} + {_userAUsername}'s session");
        var client = CreateClient(_userBUsername);
        var response = await client.PostAsJsonAsync(
            $"/api/prd-agent/skills/{_availableSkillKey}/execute",
            new { sessionId = _userASessionId });

        var body = await response.Content.ReadAsStringAsync();
        Log($"  => {response.StatusCode} | {Truncate(body, 200)}");

        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
        AssertErrorCode(body, "PERMISSION_DENIED");
    }

    [Fact]
    public async Task CV2_ChatRunCreate_OtherUserSession_ShouldReturn403()
    {
        if (!Ready || _userBUsername == null || _userASessionId == null)
        { Log("[Skip] Missing prerequisites"); return; }

        Log($"[CV2] ChatRun create: {_userBUsername} + {_userAUsername}'s session");
        var client = CreateClient(_userBUsername);
        var response = await client.PostAsJsonAsync(
            $"/api/v1/sessions/{_userASessionId}/messages/run",
            new { content = "[cv-test] cross-user denial" });

        var body = await response.Content.ReadAsStringAsync();
        Log($"  => {response.StatusCode} | {Truncate(body, 200)}");

        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
        AssertErrorCode(body, "PERMISSION_DENIED");
    }

    // ══════════════════════════════════════════
    // CV3: Non-existent session => 404 (both paths)
    // ══════════════════════════════════════════

    [Fact]
    public async Task CV3_SkillExecute_NonExistentSession_Returns404()
    {
        if (!Ready || _userAUsername == null || _availableSkillKey == null)
        { Log("[Skip] Missing prerequisites"); return; }

        Log("[CV3] Skill execute: non-existent session");
        var client = CreateClient(_userAUsername);
        var response = await client.PostAsJsonAsync(
            $"/api/prd-agent/skills/{_availableSkillKey}/execute",
            new { sessionId = "cv3-phantom-" + Guid.NewGuid().ToString("N")[..8] });

        Log($"  => {response.StatusCode}");
        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    [Fact]
    public async Task CV3_ChatRunCreate_NonExistentSession_Returns404()
    {
        if (!Ready || _userAUsername == null)
        { Log("[Skip] Missing prerequisites"); return; }

        Log("[CV3] ChatRun create: non-existent session");
        var client = CreateClient(_userAUsername);
        var response = await client.PostAsJsonAsync(
            $"/api/v1/sessions/cv3-phantom-{Guid.NewGuid().ToString("N")[..8]}/messages/run",
            new { content = "test" });

        Log($"  => {response.StatusCode}");
        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    // ══════════════════════════════════════════
    // CV4: Run access — owner OK, other user 403
    // ══════════════════════════════════════════

    [Fact]
    public async Task CV4_RunAccess_OwnerCanGetRun()
    {
        var runId = await CreateRunAs(_userAUsername);
        if (runId == null) { Log("[Skip] Could not create run"); return; }

        Log($"[CV4] Owner GetRun: {_userAUsername} + runId={runId}");
        var client = CreateClient(_userAUsername!);
        var response = await client.GetAsync($"/api/v1/chat-runs/{runId}");

        Log($"  => {response.StatusCode}");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }

    [Fact]
    public async Task CV4_RunAccess_OtherUserCannotGetRun()
    {
        if (_userBUsername == null) { Log("[Skip] No userB"); return; }
        var runId = await CreateRunAs(_userAUsername);
        if (runId == null) { Log("[Skip] Could not create run"); return; }

        Log($"[CV4] OtherUser GetRun: {_userBUsername} + runId={runId}");
        var client = CreateClient(_userBUsername);
        var response = await client.GetAsync($"/api/v1/chat-runs/{runId}");
        var body = await response.Content.ReadAsStringAsync();

        Log($"  => {response.StatusCode} | {Truncate(body, 200)}");
        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
        AssertErrorCode(body, "PERMISSION_DENIED");
    }

    [Fact]
    public async Task CV4_RunAccess_OtherUserCannotCancelRun()
    {
        if (_userBUsername == null) { Log("[Skip] No userB"); return; }
        var runId = await CreateRunAs(_userAUsername);
        if (runId == null) { Log("[Skip] Could not create run"); return; }

        Log($"[CV4] OtherUser Cancel: {_userBUsername} + runId={runId}");
        var client = CreateClient(_userBUsername);
        var response = await client.PostAsync($"/api/v1/chat-runs/{runId}/cancel", null);
        var body = await response.Content.ReadAsStringAsync();

        Log($"  => {response.StatusCode} | {Truncate(body, 200)}");
        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
        AssertErrorCode(body, "PERMISSION_DENIED");
    }

    [Fact]
    public async Task CV4_RunAccess_OtherUserStreamGetsDenied()
    {
        if (_userBUsername == null) { Log("[Skip] No userB"); return; }
        var runId = await CreateRunAs(_userAUsername);
        if (runId == null) { Log("[Skip] Could not create run"); return; }

        Log($"[CV4] OtherUser Stream: {_userBUsername} + runId={runId}");
        var client = CreateClient(_userBUsername);
        var response = await client.GetAsync($"/api/v1/chat-runs/{runId}/stream");
        var body = await response.Content.ReadAsStringAsync();

        Log($"  => {response.StatusCode} | {Truncate(body, 150)}");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Contains("event: error", body);
        Assert.Contains("PERMISSION_DENIED", body);
    }

    // ══════════════════════════════════════════
    // CV5: Skill list visibility = execute permission
    // ══════════════════════════════════════════

    [Fact]
    public async Task CV5_SkillListAndExecute_ShouldBeConsistent()
    {
        if (!Ready || _userAUsername == null || _userASessionId == null)
        { Log("[Skip] Missing prerequisites"); return; }

        Log("[CV5] Skill list vs execute consistency");
        var client = CreateClient(_userAUsername);

        var listResp = await client.GetAsync("/api/prd-agent/skills");
        Assert.Equal(HttpStatusCode.OK, listResp.StatusCode);

        var listBody = await listResp.Content.ReadAsStringAsync();
        using var listDoc = JsonDocument.Parse(listBody);
        var skills = listDoc.RootElement.GetProperty("data").GetProperty("skills");
        Log($"  Visible skills: {skills.GetArrayLength()}");

        var count = 0;
        foreach (var skill in skills.EnumerateArray())
        {
            if (count >= 3) break;
            var key = skill.GetProperty("skillKey").GetString()!;

            var execResp = await client.PostAsJsonAsync(
                $"/api/prd-agent/skills/{key}/execute",
                new { sessionId = _userASessionId });

            Log($"  [{key}] => {execResp.StatusCode}");

            // Visible skill should not be 403 for the same user
            Assert.NotEqual(HttpStatusCode.Forbidden, execResp.StatusCode);
            count++;
        }

        Log(count == 0
            ? "  No skills to validate"
            : $"  Validated {count} skills: none returned 403");
    }

    // ══════════════════════════════════════════
    // Helpers
    // ══════════════════════════════════════════

    private async Task<string?> CreateRunAs(string? username)
    {
        if (!Ready || username == null || _userASessionId == null) return null;

        var client = CreateClient(username);
        var response = await client.PostAsJsonAsync(
            $"/api/v1/sessions/{_userASessionId}/messages/run",
            new { content = $"[cv-test] run-{Guid.NewGuid().ToString("N")[..6]}" });

        if (response.StatusCode != HttpStatusCode.OK)
        {
            var err = await response.Content.ReadAsStringAsync();
            Log($"[CreateRun] {username} => {response.StatusCode}: {Truncate(err, 150)}");
            return null;
        }

        var body = await response.Content.ReadAsStringAsync();
        using var doc = JsonDocument.Parse(body);
        var runId = doc.RootElement.GetProperty("data").GetProperty("runId").GetString();
        Log($"[CreateRun] {username} => runId={runId}");
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
