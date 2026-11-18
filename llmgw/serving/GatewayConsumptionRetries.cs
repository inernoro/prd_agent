using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.LlmGateway;

namespace PrdAgent.LlmGatewayHost;

internal static class GatewayConsumptionRetries
{
    internal const string Path = "/gw/v1/consumption-retries";
    internal const string ControlScope = "retry:control";
    internal const string OptInHeader = "X-Gateway-Retry-Run-Id";

    internal static string? ReadRunId(HttpContext http, GatewayKeyAuthorization authorization, string? protocol)
    {
        if (!IsScopedKey(authorization) || protocol != "openai-compatible") return null;
        if (!http.Request.Headers.TryGetValue(OptInHeader, out var values) || values.Count != 1) return null;
        var runId = values[0];
        return runId is { Length: > 0 and <= 160 }
            && runId.All(value => char.IsAsciiLetterOrDigit(value) || value is '-' or '_' or '.' or ':')
            ? runId : null;
    }

    internal static void MapGatewayConsumptionRetries(this WebApplication app)
    {
        app.MapGet(Path, async (HttpContext http) =>
        {
            if (GetWorker(http) is not { } worker) return Results.StatusCode(StatusCodes.Status403Forbidden);
            var items = await GetStore(http).ReadReadyAsync(worker, http.RequestAborted);
            return Results.Ok(new { items });
        });

        app.MapPost(Path, async (HttpContext http, GatewayConsumptionRetryReceipt body) =>
        {
            if (GetWorker(http) is not { } worker) return Results.StatusCode(StatusCodes.Status403Forbidden);
            if (body.Id is not { Length: > 0 and <= 512 } || !Guid.TryParseExact(body.ClaimId, "N", out _)
                || body.Outcome is not ("claim" or "completed" or "failed")
                || body.CompletedCount < 0 || (body.Outcome == "completed" && body.CompletedCount is null))
                return Results.BadRequest(new { error = new { code = "RETRY_RECEIPT_INVALID", message = "补跑回执不完整，请核对实际结果后再提交。" } });

            if (await GetStore(http).ApplyReceiptAsync(worker, body.Id, body.ClaimId!, body.Outcome,
                    body.CompletedCount, http.RequestAborted))
                return Results.Ok();
            return Results.NotFound(new { error = new { code = "RETRY_NOT_PENDING", message = "补跑任务已过期或已有其他处理结果，请重新读取任务列表。" } });
        });
    }

    private static GatewayConsumptionRetryOwner? GetWorker(HttpContext http)
    {
        var authorization = http.Items["llmgw.key.authorization"] as GatewayKeyAuthorization;
        if (authorization is null || !IsScopedKey(authorization)
            || authorization.ResolvedAppCallerCode is not { Length: > 0 } caller)
            return null;

        return new(authorization.TenantId, authorization.KeyId, caller);
    }

    private static bool IsScopedKey(GatewayKeyAuthorization authorization) =>
        authorization is { Allowed: true, Authenticated: true, LegacySharedKey: false, RuntimeGrant: null, KeyId.Length: > 0, TenantId.Length: > 0 };

    private static GatewayConsumptionRetryStore GetStore(HttpContext http) =>
        new(http.RequestServices.GetRequiredService<LlmGatewayDataContext>().Database);
}

internal sealed record GatewayConsumptionRetryReceipt(string? Id, string? ClaimId, string? Outcome, int? CompletedCount);
