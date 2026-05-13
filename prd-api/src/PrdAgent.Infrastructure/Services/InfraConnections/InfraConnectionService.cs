using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.WebUtilities;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Infrastructure.Services.InfraConnections;

/// <summary>
/// MAP 端基础设施连接服务实现。
///
/// 安全模型（spec.cds-map-pairing-protocol §5）：
/// - 剪贴板密文只含 pairingToken（10 分钟一次性），不含 longToken
/// - longToken 通过 accept 响应派发，IDataProtector 加密落库
/// - 解密失败的兜底：连接 status 标 revoked，调用方按"凭据失效"处理
/// </summary>
public class InfraConnectionService : IInfraConnectionService
{
    public const string HttpClientName = "infra-connection-handshake";
    private const string ProtectorPurpose = "InfraConnection.LongToken.v1";
    private const string ClipboardPrefixV1 = "cds-connect:v1:";
    private static readonly string[] SupportedVersionPrefixes = { ClipboardPrefixV1 };

    private static readonly JsonSerializerOptions JsonOpts = new(JsonSerializerDefaults.Web)
    {
        PropertyNameCaseInsensitive = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
    };

    private readonly MongoDbContext _db;
    private readonly IDataProtector _protector;
    private readonly IHttpClientFactory _httpClientFactory;
    private readonly IHttpContextAccessor _httpContextAccessor;
    private readonly IConfiguration _configuration;
    private readonly ILogger<InfraConnectionService> _logger;

    public InfraConnectionService(
        MongoDbContext db,
        IDataProtectionProvider protectionProvider,
        IHttpClientFactory httpClientFactory,
        IHttpContextAccessor httpContextAccessor,
        IConfiguration configuration,
        ILogger<InfraConnectionService> logger)
    {
        _db = db;
        _protector = protectionProvider.CreateProtector(ProtectorPurpose);
        _httpClientFactory = httpClientFactory;
        _httpContextAccessor = httpContextAccessor;
        _configuration = configuration;
        _logger = logger;
    }

    public async Task<InfraConnectionPublicView> PasteAsync(
        string clipboardText,
        string userId,
        CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(clipboardText))
        {
            throw new InfraConnectionException(
                InfraConnectionErrorCodes.ClipboardInvalidFormat,
                "剪贴板内容为空");
        }

        var trimmed = clipboardText.Trim();
        var payload = ParseClipboard(trimmed);

        if (payload.ExpiresAt is { } exp && exp < DateTime.UtcNow)
        {
            throw new InfraConnectionException(
                InfraConnectionErrorCodes.PairingTokenExpired,
                "密钥已过期（10 分钟），请回到 CDS 重新生成",
                StatusCodes.Status410Gone);
        }

        if (string.IsNullOrWhiteSpace(payload.PairingToken)
            || string.IsNullOrWhiteSpace(payload.CdsBaseUrl)
            || string.IsNullOrWhiteSpace(payload.CdsId))
        {
            throw new InfraConnectionException(
                InfraConnectionErrorCodes.ClipboardInvalidFormat,
                "密钥缺少必要字段（pairingToken / cdsBaseUrl / cdsId）");
        }

        // 重复连接检查：同 partnerId + active 状态 → 拒绝
        var dup = await _db.InfraConnections
            .Find(c => c.Partner == "cds" && c.PartnerId == payload.CdsId && c.Status == "active")
            .FirstOrDefaultAsync(ct);
        if (dup != null)
        {
            throw new InfraConnectionException(
                InfraConnectionErrorCodes.ConnectionDuplicate,
                $"已有同一 CDS（{dup.PartnerName}）连接，请先删除旧连接",
                StatusCodes.Status409Conflict);
        }

        var mapId = await EnsureMapInstanceIdAsync(ct);
        var mapBaseUrl = ResolveMapBaseUrl();
        var mapName = "prd-agent";

        var acceptResp = await CallCdsAcceptAsync(payload, mapId, mapBaseUrl, mapName, ct);

        var protectedToken = _protector.Protect(acceptResp.CdsLongToken);
        var entity = new InfraConnection
        {
            Id = Guid.NewGuid().ToString("N"),
            Partner = "cds",
            PartnerName = string.IsNullOrWhiteSpace(payload.CdsName) ? payload.CdsId : payload.CdsName!,
            PartnerId = payload.CdsId!,
            PartnerBaseUrl = NormalizeBaseUrl(payload.CdsBaseUrl!),
            LongTokenEncrypted = protectedToken,
            LongTokenExpiresAt = acceptResp.CdsLongTokenExpiresAt ?? DateTime.UtcNow.AddYears(1),
            ProjectId = acceptResp.ProjectId ?? string.Empty,
            InstanceDiscoveryUrl = acceptResp.InstanceDiscoveryUrl ?? string.Empty,
            Scopes = payload.Scopes ?? new List<string>(),
            Status = "active",
            CreatedByUserId = userId,
            CreatedAt = DateTime.UtcNow,
            UpdatedAt = DateTime.UtcNow,
        };

        await _db.InfraConnections.InsertOneAsync(entity, cancellationToken: ct);
        _logger.LogInformation(
            "InfraConnection created id={Id} partner={Partner} partnerId={PartnerId} project={Project}",
            entity.Id, entity.Partner, entity.PartnerId, entity.ProjectId);

        return ToPublicView(entity);
    }

    public async Task<CdsAuthorizationStartView> StartCdsAuthorizationAsync(
        string cdsBaseUrl,
        string mapBaseUrl,
        string userId,
        CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(cdsBaseUrl))
        {
            throw new InfraConnectionException(
                InfraConnectionErrorCodes.CdsBaseUrlInvalid,
                "CDS 地址不能为空");
        }

        var normalized = NormalizeAndValidateHttpBaseUrl(cdsBaseUrl);
        var mapId = await EnsureMapInstanceIdAsync(ct);
        var normalizedMapBaseUrl = string.IsNullOrWhiteSpace(mapBaseUrl)
            ? ResolveMapBaseUrl()
            : NormalizeAndValidateHttpBaseUrl(mapBaseUrl);
        var expiresAt = DateTime.UtcNow.AddMinutes(10);
        var state = EncodeAuthorizationState(new AuthorizationStatePayload
        {
            CdsBaseUrl = normalized,
            MapBaseUrl = normalizedMapBaseUrl,
            MapId = mapId,
            UserId = userId,
            ExpiresAtUnix = new DateTimeOffset(expiresAt).ToUnixTimeSeconds(),
            Nonce = Guid.NewGuid().ToString("N")
        });

        var redirectUri = JoinUrl(normalizedMapBaseUrl, "/infra-services");
        var query = new Dictionary<string, string?>
        {
            ["redirectUri"] = redirectUri,
            ["state"] = state,
            ["mapBaseUrl"] = normalizedMapBaseUrl,
            ["mapId"] = mapId,
            ["mapName"] = "prd-agent"
        };
        var authorizeUrl = QueryHelpers.AddQueryString(
            JoinUrl(normalized, "/api/cds-system/connections/authorize"),
            query);

        return new CdsAuthorizationStartView(authorizeUrl, state, normalized, expiresAt);
    }

    public async Task<InfraConnectionPublicView> CompleteCdsAuthorizationAsync(
        string code,
        string state,
        string userId,
        CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(code))
        {
            throw new InfraConnectionException(
                InfraConnectionErrorCodes.AuthorizationCodeInvalid,
                "授权 code 为空");
        }

        var payload = DecodeAuthorizationState(state);
        if (payload.ExpiresAtUnix < DateTimeOffset.UtcNow.ToUnixTimeSeconds())
        {
            throw new InfraConnectionException(
                InfraConnectionErrorCodes.AuthorizationStateInvalid,
                "授权会话已过期，请重新连接",
                StatusCodes.Status410Gone);
        }
        if (!string.Equals(payload.UserId, userId, StringComparison.Ordinal))
        {
            throw new InfraConnectionException(
                InfraConnectionErrorCodes.AuthorizationStateInvalid,
                "授权会话不属于当前用户，请重新连接",
                StatusCodes.Status403Forbidden);
        }

        var mapId = string.IsNullOrWhiteSpace(payload.MapId)
            ? await EnsureMapInstanceIdAsync(ct)
            : payload.MapId;
        var mapBaseUrl = string.IsNullOrWhiteSpace(payload.MapBaseUrl)
            ? ResolveMapBaseUrl()
            : payload.MapBaseUrl;

        var duplicateByUrl = await _db.InfraConnections
            .Find(c => c.Partner == "cds"
                && c.PartnerBaseUrl == NormalizeBaseUrl(payload.CdsBaseUrl)
                && c.Status == "active")
            .FirstOrDefaultAsync(ct);
        if (duplicateByUrl != null)
        {
            throw new InfraConnectionException(
                InfraConnectionErrorCodes.ConnectionDuplicate,
                $"已有同一 CDS（{duplicateByUrl.PartnerName}）连接，请先删除旧连接",
                StatusCodes.Status409Conflict);
        }

        var tokenResp = await CallCdsTokenAsync(
            payload.CdsBaseUrl,
            code.Trim(),
            mapId,
            mapBaseUrl,
            "prd-agent",
            ct);

        var partnerId = !string.IsNullOrWhiteSpace(tokenResp.CdsId)
            ? tokenResp.CdsId!
            : NormalizeBaseUrl(payload.CdsBaseUrl);
        var partnerName = !string.IsNullOrWhiteSpace(tokenResp.CdsName)
            ? tokenResp.CdsName!
            : partnerId;

        var dup = await _db.InfraConnections
            .Find(c => c.Partner == "cds" && c.PartnerId == partnerId && c.Status == "active")
            .FirstOrDefaultAsync(ct);
        if (dup != null)
        {
            throw new InfraConnectionException(
                InfraConnectionErrorCodes.ConnectionDuplicate,
                $"已有同一 CDS（{dup.PartnerName}）连接，请先删除旧连接",
                StatusCodes.Status409Conflict);
        }

        var entity = new InfraConnection
        {
            Id = Guid.NewGuid().ToString("N"),
            Partner = "cds",
            PartnerName = partnerName,
            PartnerId = partnerId,
            PartnerBaseUrl = NormalizeBaseUrl(payload.CdsBaseUrl),
            LongTokenEncrypted = _protector.Protect(tokenResp.CdsLongToken),
            LongTokenExpiresAt = tokenResp.CdsLongTokenExpiresAt ?? DateTime.UtcNow.AddYears(1),
            ProjectId = tokenResp.ProjectId ?? string.Empty,
            InstanceDiscoveryUrl = tokenResp.InstanceDiscoveryUrl ?? string.Empty,
            Scopes = tokenResp.Scopes ?? new List<string>(),
            Status = "active",
            CreatedByUserId = userId,
            CreatedAt = DateTime.UtcNow,
            UpdatedAt = DateTime.UtcNow,
        };

        await _db.InfraConnections.InsertOneAsync(entity, cancellationToken: ct);
        _logger.LogInformation(
            "InfraConnection authorized id={Id} partner={Partner} partnerId={PartnerId} project={Project}",
            entity.Id, entity.Partner, entity.PartnerId, entity.ProjectId);

        return ToPublicView(entity);
    }

    public async Task<List<InfraConnectionPublicView>> ListAsync(CancellationToken ct)
    {
        var items = await _db.InfraConnections
            .Find(_ => true)
            .SortByDescending(c => c.CreatedAt)
            .ToListAsync(ct);
        return items.Select(ToPublicView).ToList();
    }

    public async Task<InfraConnectionPublicView?> GetAsync(string id, CancellationToken ct)
    {
        var entity = await _db.InfraConnections.Find(c => c.Id == id).FirstOrDefaultAsync(ct);
        return entity == null ? null : ToPublicView(entity);
    }

    public async Task<InfraConnection?> GetRawAsync(string id, CancellationToken ct)
    {
        return await _db.InfraConnections.Find(c => c.Id == id).FirstOrDefaultAsync(ct);
    }

    public async Task<string?> TryUnprotectLongTokenAsync(string id, CancellationToken ct, bool revokeOnFailure = true)
    {
        var entity = await GetRawAsync(id, ct);
        if (entity == null) return null;
        if (string.IsNullOrEmpty(entity.LongTokenEncrypted)) return null;
        try
        {
            return _protector.Unprotect(entity.LongTokenEncrypted);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(
                ex,
                "InfraConnection unprotect failed id={Id}; revokeOnFailure={RevokeOnFailure}",
                id,
                revokeOnFailure);
            if (!revokeOnFailure)
            {
                return null;
            }
            try
            {
                var update = Builders<InfraConnection>.Update
                    .Set(c => c.Status, "revoked")
                    .Set(c => c.UpdatedAt, DateTime.UtcNow);
                await _db.InfraConnections.UpdateOneAsync(c => c.Id == id, update, cancellationToken: ct);
            }
            catch (Exception inner)
            {
                _logger.LogWarning(inner, "InfraConnection auto-revoke after unprotect-failure also failed id={Id}", id);
            }
            return null;
        }
    }

    public async Task<bool> DeleteAsync(string id, CancellationToken ct)
    {
        var result = await _db.InfraConnections.DeleteOneAsync(c => c.Id == id, ct);
        return result.DeletedCount > 0;
    }

    public async Task<InfraConnectionPublicView?> ProbeAsync(string id, CancellationToken ct)
    {
        var entity = await GetRawAsync(id, ct);
        if (entity == null) return null;

        bool ok = false;
        string? error = null;
        bool credentialRevoked = false;
        try
        {
            var token = _protector.Unprotect(entity.LongTokenEncrypted);
            var url = JoinUrl(entity.PartnerBaseUrl, entity.InstanceDiscoveryUrl);
            var client = _httpClientFactory.CreateClient(HttpClientName);
            client.Timeout = TimeSpan.FromSeconds(10);
            using var req = new HttpRequestMessage(HttpMethod.Get, url);
            req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
            using var resp = await client.SendAsync(req, ct);
            if (resp.IsSuccessStatusCode)
            {
                ok = true;
            }
            else
            {
                error = $"HTTP {(int)resp.StatusCode} {resp.ReasonPhrase}";
            }
        }
        catch (Exception ex)
        {
            credentialRevoked = ex is CryptographicException;
            error = credentialRevoked ? "本地授权凭据已失效，请删除该连接后重新授权 CDS" : ex.Message;
        }

        var update = Builders<InfraConnection>.Update
            .Set(c => c.LastProbedAt, DateTime.UtcNow)
            .Set(c => c.LastProbeOk, ok)
            .Set(c => c.LastProbeError, error)
            .Set(c => c.UpdatedAt, DateTime.UtcNow);
        if (credentialRevoked && entity.Status != "revoked")
        {
            update = update.Set(c => c.Status, "revoked");
        }
        else if (!ok && entity.Status == "active")
        {
            update = update.Set(c => c.Status, "unreachable");
        }
        else if (ok && entity.Status != "active")
        {
            update = update.Set(c => c.Status, "active");
        }
        await _db.InfraConnections.UpdateOneAsync(c => c.Id == id, update, cancellationToken: ct);

        var refreshed = await GetRawAsync(id, ct);
        return refreshed == null ? null : ToPublicView(refreshed);
    }

    // ======================================================================
    // 内部辅助
    // ======================================================================

    private async Task<string> EnsureMapInstanceIdAsync(CancellationToken ct)
    {
        var existing = await _db.AppSettings.Find(s => s.Id == "global").FirstOrDefaultAsync(ct);
        if (existing != null && !string.IsNullOrWhiteSpace(existing.MapInstanceId))
        {
            return existing.MapInstanceId!;
        }

        var newId = Guid.NewGuid().ToString("N");
        if (existing == null)
        {
            var seed = new AppSettings
            {
                Id = "global",
                MapInstanceId = newId,
                UpdatedAt = DateTime.UtcNow
            };
            try
            {
                await _db.AppSettings.InsertOneAsync(seed, cancellationToken: ct);
            }
            catch (MongoWriteException)
            {
                // 并发场景：另一线程刚插入，回退到 update
                var update = Builders<AppSettings>.Update
                    .SetOnInsert(s => s.MapInstanceId, newId);
                await _db.AppSettings.UpdateOneAsync(
                    s => s.Id == "global",
                    update,
                    new UpdateOptions { IsUpsert = true },
                    ct);
                var reloaded = await _db.AppSettings.Find(s => s.Id == "global").FirstOrDefaultAsync(ct);
                return reloaded?.MapInstanceId ?? newId;
            }
            return newId;
        }

        var setUpdate = Builders<AppSettings>.Update
            .Set(s => s.MapInstanceId, newId)
            .Set(s => s.UpdatedAt, DateTime.UtcNow);
        await _db.AppSettings.UpdateOneAsync(s => s.Id == "global", setUpdate, cancellationToken: ct);
        return newId;
    }

    private string ResolveMapBaseUrl()
    {
        var ctx = _httpContextAccessor.HttpContext;
        if (ctx == null) return "(unknown)";
        var req = ctx.Request;
        if (req == null || !req.Host.HasValue) return "(unknown)";
        var scheme = string.IsNullOrWhiteSpace(req.Scheme) ? "https" : req.Scheme;
        return $"{scheme}://{req.Host.Value}";
    }

    private static ClipboardPayload ParseClipboard(string clipboardText)
    {
        // Prefix 校验
        var matched = SupportedVersionPrefixes.FirstOrDefault(p =>
            clipboardText.StartsWith(p, StringComparison.Ordinal));
        if (matched == null)
        {
            // 未来 v2+ 走这里，给出明确错误码
            if (clipboardText.StartsWith("cds-connect:v", StringComparison.Ordinal))
            {
                throw new InfraConnectionException(
                    InfraConnectionErrorCodes.ClipboardVersionNotSupported,
                    "MAP 版本太老，无法识别该协议版本，请先升级");
            }
            throw new InfraConnectionException(
                InfraConnectionErrorCodes.ClipboardInvalidFormat,
                "密钥格式不对，请回到 CDS 重新复制");
        }

        var encoded = clipboardText[matched.Length..].Trim();
        byte[] bytes;
        try
        {
            bytes = WebEncoders.Base64UrlDecode(encoded);
        }
        catch (Exception ex)
        {
            throw new InfraConnectionException(
                InfraConnectionErrorCodes.ClipboardInvalidFormat,
                $"密钥 base64url 解码失败：{ex.Message}");
        }

        var json = Encoding.UTF8.GetString(bytes);
        ClipboardPayload? payload;
        try
        {
            payload = JsonSerializer.Deserialize<ClipboardPayload>(json, JsonOpts);
        }
        catch (Exception ex)
        {
            throw new InfraConnectionException(
                InfraConnectionErrorCodes.ClipboardInvalidFormat,
                $"密钥 JSON 解析失败：{ex.Message}");
        }

        if (payload == null)
        {
            throw new InfraConnectionException(
                InfraConnectionErrorCodes.ClipboardInvalidFormat,
                "密钥 JSON 为空");
        }

        return payload;
    }

    private async Task<AcceptResponse> CallCdsAcceptAsync(
        ClipboardPayload payload,
        string mapId,
        string mapBaseUrl,
        string mapName,
        CancellationToken ct)
    {
        var client = _httpClientFactory.CreateClient(HttpClientName);
        client.Timeout = TimeSpan.FromSeconds(10);

        var url = JoinUrl(payload.CdsBaseUrl!, "/api/cds-system/connections/accept");
        var body = new AcceptRequest
        {
            PairingToken = payload.PairingToken!,
            MapBaseUrl = mapBaseUrl,
            MapId = mapId,
            MapName = mapName,
            ProjectIntent = new ProjectIntent
            {
                Kind = "shared-service",
                Name = "sidecar-pool",
                DisplayName = "Claude SDK Sidecar Pool"
            }
        };

        HttpResponseMessage resp;
        try
        {
            resp = await client.PostAsJsonAsync(url, body, JsonOpts, ct);
        }
        catch (TaskCanceledException ex) when (!ct.IsCancellationRequested)
        {
            throw new InfraConnectionException(
                InfraConnectionErrorCodes.CdsUnreachable,
                $"无法访问 CDS：连接超时（{ex.Message}）",
                StatusCodes.Status502BadGateway);
        }
        catch (HttpRequestException ex)
        {
            throw new InfraConnectionException(
                InfraConnectionErrorCodes.CdsUnreachable,
                $"无法访问 CDS：{ex.Message}",
                StatusCodes.Status502BadGateway);
        }

        if (!resp.IsSuccessStatusCode)
        {
            var bodyText = await SafeReadAsStringAsync(resp.Content, ct);
            var (code, message) = MapAcceptError(resp.StatusCode, bodyText);
            throw new InfraConnectionException(code, message, (int)resp.StatusCode);
        }

        AcceptResponse? parsed;
        try
        {
            parsed = await resp.Content.ReadFromJsonAsync<AcceptResponse>(JsonOpts, ct);
        }
        catch (Exception ex)
        {
            throw new InfraConnectionException(
                InfraConnectionErrorCodes.AcceptResponseInvalid,
                $"对端 accept 响应解析失败：{ex.Message}",
                StatusCodes.Status502BadGateway);
        }

        if (parsed == null || string.IsNullOrWhiteSpace(parsed.CdsLongToken))
        {
            throw new InfraConnectionException(
                InfraConnectionErrorCodes.AcceptResponseInvalid,
                "对端 accept 响应缺少 cdsLongToken",
                StatusCodes.Status502BadGateway);
        }

        return parsed;
    }

    private async Task<AcceptResponse> CallCdsTokenAsync(
        string cdsBaseUrl,
        string code,
        string mapId,
        string mapBaseUrl,
        string mapName,
        CancellationToken ct)
    {
        var client = _httpClientFactory.CreateClient(HttpClientName);
        client.Timeout = TimeSpan.FromSeconds(10);

        var url = JoinUrl(cdsBaseUrl, "/api/cds-system/connections/token");
        var body = new TokenRequest
        {
            Code = code,
            MapBaseUrl = mapBaseUrl,
            MapId = mapId,
            MapName = mapName,
            ProjectIntent = new ProjectIntent
            {
                Kind = "shared-service",
                Name = "sidecar-pool",
                DisplayName = "Claude SDK Sidecar Pool"
            }
        };

        HttpResponseMessage resp;
        try
        {
            resp = await client.PostAsJsonAsync(url, body, JsonOpts, ct);
        }
        catch (TaskCanceledException ex) when (!ct.IsCancellationRequested)
        {
            throw new InfraConnectionException(
                InfraConnectionErrorCodes.CdsUnreachable,
                $"无法访问 CDS：连接超时（{ex.Message}）",
                StatusCodes.Status502BadGateway);
        }
        catch (HttpRequestException ex)
        {
            throw new InfraConnectionException(
                InfraConnectionErrorCodes.CdsUnreachable,
                $"无法访问 CDS：{ex.Message}",
                StatusCodes.Status502BadGateway);
        }

        if (!resp.IsSuccessStatusCode)
        {
            var bodyText = await SafeReadAsStringAsync(resp.Content, ct);
            var (errCode, message) = MapAcceptError(resp.StatusCode, bodyText);
            throw new InfraConnectionException(errCode, message, (int)resp.StatusCode);
        }

        AcceptResponse? parsed;
        try
        {
            parsed = await resp.Content.ReadFromJsonAsync<AcceptResponse>(JsonOpts, ct);
        }
        catch (Exception ex)
        {
            throw new InfraConnectionException(
                InfraConnectionErrorCodes.AcceptResponseInvalid,
                $"对端 token 响应解析失败：{ex.Message}",
                StatusCodes.Status502BadGateway);
        }

        if (parsed == null || string.IsNullOrWhiteSpace(parsed.CdsLongToken))
        {
            throw new InfraConnectionException(
                InfraConnectionErrorCodes.AcceptResponseInvalid,
                "对端 token 响应缺少 cdsLongToken",
                StatusCodes.Status502BadGateway);
        }

        return parsed;
    }

    private static (string code, string message) MapAcceptError(HttpStatusCode status, string body)
    {
        // 优先解析对端返回的 errorCode（spec §3.3 一致约定）
        try
        {
            using var doc = JsonDocument.Parse(string.IsNullOrWhiteSpace(body) ? "{}" : body);
            var root = doc.RootElement;
            string? code = null;
            string? message = null;
            if (root.ValueKind == JsonValueKind.Object)
            {
                if (root.TryGetProperty("error", out var errEl) && errEl.ValueKind == JsonValueKind.Object)
                {
                    if (errEl.TryGetProperty("code", out var c)) code = c.GetString();
                    if (errEl.TryGetProperty("message", out var m)) message = m.GetString();
                }
                else
                {
                    if (root.TryGetProperty("errorCode", out var c)) code = c.GetString();
                    if (root.TryGetProperty("message", out var m)) message = m.GetString();
                }
            }
            if (!string.IsNullOrWhiteSpace(code))
            {
                return (code!, message ?? $"对端 CDS 返回错误：{code}");
            }
        }
        catch
        {
            // ignore — fall through to status-based mapping
        }

        return status switch
        {
            HttpStatusCode.NotFound => (
                InfraConnectionErrorCodes.PairingTokenNotFound,
                "密钥无效，请回到 CDS 重新生成"),
            HttpStatusCode.Gone => (
                InfraConnectionErrorCodes.PairingTokenExpired,
                "密钥已过期或已被使用，请回到 CDS 重新生成"),
            HttpStatusCode.Conflict => (
                InfraConnectionErrorCodes.ConnectionDuplicate,
                "对端已存在同一连接"),
            _ => (
                InfraConnectionErrorCodes.CdsUnreachable,
                $"对端 CDS 返回 {(int)status}：{(string.IsNullOrEmpty(body) ? "(无响应体)" : body)}")
        };
    }

    private static async Task<string> SafeReadAsStringAsync(HttpContent? content, CancellationToken ct)
    {
        if (content == null) return string.Empty;
        try { return await content.ReadAsStringAsync(ct); }
        catch { return string.Empty; }
    }

    private static string NormalizeBaseUrl(string url)
    {
        return url.TrimEnd('/');
    }

    private static string NormalizeAndValidateHttpBaseUrl(string url)
    {
        var trimmed = url.Trim().TrimEnd('/');
        if (!Uri.TryCreate(trimmed, UriKind.Absolute, out var uri)
            || (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps)
            || string.IsNullOrWhiteSpace(uri.Host))
        {
            throw new InfraConnectionException(
                InfraConnectionErrorCodes.CdsBaseUrlInvalid,
                "CDS 地址必须是 http 或 https URL");
        }
        return uri.GetLeftPart(UriPartial.Authority);
    }

    private static string JoinUrl(string baseUrl, string path)
    {
        var b = (baseUrl ?? string.Empty).TrimEnd('/');
        var p = (path ?? string.Empty);
        if (string.IsNullOrEmpty(p)) return b;
        if (!p.StartsWith('/')) p = "/" + p;
        return b + p;
    }

    private string EncodeAuthorizationState(AuthorizationStatePayload payload)
    {
        var json = JsonSerializer.Serialize(payload, JsonOpts);
        var payloadPart = WebEncoders.Base64UrlEncode(Encoding.UTF8.GetBytes(json));
        var signature = SignStatePayload(payloadPart);
        return $"{payloadPart}.{signature}";
    }

    private AuthorizationStatePayload DecodeAuthorizationState(string state)
    {
        if (string.IsNullOrWhiteSpace(state))
        {
            throw new InfraConnectionException(
                InfraConnectionErrorCodes.AuthorizationStateInvalid,
                "授权 state 为空");
        }

        var parts = state.Split('.', 2);
        if (parts.Length != 2 || string.IsNullOrWhiteSpace(parts[0]) || string.IsNullOrWhiteSpace(parts[1]))
        {
            throw new InfraConnectionException(
                InfraConnectionErrorCodes.AuthorizationStateInvalid,
                "授权 state 格式错误");
        }

        var expected = SignStatePayload(parts[0]);
        if (!CryptographicOperations.FixedTimeEquals(
                Encoding.UTF8.GetBytes(expected),
                Encoding.UTF8.GetBytes(parts[1])))
        {
            throw new InfraConnectionException(
                InfraConnectionErrorCodes.AuthorizationStateInvalid,
                "授权 state 签名无效",
                StatusCodes.Status403Forbidden);
        }

        try
        {
            var json = Encoding.UTF8.GetString(WebEncoders.Base64UrlDecode(parts[0]));
            var payload = JsonSerializer.Deserialize<AuthorizationStatePayload>(json, JsonOpts);
            if (payload == null || string.IsNullOrWhiteSpace(payload.CdsBaseUrl))
            {
                throw new InvalidOperationException("empty authorization state");
            }
            return payload;
        }
        catch (InfraConnectionException)
        {
            throw;
        }
        catch (Exception ex)
        {
            throw new InfraConnectionException(
                InfraConnectionErrorCodes.AuthorizationStateInvalid,
                $"授权 state 解析失败：{ex.Message}");
        }
    }

    private string SignStatePayload(string payloadPart)
    {
        var secret = _configuration["Jwt:Secret"];
        if (string.IsNullOrWhiteSpace(secret))
        {
            throw new InfraConnectionException(
                InfraConnectionErrorCodes.AuthorizationStateInvalid,
                "Jwt:Secret 未配置，无法发起 CDS 授权",
                StatusCodes.Status503ServiceUnavailable);
        }
        using var hmac = new HMACSHA256(Encoding.UTF8.GetBytes(secret));
        return WebEncoders.Base64UrlEncode(hmac.ComputeHash(Encoding.UTF8.GetBytes(payloadPart)));
    }

    internal static InfraConnectionPublicView ToPublicView(InfraConnection c)
    {
        return new InfraConnectionPublicView(
            Id: c.Id,
            Partner: c.Partner,
            PartnerName: c.PartnerName,
            PartnerId: c.PartnerId,
            PartnerBaseUrl: c.PartnerBaseUrl,
            ProjectId: c.ProjectId,
            InstanceDiscoveryUrl: c.InstanceDiscoveryUrl,
            Scopes: c.Scopes ?? new List<string>(),
            Status: c.Status,
            CreatedAt: c.CreatedAt,
            UpdatedAt: c.UpdatedAt,
            LastProbedAt: c.LastProbedAt,
            LastProbeOk: c.LastProbeOk,
            LastProbeError: c.LastProbeError,
            LongTokenExpiresAt: c.LongTokenExpiresAt
        );
    }

    // ======================================================================
    // DTO（剪贴板内嵌 JSON / accept 请求与响应）
    // ======================================================================

    private sealed class ClipboardPayload
    {
        [JsonPropertyName("version")] public int? Version { get; set; }
        [JsonPropertyName("cdsBaseUrl")] public string? CdsBaseUrl { get; set; }
        [JsonPropertyName("cdsId")] public string? CdsId { get; set; }
        [JsonPropertyName("cdsName")] public string? CdsName { get; set; }
        [JsonPropertyName("pairingToken")] public string? PairingToken { get; set; }
        [JsonPropertyName("issuedAt")] public DateTime? IssuedAt { get; set; }
        [JsonPropertyName("expiresAt")] public DateTime? ExpiresAt { get; set; }
        [JsonPropertyName("scopes")] public List<string>? Scopes { get; set; }
    }

    private sealed class AcceptRequest
    {
        [JsonPropertyName("pairingToken")] public string PairingToken { get; set; } = string.Empty;
        [JsonPropertyName("mapBaseUrl")] public string MapBaseUrl { get; set; } = string.Empty;
        [JsonPropertyName("mapId")] public string MapId { get; set; } = string.Empty;
        [JsonPropertyName("mapName")] public string MapName { get; set; } = string.Empty;
        [JsonPropertyName("projectIntent")] public ProjectIntent ProjectIntent { get; set; } = new();
    }

    private sealed class TokenRequest
    {
        [JsonPropertyName("code")] public string Code { get; set; } = string.Empty;
        [JsonPropertyName("mapBaseUrl")] public string MapBaseUrl { get; set; } = string.Empty;
        [JsonPropertyName("mapId")] public string MapId { get; set; } = string.Empty;
        [JsonPropertyName("mapName")] public string MapName { get; set; } = string.Empty;
        [JsonPropertyName("projectIntent")] public ProjectIntent ProjectIntent { get; set; } = new();
    }

    private sealed class ProjectIntent
    {
        [JsonPropertyName("kind")] public string Kind { get; set; } = "shared-service";
        [JsonPropertyName("name")] public string Name { get; set; } = string.Empty;
        [JsonPropertyName("displayName")] public string DisplayName { get; set; } = string.Empty;
    }

    private sealed class AcceptResponse
    {
        [JsonPropertyName("connectionId")] public string? ConnectionId { get; set; }
        [JsonPropertyName("cdsLongToken")] public string CdsLongToken { get; set; } = string.Empty;
        [JsonPropertyName("cdsLongTokenExpiresAt")] public DateTime? CdsLongTokenExpiresAt { get; set; }
        [JsonPropertyName("projectId")] public string? ProjectId { get; set; }
        [JsonPropertyName("instanceDiscoveryUrl")] public string? InstanceDiscoveryUrl { get; set; }
        [JsonPropertyName("deployStreamUrlTemplate")] public string? DeployStreamUrlTemplate { get; set; }
        [JsonPropertyName("cdsId")] public string? CdsId { get; set; }
        [JsonPropertyName("cdsName")] public string? CdsName { get; set; }
        [JsonPropertyName("scopes")] public List<string>? Scopes { get; set; }
    }

    private sealed class AuthorizationStatePayload
    {
        [JsonPropertyName("cdsBaseUrl")] public string CdsBaseUrl { get; set; } = string.Empty;
        [JsonPropertyName("mapBaseUrl")] public string MapBaseUrl { get; set; } = string.Empty;
        [JsonPropertyName("mapId")] public string MapId { get; set; } = string.Empty;
        [JsonPropertyName("userId")] public string UserId { get; set; } = string.Empty;
        [JsonPropertyName("expiresAtUnix")] public long ExpiresAtUnix { get; set; }
        [JsonPropertyName("nonce")] public string Nonce { get; set; } = string.Empty;
    }
}
