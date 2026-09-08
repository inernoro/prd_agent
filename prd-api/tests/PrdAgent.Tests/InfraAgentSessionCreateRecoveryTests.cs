using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Services.InfraAgentSessions;
using Xunit;

namespace PrdAgent.Tests;

public sealed class InfraAgentSessionCreateRecoveryTests
{
    [Theory]
    [InlineData(200, "io")]
    [InlineData(201, "http")]
    [InlineData(202, "cancel")]
    [InlineData(408, "io")]
    [InlineData(502, "http")]
    public async Task LostResponseBodyRecoversSameReservationBeforePersistence(int status, string failure)
    {
        using var response = new HttpResponseMessage((System.Net.HttpStatusCode)status)
        {
            Content = new FailingCreateContent(failure)
        };
        var order = new List<string>();
        var result = await InfraAgentSessionService.ProcessCdsCreateResponseAsync(response,
            (item, _) =>
            {
                Assert.Equal("original-reservation", item.Item!.Value.GetProperty("id").GetString());
                order.Add("persist");
                return Task.CompletedTask;
            },
            recoverAsync: _ =>
            {
                order.Add("recover");
                return Task.FromResult<System.Text.Json.JsonElement?>(System.Text.Json.JsonSerializer.SerializeToElement(
                    new { id = "original-reservation", status = "running" }));
            });
        Assert.True(result.Succeeded);
        Assert.Equal(["recover", "persist"], order);
    }

    [Theory]
    [InlineData("io")]
    [InlineData("http")]
    [InlineData("cancel")]
    public async Task LostBodyAndUnresolvedReplayRemainPendingWithoutPersistence(string failure)
    {
        using var response = new HttpResponseMessage(System.Net.HttpStatusCode.Created)
        {
            Content = new FailingCreateContent(failure)
        };
        var error = await Assert.ThrowsAnyAsync<InfraAgentSessionException>(() =>
            InfraAgentSessionService.ProcessCdsCreateResponseAsync(response,
                (_, _) => throw new Xunit.Sdk.XunitException("must not persist an unknown outcome"),
                recoverAsync: _ => Task.FromResult<System.Text.Json.JsonElement?>(null)));
        Assert.Equal(InfraAgentSessionErrorCodes.SessionCreationPending, error.ErrorCode);
        Assert.DoesNotContain("private-body-detail", error.Message);
    }

    [Fact]
    public async Task LostBodyWithoutRecoveryCallbackRemainsPending()
    {
        using var response = new HttpResponseMessage(System.Net.HttpStatusCode.Created)
        {
            Content = new FailingCreateContent("io")
        };
        var error = await Assert.ThrowsAnyAsync<InfraAgentSessionException>(() =>
            InfraAgentSessionService.ProcessCdsCreateResponseAsync(response,
                (_, _) => throw new Xunit.Sdk.XunitException("must not persist")));
        Assert.Equal(InfraAgentSessionErrorCodes.SessionCreationPending, error.ErrorCode);
    }

    [Theory]
    [InlineData(400)]
    [InlineData(401)]
    [InlineData(403)]
    [InlineData(429)]
    public async Task ExplicitRejectionWithLostBodyDoesNotRecoverOrBypassGate(int status)
    {
        using var response = new HttpResponseMessage((System.Net.HttpStatusCode)status)
        {
            Content = new FailingCreateContent("io")
        };
        var error = await Assert.ThrowsAnyAsync<InfraAgentSessionException>(() =>
            InfraAgentSessionService.ProcessCdsCreateResponseAsync(response,
                (_, _) => throw new Xunit.Sdk.XunitException("must not persist"),
                recoverAsync: _ => throw new Xunit.Sdk.XunitException("must not recover a rejected create")));
        Assert.Equal(InfraAgentSessionErrorCodes.CdsRequestFailed, error.ErrorCode);
        Assert.Contains($"HTTP {status}", error.Message);
        Assert.DoesNotContain("private-body-detail", error.Message);
    }

    [Fact]
    public async Task TruncatedAcceptedBodyUsesDurableRequestLookupInsteadOfProvisionalIdentity()
    {
        using var response = new HttpResponseMessage(System.Net.HttpStatusCode.Accepted)
        {
            Content = new StringContent("{\"item\":")
        };
        var result = await InfraAgentSessionService.ProcessCdsCreateResponseAsync(response,
            (item, _) =>
            {
                Assert.Equal("original-reservation", item.Item!.Value.GetProperty("id").GetString());
                return Task.CompletedTask;
            },
            recoverAsync: _ => Task.FromResult<System.Text.Json.JsonElement?>(System.Text.Json.JsonSerializer.SerializeToElement(
                new { id = "original-reservation", status = "idle" })));
        Assert.True(result.Succeeded);
    }

    private sealed class FailingCreateContent(string failure) : HttpContent
    {
        protected override Task SerializeToStreamAsync(Stream stream, System.Net.TransportContext? context)
            => Task.FromException(failure switch
            {
                "http" => new HttpRequestException("private-body-detail"),
                "cancel" => new OperationCanceledException("private-body-detail"),
                _ => new IOException("private-body-detail")
            });

        protected override bool TryComputeLength(out long length)
        {
            length = 0;
            return false;
        }
    }

    [Theory]
    [InlineData(202)]
    [InlineData(502)]
    [InlineData(524)]
    [InlineData(200)]
    public async Task AcceptedOrUncertainCreateRecoversReadyIdentityBeforeDispatch(int status)
    {
        using var response = new HttpResponseMessage((System.Net.HttpStatusCode)status)
        {
            Content = new StringContent(status == 202
                ? """{"item":{"id":"reservation-1","status":"creating"}}"""
                : "<html>upstream response unavailable token=not-for-users</html>")
        };
        var queries = 0;
        var persisted = new List<string>();
        var result = await InfraAgentSessionService.ProcessCdsCreateResponseAsync(response,
            (item, _) =>
            {
                Assert.True(item.Succeeded);
                persisted.Add(item.Item!.Value.GetProperty("id").GetString()!);
                return Task.CompletedTask;
            },
            recoverAsync: _ =>
            {
                queries++;
                return Task.FromResult<System.Text.Json.JsonElement?>(System.Text.Json.JsonSerializer.SerializeToElement(
                    new { id = "reservation-1", status = "running" }));
            });
        Assert.True(result.Succeeded);
        Assert.Null(result.ErrorMessage);
        Assert.Equal(1, queries);
        Assert.Equal(["reservation-1"], persisted);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("creating")]
    [InlineData("queued")]
    public async Task UncertainCreateKeepsPendingReservationWithoutPersistingDispatchableSession(string? status)
    {
        using var response = new HttpResponseMessage(System.Net.HttpStatusCode.BadGateway)
        {
            Content = new StringContent("<html>gateway unavailable</html>")
        };
        var persisted = false;
        var error = await Assert.ThrowsAnyAsync<InfraAgentSessionException>(() =>
            InfraAgentSessionService.ProcessCdsCreateResponseAsync(response,
                (_, _) => { persisted = true; return Task.CompletedTask; },
                recoverAsync: _ => Task.FromResult<System.Text.Json.JsonElement?>(status == null ? null
                    : System.Text.Json.JsonSerializer.SerializeToElement(new { id = "reservation-1", status }))));
        Assert.Equal(InfraAgentSessionErrorCodes.SessionCreationPending, error.ErrorCode);
        Assert.False(persisted);
    }

    [Fact]
    public async Task RecoveryLookupTransportFailureIsStillPendingRatherThanDefiniteFailure()
    {
        using var response = new HttpResponseMessage(System.Net.HttpStatusCode.BadGateway)
        {
            Content = new StringContent("<html>gateway unavailable</html>")
        };
        var error = await Assert.ThrowsAnyAsync<InfraAgentSessionException>(() =>
            InfraAgentSessionService.ProcessCdsCreateResponseAsync(response,
                (_, _) => throw new InvalidOperationException("must not persist"),
                recoverAsync: _ => throw new HttpRequestException("connection interrupted")));
        Assert.Equal(InfraAgentSessionErrorCodes.SessionCreationPending, error.ErrorCode);
    }

    [Fact]
    public async Task RecoveredDurableFailureRetainsIdentityAndSanitizedReasonBeforeThrowing()
    {
        using var response = new HttpResponseMessage(System.Net.HttpStatusCode.Accepted)
        {
            Content = new StringContent("""{"item":{"id":"reservation-1","status":"creating"}}""")
        };
        string? identity = null;
        var error = await Assert.ThrowsAnyAsync<InfraAgentSessionException>(() =>
            InfraAgentSessionService.ProcessCdsCreateResponseAsync(response,
                (item, _) =>
                {
                    Assert.False(item.Succeeded);
                    identity = item.Item!.Value.GetProperty("id").GetString();
                    return Task.CompletedTask;
                },
                recoverAsync: _ => Task.FromResult<System.Text.Json.JsonElement?>(System.Text.Json.JsonSerializer.SerializeToElement(
                    new { id = "reservation-1", status = "failed", creationFailure = new { message = "启动失败 token=private-value" } }))));
        Assert.Equal("reservation-1", identity);
        Assert.Equal(InfraAgentSessionErrorCodes.CdsRequestFailed, error.ErrorCode);
        Assert.Contains("启动失败", error.Message);
        Assert.DoesNotContain("private-value", error.Message);
    }

    [Theory]
    [InlineData("stopped")]
    [InlineData("stopping")]
    public async Task RecoveredStoppedAttemptDoesNotBecomePendingOrDispatchable(string status)
    {
        using var response = new HttpResponseMessage(System.Net.HttpStatusCode.Accepted)
        {
            Content = new StringContent("""{"item":{"id":"reservation-1","status":"creating"}}""")
        };
        var error = await Assert.ThrowsAnyAsync<InfraAgentSessionException>(() =>
            InfraAgentSessionService.ProcessCdsCreateResponseAsync(response,
                (_, _) => throw new InvalidOperationException("must not persist"),
                recoverAsync: _ => Task.FromResult<System.Text.Json.JsonElement?>(System.Text.Json.JsonSerializer.SerializeToElement(
                    new { id = "reservation-1", status }))));
        Assert.Equal(InfraAgentSessionErrorCodes.CdsRequestFailed, error.ErrorCode);
    }

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
    public async Task AcceptedCreateReplayIsPendingAndNeverPersistsProvisionalIdentity()
    {
        using var response = new HttpResponseMessage(System.Net.HttpStatusCode.Accepted)
        {
            Content = new StringContent("""
                {
                  "item": {
                    "id": "cds-agent-reservation",
                    "clientRequestId": "start-stable",
                    "status": "creating"
                  }
                }
                """)
        };
        var persistCalls = 0;

        var error = await Assert.ThrowsAnyAsync<InfraAgentSessionException>(() =>
            InfraAgentSessionService.ProcessCdsCreateResponseAsync(
                response,
                (_, _) =>
                {
                    persistCalls++;
                    return Task.CompletedTask;
                },
                TimeSpan.FromSeconds(1)));

        Assert.Equal(0, persistCalls);
        Assert.Equal(InfraAgentSessionErrorCodes.SessionCreationPending, error.ErrorCode);
        Assert.Equal(503, error.HttpStatus);
        Assert.Contains("仍在创建中", error.Message);
        Assert.Contains("同一请求标识", error.Message);
    }

    [Theory]
    [InlineData("creating", "Pending")]
    [InlineData("queued", "Pending")]
    [InlineData("running", "Ready")]
    [InlineData("idle", "Ready")]
    [InlineData("failed", "Failed")]
    [InlineData("stopped", "Invalid")]
    [InlineData(null, "Invalid")]
    public void CreateReplayOnlyTreatsDispatchableOrFailedStatesAsTerminal(
        string? status,
        string expected)
    {
        Assert.Equal(
            expected,
            InfraAgentSessionService.ClassifyCdsCreateReplayStatus(status).ToString());
    }

    [Fact]
    public void StableAttemptBypassesFreshLeaseSoStartCanRecoverAcceptedReplay()
    {
        var now = new DateTime(2026, 9, 7, 0, 0, 0, DateTimeKind.Utc);

        Assert.False(InfraAgentSessionService.ShouldWaitForExistingStartLease(
            InfraAgentSessionStatuses.Creating,
            cdsSessionId: null,
            startAttemptId: "start-stable",
            updatedAt: now.AddSeconds(-1),
            now));
        Assert.True(InfraAgentSessionService.ShouldWaitForExistingStartLease(
            InfraAgentSessionStatuses.Creating,
            cdsSessionId: null,
            startAttemptId: null,
            updatedAt: now.AddSeconds(-1),
            now));
    }

    [Theory]
    [InlineData(InfraAgentSessionStatuses.Failed, "cds-residual", 409)]
    [InlineData(InfraAgentSessionStatuses.Stopped, "cds-stopped", 409)]
    [InlineData(InfraAgentSessionStatuses.Stopping, "cds-stopping", 409)]
    [InlineData(InfraAgentSessionStatuses.Creating, null, 503)]
    [InlineData(InfraAgentSessionStatuses.Creating, "cds-provisional", 503)]
    [InlineData(InfraAgentSessionStatuses.Running, null, 409)]
    public void NonDispatchableSessionCannotCreateCompletedUserMessage(
        string status,
        string? cdsSessionId,
        int expectedHttpStatus)
    {
        var now = new DateTime(2026, 9, 7, 0, 0, 0, DateTimeKind.Utc);

        var error = Assert.ThrowsAny<InfraAgentSessionException>(() =>
            InfraAgentSessionService.PrepareOutboundUserMessage(
                status,
                cdsSessionId,
                "map-session",
                "never completed",
                now));

        Assert.Equal(expectedHttpStatus, error.HttpStatus);
    }

    [Theory]
    [InlineData(InfraAgentSessionStatuses.Running)]
    [InlineData(InfraAgentSessionStatuses.Idle)]
    public void DispatchableUserMessageStartsNonTerminalUntilCdsAcknowledges(string status)
    {
        var now = new DateTime(2026, 9, 7, 0, 0, 0, DateTimeKind.Utc);

        var message = InfraAgentSessionService.PrepareOutboundUserMessage(
            status,
            "cds-ready",
            "map-session",
            "send me",
            now);

        Assert.Equal(InfraAgentMessageStatuses.Streaming, message.Status);
        Assert.NotEqual(InfraAgentMessageStatuses.Completed, message.Status);
        Assert.Equal("map-session", message.SessionId);
        Assert.Equal("send me", message.Content);
    }

    [Theory]
    [InlineData(InfraAgentSessionStatuses.Creating, "cds-creating", true)]
    [InlineData(InfraAgentSessionStatuses.Running, "cds-running", true)]
    [InlineData(InfraAgentSessionStatuses.Idle, "cds-idle", true)]
    [InlineData(InfraAgentSessionStatuses.Running, null, false)]
    [InlineData(InfraAgentSessionStatuses.Failed, "cds-residual", false)]
    [InlineData(InfraAgentSessionStatuses.Stopped, "cds-stopped", false)]
    [InlineData(InfraAgentSessionStatuses.Stopping, "cds-stopping", false)]
    public void PersistedEventPollingRecoversOnlyActiveRemoteSessions(
        string status,
        string? cdsSessionId,
        bool expected)
    {
        Assert.Equal(
            expected,
            InfraAgentSessionService.ShouldRecoverPersistedCdsEvents(status, cdsSessionId));
    }

    [Fact]
    public async Task EnqueueFailureAfterRemoteAcceptanceIsBestEffortAndUsesDetachedToken()
    {
        CancellationToken observedToken = new(canceled: true);
        Exception? logged = null;

        var enqueued = await InfraAgentSessionService.RunBestEffortRuntimeEnqueueAsync(
            token =>
            {
                observedToken = token;
                throw new InvalidOperationException("queue unavailable");
            },
            ex => logged = ex);

        Assert.False(enqueued);
        Assert.Equal(CancellationToken.None, observedToken);
        Assert.IsType<InvalidOperationException>(logged);
    }

    [Fact]
    public async Task SuccessfulBestEffortEnqueueRemainsAnAccelerationOnly()
    {
        var calls = 0;

        var enqueued = await InfraAgentSessionService.RunBestEffortRuntimeEnqueueAsync(
            token =>
            {
                Assert.Equal(CancellationToken.None, token);
                calls++;
                return ValueTask.CompletedTask;
            },
            _ => throw new Xunit.Sdk.XunitException("failure logger should not run"));

        Assert.True(enqueued);
        Assert.Equal(1, calls);
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

        var semantic = InfraAgentSessionService.BuildCdsRequestFailureMessage(
            400,
            """{"error":{"code":"invalid_request","message":"invalid payload"}}""");
        Assert.Contains("HTTP 400", semantic);
        Assert.Contains("[invalid_request]", semantic);
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

    [Theory]
    [InlineData(200, "{}", "Success")]
    [InlineData(404, "{\"error\":{\"code\":\"session_not_found\"}}", "AlreadyStopped")]
    [InlineData(400, "upstream rejected before routing", "Failure")]
    [InlineData(400, "{\"error\":{\"code\":\"workspace_cleanup_failed\"}}", "Retry")]
    [InlineData(400, "{\"error\":{\"code\":\"invalid_request\"}}", "Failure")]
    [InlineData(502, "{\"error\":{\"code\":\"workspace_cleanup_failed\"}}", "Retry")]
    [InlineData(502, "{\"error\":{\"code\":\"unauthorized\"}}", "Failure")]
    [InlineData(503, "{}", "Retry")]
    [InlineData(401, "{\"error\":{\"code\":\"unauthorized\"}}", "Failure")]
    [InlineData(401, "{\"error\":{\"code\":\"workspace_cleanup_failed\"}}", "Failure")]
    [InlineData(403, "{\"error\":{\"code\":\"workspace_cleanup_failed\"}}", "Failure")]
    public void CdsStopResponseClassificationIsBoundedAndFailClosed(
        int statusCode,
        string body,
        string expected)
    {
        Assert.Equal(expected, InfraAgentSessionService.ClassifyCdsStopResponse(statusCode, body).ToString());
    }

    [Theory]
    [InlineData(200, "{\"item\":{\"status\":\"stopped\"}}", "AlreadyStopped")]
    [InlineData(404, "{\"error\":{\"code\":\"session_not_found\"}}", "AlreadyStopped")]
    [InlineData(200, "{\"item\":{\"status\":\"idle\"}}", "Retry")]
    [InlineData(200, "{\"item\":{\"status\":\"stopping\"}}", "Retry")]
    [InlineData(200, "{\"item\":{\"status\":\"failed\"}}", "Retry")]
    [InlineData(503, "{}", "Retry")]
    [InlineData(200, "{\"item\":{\"status\":\"unknown\"}}", "Failure")]
    [InlineData(200, "{}", "Failure")]
    [InlineData(401, "{\"error\":{\"code\":\"unauthorized\"}}", "Failure")]
    public void CdsStopReadbackOnlyConvertsProvenTerminalOrRetryableStates(
        int statusCode,
        string body,
        string expected)
    {
        Assert.Equal(expected, InfraAgentSessionService.ClassifyCdsStopReadback(statusCode, body).ToString());
    }

    [Theory]
    [InlineData(InfraAgentSessionStatuses.Creating, true)]
    [InlineData(InfraAgentSessionStatuses.Running, true)]
    [InlineData(InfraAgentSessionStatuses.Idle, true)]
    [InlineData(InfraAgentSessionStatuses.Stopping, false)]
    [InlineData(InfraAgentSessionStatuses.Stopped, false)]
    [InlineData(InfraAgentSessionStatuses.Failed, false)]
    public void LateRuntimeProjectionCannotRegressTerminalStopState(string currentStatus, bool expected)
    {
        Assert.Equal(expected, InfraAgentSessionService.CanApplyCdsRuntimeStatus(currentStatus));
    }

    [Theory]
    [InlineData(InfraAgentSessionStatuses.Stopped, -600, false)]
    [InlineData(InfraAgentSessionStatuses.Stopping, 30, false)]
    [InlineData(InfraAgentSessionStatuses.Stopping, -1, true)]
    [InlineData(InfraAgentSessionStatuses.Failed, 120, true)]
    [InlineData(InfraAgentSessionStatuses.Idle, 120, true)]
    public void StopLeaseCanBeReclaimedOnlyAfterDedicatedExpiry(string status, int expiryOffsetSeconds, bool expected)
    {
        var now = new DateTime(2026, 9, 7, 0, 0, 0, DateTimeKind.Utc);

        Assert.Equal(
            expected,
            InfraAgentSessionService.CanAcquireCdsStopLease(status, now.AddSeconds(expiryOffsetSeconds), now));
    }

    [Theory]
    [InlineData(InfraAgentSessionStatuses.Idle, null, true, true)]
    [InlineData(InfraAgentSessionStatuses.Stopping, null, true, true)]
    [InlineData(InfraAgentSessionStatuses.Idle, "message-active", true, false)]
    [InlineData(InfraAgentSessionStatuses.Running, null, true, true)]
    [InlineData(InfraAgentSessionStatuses.Idle, null, false, false)]
    [InlineData(InfraAgentSessionStatuses.Failed, null, true, true)]
    [InlineData(InfraAgentSessionStatuses.Failed, null, false, false)]
    public void OnlyPersistedCompletedCleanupDefersStopFailureProjection(
        string status,
        string? activeMessageId,
        bool cleanupRequested,
        bool expected)
    {
        Assert.Equal(
            expected,
            InfraAgentSessionService.ShouldDeferScheduledCleanupFailure(
                status,
                activeMessageId,
                cleanupRequested ? DateTime.UtcNow : null));
    }

    [Theory]
    [InlineData(1, 5)]
    [InlineData(2, 10)]
    [InlineData(3, 20)]
    [InlineData(6, 160)]
    [InlineData(7, 300)]
    [InlineData(20, 300)]
    public void PersistedCleanupRetryUsesBoundedExponentialBackoff(int attempt, int expectedSeconds)
    {
        Assert.Equal(
            TimeSpan.FromSeconds(expectedSeconds),
            InfraAgentSessionService.CalculateCleanupRetryDelay(attempt));
    }

    [Fact]
    public void StaleReplicaCannotPiercePersistedCleanupBackoff()
    {
        var scanAt = new DateTime(2026, 9, 7, 0, 0, 0, DateTimeKind.Utc);
        var requestedAt = scanAt.AddMinutes(-1);
        var selected = new InfraAgentSession
        {
            CdsSessionId = "cds-a",
            CleanupRequestedAt = requestedAt,
            CleanupCdsSessionId = "cds-a",
            CleanupMessageId = "message-a",
            CleanupAttemptCount = 0,
            CleanupNextAttemptAt = scanAt.AddSeconds(-1),
        };
        var retriedByAnotherReplica = new InfraAgentSession
        {
            CdsSessionId = "cds-a",
            CleanupRequestedAt = requestedAt,
            CleanupCdsSessionId = "cds-a",
            CleanupMessageId = "message-a",
            CleanupAttemptCount = 1,
            CleanupNextAttemptAt = scanAt.AddSeconds(5),
        };

        Assert.True(InfraAgentSessionService.CanClaimScheduledCleanup(selected, selected, scanAt));
        Assert.False(InfraAgentSessionService.CanClaimScheduledCleanup(
            retriedByAnotherReplica,
            selected,
            scanAt));
    }

    [Fact]
    public void LegacyStoppingRowsWithoutDedicatedLeaseAreRecoverable()
    {
        var now = new DateTime(2026, 9, 7, 0, 0, 0, DateTimeKind.Utc);

        Assert.True(InfraAgentSessionService.CanAcquireCdsStopLease(
            InfraAgentSessionStatuses.Stopping,
            leaseExpiresAt: null,
            now));
    }

    [Theory]
    [InlineData(InfraAgentSessionStatuses.Stopped, null, null, 0, false, true)]
    [InlineData(InfraAgentSessionStatuses.Stopped, null, "start-old", 0, true, false)]
    [InlineData(InfraAgentSessionStatuses.Stopped, null, null, 1, true, false)]
    [InlineData(InfraAgentSessionStatuses.Failed, "cds-old", null, 0, true, false)]
    [InlineData(InfraAgentSessionStatuses.Failed, null, null, 1, true, false)]
    [InlineData(InfraAgentSessionStatuses.Idle, null, null, 1, true, false)]
    [InlineData(InfraAgentSessionStatuses.Running, "cds-live", null, 1, false, false)]
    public void PendingCleanupLedgerBlocksRestartAndCleanStoppedFastPath(
        string status,
        string? cdsSessionId,
        string? startAttemptId,
        int pendingCount,
        bool cleanupBeforeStart,
        bool cleanStopped)
    {
        Assert.Equal(
            cleanupBeforeStart,
            InfraAgentSessionService.RequiresCdsCleanupBeforeStart(
                status,
                cdsSessionId,
                startAttemptId,
                pendingCount));
        Assert.Equal(
            cleanStopped,
            InfraAgentSessionService.CanReturnStoppedWithoutCleanup(
                status,
                startAttemptId,
                pendingCount));
    }
}
