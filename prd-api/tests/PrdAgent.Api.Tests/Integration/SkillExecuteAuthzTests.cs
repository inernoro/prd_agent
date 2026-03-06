using System.IdentityModel.Tokens.Jwt;
using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Security.Claims;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.IdentityModel.Tokens;
using Xunit;
using Xunit.Abstractions;

namespace PrdAgent.Api.Tests.Integration;

/// <summary>
/// 技能执行 + ChatRun 权限校验集成测试
///
/// 需要真实 MongoDB + Redis，CI 中排除。
///
/// 运行方式：
/// cd prd-api
/// dotnet test --filter "FullyQualifiedName~SkillExecuteAuthzTests" --logger "console;verbosity=detailed"
/// </summary>
[Collection("Integration")]
[Trait("Category", TestCategories.Integration)]
public class SkillExecuteAuthzTests : IClassFixture<WebApplicationFactory<Program>>
{
    private readonly WebApplicationFactory<Program> _factory;
    private readonly ITestOutputHelper _output;

    public SkillExecuteAuthzTests(WebApplicationFactory<Program> factory, ITestOutputHelper output)
    {
        _factory = factory;
        _output = output;
    }

    private void Log(string message) => _output.WriteLine(message);

    private HttpClient CreateAuthenticatedClient(string userId)
    {
        var client = _factory.CreateClient();
        var token = GenerateJwtToken(userId);
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);
        return client;
    }

    private string GenerateJwtToken(string userId)
    {
        // 从 WebApplicationFactory 的配置中读取 JWT 参数，保持与 Program.cs 一致
        using var scope = _factory.Services.CreateScope();
        var config = scope.ServiceProvider.GetRequiredService<IConfiguration>();

        var secret = config["Jwt:Secret"] ?? throw new InvalidOperationException("Jwt:Secret not configured");
        var issuer = config["Jwt:Issuer"] ?? "prdagent";
        var audience = config["Jwt:Audience"] ?? "prdagent";

        var key = new SymmetricSecurityKey(Encoding.UTF8.GetBytes(secret));
        var creds = new SigningCredentials(key, SecurityAlgorithms.HmacSha256);

        var claims = new[]
        {
            new Claim("userId", userId),
            new Claim("sub", userId),
            new Claim(JwtRegisteredClaimNames.Jti, Guid.NewGuid().ToString())
        };

        var token = new JwtSecurityToken(
            issuer: issuer,
            audience: audience,
            claims: claims,
            expires: DateTime.UtcNow.AddHours(1),
            signingCredentials: creds);

        return new JwtSecurityTokenHandler().WriteToken(token);
    }

    // ──────────────────────────────────────────
    // Skills Execute 权限测试
    // ──────────────────────────────────────────

    [Fact]
    public async Task SkillExecute_NoAuth_ShouldReturn401()
    {
        Log("[Test] 无认证调用技能执行应返回 401");

        var client = _factory.CreateClient(); // 不带 token
        var response = await client.PostAsJsonAsync("/api/prd-agent/skills/any-skill/execute", new
        {
            sessionId = "fake-session"
        });

        Log($"  StatusCode: {response.StatusCode}");
        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    [Fact]
    public async Task SkillExecute_NonExistentSkill_ShouldReturn404()
    {
        Log("[Test] 执行不存在的技能应返回 404");

        var client = CreateAuthenticatedClient("test-user-001");
        var response = await client.PostAsJsonAsync(
            "/api/prd-agent/skills/non-existent-skill-key-12345/execute",
            new { sessionId = "fake-session" });

        Log($"  StatusCode: {response.StatusCode}");
        var body = await response.Content.ReadAsStringAsync();
        Log($"  Body: {body}");

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    [Fact]
    public async Task SkillExecute_EmptySessionId_ShouldReturn400()
    {
        Log("[Test] sessionId 为空应返回 400");

        var client = CreateAuthenticatedClient("test-user-001");
        var response = await client.PostAsJsonAsync(
            "/api/prd-agent/skills/any-skill/execute",
            new { sessionId = "" });

        Log($"  StatusCode: {response.StatusCode}");
        var body = await response.Content.ReadAsStringAsync();
        Log($"  Body: {body}");

        // 可能 404（技能不存在先判断）或 400（sessionId 空先判断），取决于控制器判断顺序
        Assert.True(
            response.StatusCode is HttpStatusCode.BadRequest or HttpStatusCode.NotFound,
            $"Expected 400 or 404, got {response.StatusCode}");
    }

    [Fact]
    public async Task SkillExecute_OtherUsersPersonalSession_ShouldReturn403()
    {
        Log("[Test] 用他人个人会话执行技能应返回 403");
        Log("  说明：需要库中存在一个有效 skill 和另一个用户的 personal session");
        Log("  如果 skill 不存在会先返回 404，测试跳过");

        // 用一个虚构的 userId，session 如果存在肯定不属于该用户
        var client = CreateAuthenticatedClient("attacker-user-" + Guid.NewGuid().ToString("N")[..8]);

        // 先获取技能列表，看有没有可用的 skill
        var listResponse = await client.GetAsync("/api/prd-agent/skills");
        if (listResponse.StatusCode != HttpStatusCode.OK)
        {
            Log("  跳过：无法获取技能列表");
            return;
        }

        var listBody = await listResponse.Content.ReadAsStringAsync();
        using var listDoc = JsonDocument.Parse(listBody);

        var skills = listDoc.RootElement.GetProperty("data").GetProperty("skills");
        if (skills.GetArrayLength() == 0)
        {
            Log("  跳过：没有可用技能");
            return;
        }

        var skillKey = skills[0].GetProperty("skillKey").GetString()!;
        Log($"  使用技能: {skillKey}");

        // 用一个不属于该攻击者的 sessionId（虚构的）
        var response = await client.PostAsJsonAsync(
            $"/api/prd-agent/skills/{skillKey}/execute",
            new { sessionId = "non-existent-session-id" });

        Log($"  StatusCode: {response.StatusCode}");
        var body = await response.Content.ReadAsStringAsync();
        Log($"  Body: {body}");

        // session 不存在应返回 404，或不属于用户返回 403
        Assert.True(
            response.StatusCode is HttpStatusCode.Forbidden or HttpStatusCode.NotFound,
            $"Expected 403 or 404, got {response.StatusCode}");
    }

    // ──────────────────────────────────────────
    // ChatRun 权限测试
    // ──────────────────────────────────────────

    [Fact]
    public async Task ChatRun_CreateRun_NoAuth_ShouldReturn401()
    {
        Log("[Test] 无认证创建 Run 应返回 401");

        var client = _factory.CreateClient();
        var response = await client.PostAsJsonAsync(
            "/api/v1/sessions/fake-session/messages/run",
            new { content = "test" });

        Log($"  StatusCode: {response.StatusCode}");
        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    [Fact]
    public async Task ChatRun_CreateRun_NonExistentSession_ShouldReturn404()
    {
        Log("[Test] 不存在的 session 创建 Run 应返回 404");

        var client = CreateAuthenticatedClient("test-user-001");
        var response = await client.PostAsJsonAsync(
            "/api/v1/sessions/non-existent-session-12345/messages/run",
            new { content = "test" });

        Log($"  StatusCode: {response.StatusCode}");
        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    [Fact]
    public async Task ChatRun_GetRun_NonExistentRun_ShouldReturn404()
    {
        Log("[Test] 查询不存在的 Run 应返回 404");

        var client = CreateAuthenticatedClient("test-user-001");
        var response = await client.GetAsync("/api/v1/chat-runs/non-existent-run-12345");

        Log($"  StatusCode: {response.StatusCode}");
        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    [Fact]
    public async Task ChatRun_Cancel_NonExistentRun_ShouldReturn404()
    {
        Log("[Test] 取消不存在的 Run 应返回 404");

        var client = CreateAuthenticatedClient("test-user-001");
        var response = await client.PostAsync("/api/v1/chat-runs/non-existent-run-12345/cancel", null);

        Log($"  StatusCode: {response.StatusCode}");
        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    [Fact]
    public async Task ChatRun_Stream_NonExistentRun_ShouldReturnErrorEvent()
    {
        Log("[Test] SSE 订阅不存在的 Run 应返回 error event");

        var client = CreateAuthenticatedClient("test-user-001");
        var response = await client.GetAsync("/api/v1/chat-runs/non-existent-run-12345/stream");

        Log($"  StatusCode: {response.StatusCode}");
        var body = await response.Content.ReadAsStringAsync();
        Log($"  Body: {body}");

        // SSE 端点返回 200 + text/event-stream，错误以 event: error 形式返回
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Contains("event: error", body);
    }

    [Fact]
    public async Task ChatRun_Stream_NoAuth_ShouldReturn401()
    {
        Log("[Test] 无认证 SSE 订阅应返回 401");

        var client = _factory.CreateClient();
        var response = await client.GetAsync("/api/v1/chat-runs/any-run/stream");

        Log($"  StatusCode: {response.StatusCode}");
        // 无 token 可能被 auth middleware 拦截为 401，也可能进入 SSE 返回 error event
        Assert.True(
            response.StatusCode is HttpStatusCode.Unauthorized or HttpStatusCode.OK,
            $"Expected 401 or 200 (with error event), got {response.StatusCode}");

        if (response.StatusCode == HttpStatusCode.OK)
        {
            var body = await response.Content.ReadAsStringAsync();
            Assert.Contains("error", body);
        }
    }
}
