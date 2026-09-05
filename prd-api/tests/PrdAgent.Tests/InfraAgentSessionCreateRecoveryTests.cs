using PrdAgent.Core.Interfaces;
using PrdAgent.Infrastructure.Services.InfraAgentSessions;
using Xunit;

namespace PrdAgent.Tests;

public sealed class InfraAgentSessionCreateRecoveryTests
{
    [Fact]
    public void FailedCreateResponseKeepsRemoteSessionIdentityForCleanup()
    {
        const string body = """
            {
              "error": { "code": "workspace_cleanup_failed", "message": "OpenDesign 资源清理未完成" },
              "item": {
                "id": "cds-agent-residual",
                "status": "failed",
                "containerName": "cds-od-residual"
              }
            }
            """;

        var parsed = InfraAgentSessionService.ParseCdsCreateSessionResponse(false, body);

        Assert.True(parsed.Item.HasValue);
        Assert.Equal("cds-agent-residual", parsed.Item.Value.GetProperty("id").GetString());
        Assert.Equal("OpenDesign 资源清理未完成", parsed.ErrorMessage);
    }

    [Fact]
    public void FailedCreateWithoutJsonDoesNotExposeRawResponse()
    {
        var parsed = InfraAgentSessionService.ParseCdsCreateSessionResponse(
            false,
            "upstream token=should-not-be-returned");

        Assert.False(parsed.Item.HasValue);
        Assert.Equal("CDS 创建会话失败，远端未返回可恢复信息", parsed.ErrorMessage);
        Assert.DoesNotContain("token", parsed.ErrorMessage, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task FailedCreatePersistsRemoteIdentityBeforeThrowingWithRecoveryToken()
    {
        using var response = new HttpResponseMessage(System.Net.HttpStatusCode.InternalServerError)
        {
            Content = new StringContent("""
                {
                  "error": { "code": "workspace_cleanup_failed", "message": "cleanup pending" },
                  "item": { "id": "cds-agent-residual", "status": "failed" }
                }
                """)
        };
        using var callerCts = new CancellationTokenSource();
        callerCts.Cancel();
        var order = new List<string>();
        string? persistedId = null;

        var error = await Assert.ThrowsAsync<InfraAgentSessionException>(async () =>
        {
            await InfraAgentSessionService.ProcessCdsCreateResponseAsync(
                response,
                (parsed, recoveryToken) =>
                {
                    Assert.NotEqual(callerCts.Token, recoveryToken);
                    Assert.False(recoveryToken.IsCancellationRequested);
                    persistedId = parsed.Item!.Value.GetProperty("id").GetString();
                    order.Add("persisted");
                    return Task.CompletedTask;
                },
                TimeSpan.FromSeconds(1));
            order.Add("returned");
        });

        order.Add("thrown");
        Assert.Equal("cds-agent-residual", persistedId);
        Assert.Equal(["persisted", "thrown"], order);
        Assert.Equal("cleanup pending", error.Message);
        var stopRequest = InfraAgentSessionService.BuildCdsSessionStopRequest("project-a", persistedId!);
        Assert.Equal(HttpMethod.Post, stopRequest.Method);
        Assert.Equal(
            "/api/projects/project-a/agent-sessions/cds-agent-residual/stop",
            stopRequest.Path);
    }

    [Fact]
    public void CdsErrorMessageRedactsSecretsUrlsAndCapsLength()
    {
        var message = "token=plain-secret Authorization: Bearer bearer-secret "
            + "https://user:password@cds.test/path?access_token=query-secret#fragment "
            + "sk-abcdefghijk "
            + new string('x', 800);

        var safe = InfraAgentSessionService.SanitizeCdsErrorMessage(message);

        Assert.DoesNotContain("plain-secret", safe);
        Assert.DoesNotContain("bearer-secret", safe);
        Assert.DoesNotContain("password", safe);
        Assert.DoesNotContain("query-secret", safe);
        Assert.DoesNotContain("fragment", safe);
        Assert.DoesNotContain("sk-abcdefghijk", safe);
        Assert.Contains("https://cds.test/path", safe);
        Assert.EndsWith("...[truncated]", safe);
        Assert.True(safe.Length <= 526);
    }

    [Fact]
    public void CdsHttpFailureNeverIncludesRawBody()
    {
        var malformed = InfraAgentSessionService.BuildCdsRequestFailureMessage(
            500,
            "gateway token=raw-secret and internal stack trace");
        var structured = InfraAgentSessionService.BuildCdsRequestFailureMessage(
            429,
            """{"error":{"message":"token=structured-secret retry later"},"debug":"raw-debug-secret"}""");

        Assert.Equal("CDS 请求失败：HTTP 500 CDS 远端请求失败", malformed);
        Assert.DoesNotContain("raw-secret", malformed);
        Assert.DoesNotContain("structured-secret", structured);
        Assert.DoesNotContain("raw-debug-secret", structured);
        Assert.Contains("token=***", structured);
    }

    [Fact]
    public void CdsErrorEventPayloadIsRedactedBeforePersistence()
    {
        const string payload = """
            {
              "message": "Authorization: Bearer event-secret https://user:password@cds.test/fail?token=query-secret",
              "details": {
                "apiKey": "nested-secret",
                "note": "transfer_token=inline-secret"
              }
            }
            """;

        var safe = InfraAgentSessionService.SanitizeCdsEventPayload(payload);

        Assert.DoesNotContain("event-secret", safe);
        Assert.DoesNotContain("password", safe);
        Assert.DoesNotContain("query-secret", safe);
        Assert.DoesNotContain("nested-secret", safe);
        Assert.DoesNotContain("inline-secret", safe);
        Assert.Contains("https://cds.test/fail", safe);
        Assert.Contains("\"apiKey\":\"***\"", safe);
    }
}
