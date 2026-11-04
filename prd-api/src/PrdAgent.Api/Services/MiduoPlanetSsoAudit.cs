using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Services;

public interface IMiduoPlanetSsoAuditWriter
{
    Task<bool> BeginAsync(ApiRequestLog log);
    Task<bool> CompleteAsync(ApiRequestLog log);
}

public sealed class MiduoPlanetSsoAuditWriter(MongoDbContext db, ILogger<MiduoPlanetSsoAuditWriter> logger)
    : IMiduoPlanetSsoAuditWriter
{
    public Task<bool> BeginAsync(ApiRequestLog log) => PersistAsync(log, true);
    public Task<bool> CompleteAsync(ApiRequestLog log) => PersistAsync(log, false);

    private async Task<bool> PersistAsync(ApiRequestLog log, bool insert)
    {
        // 审计不能随浏览器断开而取消；独立限定日志存储等待，且写失败不能静默吞掉。
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        try
        {
            if (insert) await db.ApiRequestLogs.InsertOneAsync(log, cancellationToken: deadline.Token);
            else
            {
                var result = await db.ApiRequestLogs.ReplaceOneAsync(x => x.Id == log.Id, log, cancellationToken: deadline.Token);
                if (result.MatchedCount != 1) throw new InvalidOperationException("Audit record missing");
            }
            return true;
        }
        catch (Exception ex)
        {
            logger.LogError("SSO audit persistence failed. auditId={AuditId}, requestId={RequestId}, stage={Stage}, errorType={ErrorType}",
                log.Id, log.RequestId, insert ? "begin" : "complete", ex.GetType().Name);
            return false;
        }
    }
}

/// <summary>只生成脱敏证据，不重新解析配置、不发送请求、不改变登录判定。</summary>
public static class MiduoPlanetSsoAudit
{
    public const int MaxCaptureBytes = 1024 * 1024;
    private const int MaxSnapshotChars = 64 * 1024;
    private static readonly string[] ProfileFields = ["mobile", "wework_userid", "employeeNo", "userId", "userName", "email"];
    private static readonly HashSet<string> SafeStrings = new(StringComparer.OrdinalIgnoreCase)
        { "message", "return_msg", "return_code", "trace_id", "request_id", "valid" };
    private static readonly Regex CredentialText = new(
        "(?i)(access[_-]?token|refresh[_-]?token|session[_-]?token|token|password|secret|cookie|authorization|signature|api[_-]?key|授权码|密码|密钥)\\s*[\"']?\\s*[:=]\\s*[\"']?[^\\s,;\"'<>]+",
        RegexOptions.CultureInvariant, TimeSpan.FromMilliseconds(100));
    private static readonly Regex PrivateText = new(
        @"(?i)\b(?:Bearer\s+[^\s,;]+|exch_[A-Za-z0-9_-]+|sess_[A-Za-z0-9_-]+|sk-[A-Za-z0-9_-]+|eyJ[A-Za-z0-9_.-]+)|\b\d{7,18}[Xx]?\b|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}",
        RegexOptions.CultureInvariant, TimeSpan.FromMilliseconds(100));
    private static readonly Regex OpaqueText = new(@"\b[A-Za-z0-9_=-]{24,}\b", RegexOptions.CultureInvariant, TimeSpan.FromMilliseconds(100));

    public static string Fingerprint(string value, string secret)
        => Convert.ToHexString(HMACSHA256.HashData(Encoding.UTF8.GetBytes(secret), Encoding.UTF8.GetBytes(value))).ToLowerInvariant();

    public static string SafeUrl(string value)
    {
        if (!Uri.TryCreate(value, UriKind.Absolute, out var uri)) return "invalid-url";
        return $"{uri.Scheme}://{uri.Host}{(uri.IsDefaultPort ? "" : $":{uri.Port}")}{uri.AbsolutePath}";
    }

    public static string SafeText(string value, IEnumerable<string> secrets, bool preserveTraceId = false)
    {
        var text = value;
        // 非 JSON 错误页也可能转义凭据；先还原常见编码，再执行同一脱敏边界。
        text = System.Net.WebUtility.HtmlDecode(text);
        text = Regex.Replace(text, @"\\u([0-9a-fA-F]{4})", m => ((char)Convert.ToInt32(m.Groups[1].Value, 16)).ToString());
        foreach (var secret in secrets.Where(x => !string.IsNullOrEmpty(x)).Distinct().OrderByDescending(x => x.Length))
            text = text.Replace(secret, "[REDACTED]", StringComparison.Ordinal);
        try
        {
            text = CredentialText.Replace(text, "$1=[REDACTED]");
            text = PrivateText.Replace(text, "[REDACTED]");
            if (!preserveTraceId) text = OpaqueText.Replace(text, "[REDACTED]");
            return text.Length <= 2048 ? text : text[..2048] + "[TRUNCATED]";
        }
        catch (RegexMatchTimeoutException) { return "[REDACTED: sanitization timeout]"; }
    }

    public static JsonObject DescribeField(JsonElement root, string name, string subjectType, string secret)
    {
        if (root.ValueKind != JsonValueKind.Object || !root.TryGetProperty("return_data", out var data)
            || data.ValueKind != JsonValueKind.Object || !data.TryGetProperty(name, out var field))
            return new JsonObject { ["state"] = "missing", ["present"] = false };
        var result = new JsonObject { ["present"] = true, ["valueKind"] = field.ValueKind.ToString() };
        if (field.ValueKind == JsonValueKind.Null) { result["state"] = "null"; return result; }
        if (field.ValueKind is not (JsonValueKind.String or JsonValueKind.Number)) { result["state"] = "wrong_type"; return result; }
        var raw = field.ValueKind == JsonValueKind.String ? field.GetString()! : field.GetRawText();
        var trimmed = raw.Trim();
        result["rawLength"] = raw.Length;
        result["trimmedLength"] = trimmed.Length;
        result["valueFingerprint"] = Fingerprint($"field:{name}:{raw}", secret);
        result["state"] = raw.Length == 0 ? "empty" : trimmed.Length == 0 ? "whitespace" : "present";
        if (name == "mobile")
        {
            var digits = new string(trimmed.Where(char.IsDigit).ToArray());
            result["normalizedLength"] = digits.Length;
            result["containsMask"] = trimmed.Contains('*');
            result["containsLetters"] = trimmed.Any(char.IsLetter);
            result["digitsOnly"] = trimmed.Length > 0 && trimmed.All(char.IsDigit);
            result["format"] = trimmed.Length == 0 ? "empty" : digits.Length == 0 ? "no_digits" : digits.Length == 11 ? "11_digits" : "unexpected_digit_count";
            if (trimmed.Length > 0 && digits.Length == 0 && subjectType == "mobile") result["state"] = "no_digits";
        }
        return result;
    }

    public static string BuildResponse(string? raw, string stage, string? errorCode, string subjectType,
        string secret, string token, bool truncated, int capturedBytes, long? declaredBytes, HttpResponseMessage? response)
    {
        var secrets = new List<string> { secret, token };
        JsonElement? root = null;
        string? parseError = null;
        if (raw != null)
        {
            try
            {
                using var doc = JsonDocument.Parse(raw);
                root = doc.RootElement.Clone();
                CollectSecrets(root.Value, secrets);
            }
            catch (JsonException ex) { parseError = ex.GetType().Name; }
        }
        var fields = new JsonObject();
        foreach (var name in ProfileFields) fields[name] = root.HasValue
            ? DescribeField(root.Value, name, subjectType, secret)
            : new JsonObject { ["state"] = "unavailable", ["present"] = false };
        var nodes = 0;
        var snapshot = root.HasValue ? Redact(root.Value, "", secrets, secret, ref nodes, 0)
            : raw == null ? null : new JsonObject { ["nonJsonPreview"] = SafeText(raw, secrets), ["format"] = "unparseable" };
        var snapshotTruncated = nodes > 2000;
        if (snapshot?.ToJsonString().Length > MaxSnapshotChars)
        {
            snapshot = new JsonObject { ["safePreview"] = snapshot.ToJsonString()[..MaxSnapshotChars], ["reason"] = "snapshot_size_limit" };
            snapshotTruncated = true;
        }
        var headers = new JsonObject();
        if (response != null)
        {
            foreach (var key in new[] { "Date", "Content-Type", "Content-Length", "Retry-After", "X-Request-ID", "X-Correlation-ID", "traceparent" })
            {
                var values = response.Headers.TryGetValues(key, out var h) ? h
                    : response.Content.Headers.TryGetValues(key, out h) ? h : null;
                if (values != null) headers[key] = SafeText(string.Join(",", values), secrets, key is "X-Request-ID" or "X-Correlation-ID" or "traceparent");
            }
        }
        return new JsonObject
        {
            ["auditVersion"] = 1, ["stage"] = stage, ["responseReceived"] = response != null,
            ["parseSucceeded"] = root.HasValue, ["parseError"] = parseError, ["localErrorCode"] = errorCode,
            ["selectedSubjectType"] = subjectType, ["selectedFieldState"] = (fields[subjectType] as JsonObject)?["state"]?.GetValue<string>(),
            ["fieldDiagnostics"] = fields, ["upstreamResponse"] = snapshot, ["safeResponseHeaders"] = headers,
            ["capturedBytes"] = capturedBytes, ["declaredBytes"] = declaredBytes,
            ["captureTruncated"] = truncated, ["snapshotTruncated"] = snapshotTruncated,
            ["truncationReason"] = truncated ? stage == "response_too_large" ? "response_capture_limit" : "response_read_incomplete"
                : snapshotTruncated ? "snapshot_limit" : null,
            ["bodyFingerprint"] = raw == null ? null : Fingerprint("body:" + raw, secret),
            ["fingerprintScope"] = raw == null ? null : truncated ? "captured_prefix" : "complete_body"
        }.ToJsonString();
    }

    private static bool Sensitive(string key)
    {
        var k = new string(key.Where(char.IsLetterOrDigit).Select(char.ToLowerInvariant).ToArray());
        if (k is "tokenconsumedat" or "sessionexpiresat") return false;
        return new[] { "token", "secret", "password", "cookie", "authorization", "signature", "credential", "apikey",
            "mobile", "phone", "email", "userid", "username", "displayname", "employeeno", "weworkuserid", "idcard" }.Any(k.Contains)
            || k is "code" or "otp" or "pin" or "mobile" or "phone" or "email" or "userid" or "username"
                or "displayname" or "employeeno" or "weworkuserid" or "idcard";
    }

    private static void CollectSecrets(JsonElement value, List<string> secrets)
    {
        if (value.ValueKind == JsonValueKind.Object)
            foreach (var prop in value.EnumerateObject())
            {
                if (Sensitive(prop.Name) && prop.Value.ValueKind == JsonValueKind.String && !string.IsNullOrEmpty(prop.Value.GetString()))
                    secrets.Add(prop.Value.GetString()!);
                CollectSecrets(prop.Value, secrets);
            }
        else if (value.ValueKind == JsonValueKind.Array)
            foreach (var item in value.EnumerateArray()) CollectSecrets(item, secrets);
    }

    private static JsonNode? Redact(JsonElement value, string key, List<string> secrets, string secret, ref int nodes, int depth)
    {
        if (depth > 32) nodes = 2001;
        if (++nodes > 2000) return JsonValue.Create("[TRUNCATED: structure limit]");
        if (Sensitive(key)) return JsonValue.Create("[REDACTED]");
        if (value.ValueKind == JsonValueKind.Object)
        {
            var result = new JsonObject();
            foreach (var prop in value.EnumerateObject())
            {
                result[SafeText(prop.Name, secrets, true)] = Redact(prop.Value, prop.Name, secrets, secret, ref nodes, depth + 1);
                if (nodes > 2000) break;
            }
            return result;
        }
        if (value.ValueKind == JsonValueKind.Array)
        {
            var result = new JsonArray();
            foreach (var item in value.EnumerateArray())
            {
                result.Add(Redact(item, key, secrets, secret, ref nodes, depth + 1));
                if (nodes > 2000) break;
            }
            return result;
        }
        if (value.ValueKind == JsonValueKind.String)
        {
            var text = value.GetString()!;
            return SafeStrings.Contains(key) ? JsonValue.Create(SafeText(text, secrets, key.EndsWith("_id", StringComparison.Ordinal)))
                : new JsonObject { ["redacted"] = true, ["valueKind"] = "String", ["length"] = text.Length, ["fingerprint"] = Fingerprint("value:" + text, secret) };
        }
        // 新增或未知数字字段也可能是手机/员工编号，保留类型和指纹，业务码才保留原值。
        if (value.ValueKind == JsonValueKind.Number && !key.Equals("return_code", StringComparison.OrdinalIgnoreCase))
            return new JsonObject { ["redacted"] = true, ["valueKind"] = "Number", ["length"] = value.GetRawText().Length,
                ["fingerprint"] = Fingerprint("value:" + value.GetRawText(), secret) };
        return JsonNode.Parse(value.GetRawText());
    }
}
