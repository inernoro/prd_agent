using System.Net;
using System.Text.Json;
using Microsoft.Extensions.Logging.Abstractions;
using MongoDB.Driver;
using PrdAgent.Api.Services;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public sealed class MiduoPlanetSsoAuditTests
{
    private const string Secret = "fixture-app-secret";
    private const string Token = "fixture-exchange-token";

    [Theory]
    [InlineData("{}", "missing", null)]
    [InlineData("{\"mobile\":null}", "null", null)]
    [InlineData("{\"mobile\":\"\"}", "empty", "empty")]
    [InlineData("{\"mobile\":\"   \"}", "whitespace", "empty")]
    [InlineData("{\"mobile\":{\"value\":\"18600000000\"}}", "wrong_type", null)]
    [InlineData("{\"mobile\":[\"18600000000\"]}", "wrong_type", null)]
    [InlineData("{\"mobile\":\"---\"}", "no_digits", "no_digits")]
    [InlineData("{\"mobile\":\"186****0000\"}", "present", "unexpected_digit_count")]
    [InlineData("{\"mobile\":\"18600000000\"}", "present", "11_digits")]
    public void Snapshot_ShouldExplainTheActualFieldCondition(string fields, string expected, string? format)
    {
        using var doc = JsonDocument.Parse("{\"return_data\":" + fields + "}");
        var evidence = MiduoPlanetSsoAudit.DescribeField(doc.RootElement, "mobile", "mobile", Secret);
        Assert.Equal(expected, evidence["state"]!.GetValue<string>());
        Assert.Equal(format, evidence["format"]?.GetValue<string>());
        Assert.DoesNotContain("18600000000", evidence.ToJsonString());
    }

    [Fact]
    public void Snapshot_ShouldPreserveUpstreamReasonAndShapeWithoutCredentialsOrPersonalValues()
    {
        var raw = """
            {"return_code":0,"return_msg":"操作成功","trace_id":"trace-fixture-1",
             "return_data":{"valid":true,"message":"资料不完整 token=fixture-exchange-token 手机号18600000000",
                "mobile":"18600000000","userName":"测试用户","email":"fixture@example.test",
                "sessionToken":"fixture-session","nested":[{"refresh_token":"fixture-refresh","password":{"value":"fixture-password"}}],
                "unexpected":"fixture-extra-private","unknownNumericIdentity":18612345678,"phoneNumber":18698765432}}
            """;
        using var response = Response(200, raw);
        response.Headers.Add("Set-Cookie", "fixture-cookie=private");
        response.Headers.Add("X-Request-ID", "provider-trace-1");
        var snapshot = MiduoPlanetSsoAudit.BuildResponse(raw, "validation_rejected", "SSO_PROFILE_INCOMPLETE",
            "mobile", Secret, Token, false, raw.Length, raw.Length, response);
        using var doc = JsonDocument.Parse(snapshot);
        var root = doc.RootElement;
        Assert.Equal(0, root.GetProperty("upstreamResponse").GetProperty("return_code").GetInt32());
        Assert.True(root.GetProperty("upstreamResponse").GetProperty("return_data").GetProperty("valid").GetBoolean());
        Assert.Contains("资料不完整", root.GetProperty("upstreamResponse").GetProperty("return_data").GetProperty("message").GetString());
        Assert.Equal("provider-trace-1", root.GetProperty("safeResponseHeaders").GetProperty("X-Request-ID").GetString());
        Assert.False(root.GetProperty("safeResponseHeaders").TryGetProperty("Set-Cookie", out _));
        foreach (var sensitive in new[] { Secret, Token, "18600000000", "测试用户", "fixture@example.test", "fixture-session", "fixture-refresh", "fixture-password", "fixture-extra-private", "fixture-cookie", "18612345678", "18698765432" })
            Assert.DoesNotContain(sensitive, snapshot);
        Assert.Equal("String", root.GetProperty("fieldDiagnostics").GetProperty("mobile").GetProperty("valueKind").GetString());
    }

    [Theory]
    [InlineData("<html>token=fixture-exchange-token secret=fixture-app-secret 18600000000</html>")]
    [InlineData("{\"message\":\"fixture-app-secret\",\"sessionToken\":\"fixture-session\"")]
    [InlineData("{\"message\":\"fixture\\u002Dapp\\u002Dsecret\" broken")]
    public void UnparseableBody_ShouldRemainAuditableWithoutLeakingSecrets(string raw)
    {
        using var response = Response(502, raw);
        var snapshot = MiduoPlanetSsoAudit.BuildResponse(raw, "parse_error", "SSO_PROVIDER_UNAVAILABLE", "mobile", Secret, Token, false, raw.Length, raw.Length, response);
        using var doc = JsonDocument.Parse(snapshot);
        Assert.True(doc.RootElement.GetProperty("responseReceived").GetBoolean());
        Assert.False(doc.RootElement.GetProperty("parseSucceeded").GetBoolean());
        Assert.Equal("unavailable", doc.RootElement.GetProperty("fieldDiagnostics").GetProperty("mobile").GetProperty("state").GetString());
        foreach (var value in new[] { Secret, Token, "fixture-session", "18600000000" }) Assert.DoesNotContain(value, snapshot);
    }

    [Fact]
    public void CaptureLimit_ShouldExposeItsScopeInsteadOfPretendingTheResponseWasComplete()
    {
        using var response = Response(200, "{}");
        var snapshot = MiduoPlanetSsoAudit.BuildResponse("{}", "response_too_large", "SSO_PROVIDER_UNAVAILABLE", "mobile", Secret, Token, true, 100, 200, response);
        using var doc = JsonDocument.Parse(snapshot);
        Assert.True(doc.RootElement.GetProperty("captureTruncated").GetBoolean());
        Assert.Equal("captured_prefix", doc.RootElement.GetProperty("fingerprintScope").GetString());
        Assert.Equal(200, doc.RootElement.GetProperty("declaredBytes").GetInt32());
        Assert.Equal("response_capture_limit", doc.RootElement.GetProperty("truncationReason").GetString());
    }

    [Fact]
    public async Task MongoAudit_ShouldPersistPreparationAndFinalEvidenceAndExposeItByParentRequestId()
    {
        // 与 CI 的真实 Mongo 服务走同一路径，测试只操作自己创建的随机数据库。
        var connection = Environment.GetEnvironmentVariable("MONGODB_TEST_CONNECTION") ?? "mongodb://127.0.0.1:27017";
        var dbName = "test_sso_audit_" + Guid.NewGuid().ToString("N");
        var client = new MongoClient(connection);
        var db = new MongoDbContext(connection, dbName);
        var writer = new MiduoPlanetSsoAuditWriter(db, NullLogger<MiduoPlanetSsoAuditWriter>.Instance);
        var row = new ApiRequestLog { Id = Guid.NewGuid().ToString("N"), RequestId = "incoming-fixture-1",
            Direction = "outbound", Path = "/api/open/sso/validate-login-token", Status = "running", StartedAt = DateTime.UtcNow,
            RequestBody = "{\"config\":{\"SubjectType\":\"mobile\"},\"runtime\":{\"actualCommit\":\"fixture-commit\"}}" };
        try
        {
            Assert.True(await writer.BeginAsync(row));
            var prepared = await db.ApiRequestLogs.Find(x => x.Id == row.Id).SingleAsync();
            Assert.Equal("running", prepared.Status);
            row.Status = "failed";
            row.StatusCode = 200;
            row.ErrorCode = "SSO_PROFILE_INCOMPLETE";
            row.EndedAt = DateTime.UtcNow;
            const string body = "{\"return_code\":0,\"return_data\":{\"valid\":true,\"mobile\":null}}";
            using var response = Response(200, body);
            row.ResponseBody = MiduoPlanetSsoAudit.BuildResponse(body, "validation_rejected", row.ErrorCode, "mobile", Secret, Token, false, body.Length, body.Length, response);
            Assert.True(await writer.CompleteAsync(row));
            var stored = await db.ApiRequestLogs.Find(x => x.RequestId == "incoming-fixture-1").SingleAsync();
            Assert.Equal("failed", stored.Status);
            Assert.Equal(200, stored.StatusCode);
            Assert.NotNull(stored.EndedAt);
            Assert.Contains("fixture-commit", stored.RequestBody);
            using var evidence = JsonDocument.Parse(stored.ResponseBody!);
            Assert.Equal("null", evidence.RootElement.GetProperty("selectedFieldState").GetString());
            Assert.True(evidence.RootElement.GetProperty("upstreamResponse").GetProperty("return_data").GetProperty("valid").GetBoolean());
            Assert.Equal(1, await db.ApiRequestLogs.CountDocumentsAsync(x => x.RequestId == "incoming-fixture-1"));
        }
        finally { await client.DropDatabaseAsync(dbName); }
    }

    private static HttpResponseMessage Response(int status, string body)
        => new((HttpStatusCode)status) { Content = new StringContent(body) };
}
