using System.Diagnostics;
using System.Reflection;
using System.Text.Json;
using PrdAgent.Core.Diagnostics;
using PrdAgent.Core.Models;

namespace PrdAgent.Api.Services;

public sealed class CdsSsoAuditHandler(
    IMiduoPlanetSsoAuditWriter auditWriter, IHttpContextAccessor contexts, CdsSsoSettings settings, IConfiguration config)
    : DelegatingHandler
{
    public const int MaxResponseBytes = 64 * 1024;
    public static readonly TimeSpan RequestTimeout = TimeSpan.FromSeconds(5);
    private static readonly string? BuildCommit = BuildIdentity.ParseBakedCommit(typeof(CdsSsoAuditHandler).Assembly
        .GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion);
    private static readonly string[] ProtocolFields =
    [
        "issuer", "authorization_endpoint", "token_endpoint", "userinfo_endpoint", "jwks_uri", "keys",
        "access_token", "id_token", "expires_in", "token_type", "scope", "sub", "error", "error_description"
    ];
    private static readonly HashSet<string> ErrorCodes = new(StringComparer.Ordinal)
    {
        "invalid_request", "invalid_client", "invalid_grant", "unauthorized_client", "unsupported_grant_type",
        "invalid_scope", "invalid_token", "insufficient_scope", "access_denied", "server_error", "temporarily_unavailable"
    };

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
    {
        var context = contexts.HttpContext;
        var requestId = context?.Items["RequestId"]?.ToString() ?? context?.TraceIdentifier ?? Activity.Current?.Id ?? Guid.NewGuid().ToString("N");
        var uri = request.RequestUri!;
        var audit = new ApiRequestLog
        {
            Id = Guid.NewGuid().ToString("N"), RequestId = requestId, StartedAt = DateTime.UtcNow,
            Method = request.Method.Method, Path = uri.AbsolutePath, Protocol = uri.Scheme,
            AbsoluteUrl = MiduoPlanetSsoAudit.SafeUrl(uri.AbsoluteUri), TargetHost = uri.Host,
            Direction = "outbound", Status = "running", AppName = "system", AppId = "cds-sso", ClientType = "server",
            RequestBody = JsonSerializer.Serialize(new
            {
                operation = "cds.oidc", parentRequestId = requestId, clientId = settings.ClientId,
                issuer = settings.Issuer?.AbsoluteUri, callbackOrigin = settings.RedirectUri?.GetLeftPart(UriPartial.Authority),
                deployment = config["CDS_BRANCH_ID"], project = config["CDS_PROJECT_ID"], instance = Environment.MachineName,
                build = BuildCommit,
                timeoutMs = RequestTimeout.TotalMilliseconds, maxCaptureBytes = MaxResponseBytes,
            })
        };

        // Reserve an audit record before consuming a one-use authorization code.
        var consumesCode = request.Method == HttpMethod.Post;
        if (consumesCode && !await auditWriter.BeginAsync(audit)) throw AuditUnavailable();

        var started = Stopwatch.StartNew();
        HttpResponseMessage? response = null;
        var stage = "sending";
        string? upstreamError = null;
        object? snapshot = null;
        long? declaredBytes = null;
        try
        {
            response = await base.SendAsync(request, ct);
            audit.StatusCode = (int)response.StatusCode;
            audit.ResponseContentType = response.Content.Headers.ContentType?.MediaType;
            declaredBytes = response.Content.Headers.ContentLength;
            stage = "reading_response";

            using var stream = await response.Content.ReadAsStreamAsync(ct);
            var capture = new byte[MaxResponseBytes + 1];
            var count = 0;
            while (count < capture.Length)
            {
                var got = await stream.ReadAsync(capture.AsMemory(count), ct);
                if (got == 0) break;
                count += got;
                audit.ResponseBodyBytes = Math.Min(count, MaxResponseBytes);
            }

            audit.ResponseBodyTruncated = count > MaxResponseBytes;
            if (audit.ResponseBodyTruncated) throw new HttpRequestException("CDS OIDC response exceeded its size limit.");

            var body = capture.AsMemory(0, count);
            snapshot = Describe(body, out upstreamError);
            stage = response.IsSuccessStatusCode && upstreamError is null ? "received" : "upstream_denied";

            // Give the caller the same response after saving the audit evidence.
            var buffered = new ByteArrayContent(capture, 0, count);
            foreach (var header in response.Content.Headers) buffered.Headers.TryAddWithoutValidation(header.Key, header.Value);
            response.Content.Dispose();
            response.Content = buffered;
            return response;
        }
        catch (Exception ex)
        {
            stage = audit.ResponseBodyTruncated ? "response_too_large" : ex is OperationCanceledException ? "cancelled_or_timed_out"
                : ex is JsonException ? "invalid_json" : response is null ? "no_response" : "response_read_failed";
            response?.Dispose();
            throw;
        }
        finally
        {
            audit.EndedAt = DateTime.UtcNow;
            audit.DurationMs = started.ElapsedMilliseconds;
            audit.Status = stage == "received" ? "completed" : "failed";
            audit.ErrorCode = upstreamError ?? (stage == "received" ? null : stage);
            audit.ResponseBody = JsonSerializer.Serialize(new
            {
                stage, responseReceived = response is not null, upstreamError,
                responseBytes = audit.ResponseBodyBytes, declaredBytes, truncated = audit.ResponseBodyTruncated,
                omissionReason = snapshot is null ? stage : null,
                upstreamResponse = snapshot,
            });
            var recorded = consumesCode ? await auditWriter.CompleteAsync(audit) : await auditWriter.BeginAsync(audit);
            if (!recorded && stage is "received" or "upstream_denied")
            {
                response?.Dispose();
                throw AuditUnavailable();
            }
        }
    }

    private static object Describe(ReadOnlyMemory<byte> body, out string? error)
    {
        using var parsed = JsonDocument.Parse(body);
        var payload = parsed.RootElement;
        if (payload.ValueKind != JsonValueKind.Object) throw new JsonException("Expected a CDS OIDC response object.");
        error = payload.TryGetProperty("error", out var code) && code.ValueKind == JsonValueKind.String
            ? ErrorCodes.Contains(code.GetString()!) ? code.GetString() : "unknown_upstream_error" : null;

        // CDS responses can carry tokens and identity attributes. Keep only the recognized fields' shapes,
        // safe protocol values and limits. The response text and unrecognized fields stay outside the audit log.
        var fields = ProtocolFields.ToDictionary(name => name, name => DescribeField(payload, name));
        return new
        {
            fields, omitted = "credentials, identities, descriptions and unrecognized fields",
            bearer = payload.TryGetProperty("token_type", out var type) && type.ValueKind == JsonValueKind.String && type.GetString() == "Bearer",
            lifetimeSeconds = payload.TryGetProperty("expires_in", out var ttl) && ttl.ValueKind == JsonValueKind.Number
                && ttl.TryGetInt32(out var seconds) ? (int?)seconds : null,
        };
    }

    private static object DescribeField(JsonElement payload, string name)
    {
        if (!payload.TryGetProperty(name, out var field)) return new { state = "missing" };
        if (field.ValueKind == JsonValueKind.Null) return new { state = "null" };
        if (field.ValueKind != JsonValueKind.String)
            return new { state = "present", type = field.ValueKind.ToString() };

        var value = field.GetString()!;
        var state = value.Length == 0 ? "empty" : string.IsNullOrWhiteSpace(value) ? "whitespace" : "present";
        return new { state, type = "string", length = value.Length };
    }

    private static HttpRequestException AuditUnavailable() => new("CDS OIDC audit persistence was unavailable.");
}
