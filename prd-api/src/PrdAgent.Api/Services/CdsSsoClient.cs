using System.IdentityModel.Tokens.Jwt;
using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.AspNetCore.WebUtilities;
using Microsoft.IdentityModel.Protocols;
using Microsoft.IdentityModel.Protocols.OpenIdConnect;
using Microsoft.IdentityModel.Tokens;

namespace PrdAgent.Api.Services;

public sealed record CdsSsoSettings(Uri? Issuer, string ClientId, Uri? RedirectUri)
{
    private readonly Dictionary<string, string> _accounts = new(StringComparer.Ordinal);
    public const string AuthPath = "/api/v1/auth/cds";
    public const string CallbackPath = AuthPath + "/callback";
    public bool IsForHost(HostString host) => RedirectUri is not null
        && string.Equals(host.Value, RedirectUri.Authority, StringComparison.OrdinalIgnoreCase);

    public string Scope => $"{Issuer}|{ClientId}|{RedirectUri}";
    internal string? LocalAccount(string subject) => _accounts.GetValueOrDefault(subject);

    public static CdsSsoSettings Read(IConfiguration config)
    {
        if (!config.GetValue<bool>("CdsSso:Enabled")) return new(null, "", null);

        var clientId = config["CdsSso:ClientId"]?.Trim() ?? "";
        if (!TryHttps(config["CdsSso:Issuer"], out var issuer) || issuer!.AbsolutePath != "/api/oidc"
            || !TryHttps(config["CdsSso:RedirectUri"], out var redirect) || redirect!.AbsolutePath != CallbackPath
            || issuer.IdnHost == redirect.IdnHost
            || !clientId.StartsWith("cds-site:", StringComparison.Ordinal)
            || clientId.Length is < 10 or > 256 || clientId.Any(c => char.IsWhiteSpace(c) || char.IsControl(c)))
            throw new InvalidOperationException("CDS SSO needs a trusted HTTPS issuer, a CDS site client ID and the exact MAP callback URL.");

        var settings = new CdsSsoSettings(issuer, clientId, redirect);
        foreach (var entry in config.GetSection("CdsSso:Accounts").GetChildren())
        {
            var local = entry.Value?.Trim();
            if (entry.Key.Length is < 1 or > 128 || entry.Key.Any(c => !char.IsAsciiLetterOrDigit(c) && c != '_' && c != '-')
                || string.IsNullOrEmpty(local) || local.Length > 128 || local.Any(char.IsControl))
                throw new InvalidOperationException("Invalid MAP account binding in CdsSso:Accounts.");
            settings._accounts.Add(entry.Key, local);
        }
        return settings;
    }

    internal static bool TryHttps(string? value, out Uri? uri) =>
        Uri.TryCreate(value, UriKind.Absolute, out uri) && uri.Scheme == Uri.UriSchemeHttps
        && uri.Host.Length > 0 && uri.UserInfo.Length == 0 && uri.Query.Length == 0 && uri.Fragment.Length == 0;
}

public sealed class CdsSsoClient
{
    private static readonly TimeSpan MaxLifetime = TimeSpan.FromHours(8);
    private readonly CdsSsoSettings _settings;
    private readonly IHttpClientFactory _clients;
    private readonly ConfigurationManager<OpenIdConnectConfiguration>? _metadata;

    public CdsSsoClient(CdsSsoSettings settings, IHttpClientFactory clients)
    {
        _settings = settings;
        _clients = clients;
        if (settings.Issuer is not null)
        {
            _metadata = new ConfigurationManager<OpenIdConnectConfiguration>(
                settings.Issuer.AbsoluteUri + "/.well-known/openid-configuration",
                new MetadataRetriever(settings.Issuer),
                new HttpDocumentRetriever(_clients.CreateClient(nameof(CdsSsoClient))));
        }
    }

    internal async Task<string> AuthorizationUrlAsync(CdsSsoFlow flow, bool switchAccount, CancellationToken ct)
    {
        var config = await _metadata!.GetConfigurationAsync(ct);
        var query = new Dictionary<string, string?>
        {
            ["client_id"] = _settings.ClientId,
            ["redirect_uri"] = _settings.RedirectUri!.AbsoluteUri,
            ["response_type"] = "code",
            ["scope"] = "openid",
            ["state"] = flow.State,
            ["nonce"] = flow.Nonce,
            ["code_challenge"] = Base64UrlEncoder.Encode(SHA256.HashData(Encoding.ASCII.GetBytes(flow.Verifier))),
            ["code_challenge_method"] = "S256"
        };
        if (switchAccount) query["prompt"] = "select_account";
        return QueryHelpers.AddQueryString(config.AuthorizationEndpoint, query);
    }

    internal async Task<CdsSsoDelegation?> RedeemAsync(string code, CdsSsoFlow flow, CancellationToken ct)
    {
        var config = await _metadata!.GetConfigurationAsync(ct);
        using var client = _clients.CreateClient(nameof(CdsSsoClient));
        using var form = new FormUrlEncodedContent(new Dictionary<string, string>
        {
            ["grant_type"] = "authorization_code",
            ["client_id"] = _settings.ClientId,
            ["redirect_uri"] = _settings.RedirectUri!.AbsoluteUri,
            ["code"] = code,
            ["code_verifier"] = flow.Verifier
        });
        var startedAt = DateTime.UtcNow;
        using var response = await client.PostAsync(config.TokenEndpoint, form, ct);
        if (IsDenied(response.StatusCode)) return null;
        response.EnsureSuccessStatusCode();
        var tokens = await response.Content.ReadFromJsonAsync<TokenReply>(cancellationToken: ct);
        if (tokens is null || tokens.ExpiresIn <= 0 || string.IsNullOrEmpty(tokens.AccessToken)
            || string.IsNullOrEmpty(tokens.IdToken) || !string.Equals(tokens.TokenType, "Bearer", StringComparison.OrdinalIgnoreCase))
            return null;

        string? subject;
        try
        {
            subject = ValidateIdToken(tokens.IdToken, config.SigningKeys, flow.Nonce);
        }
        catch (SecurityTokenSignatureKeyNotFoundException)
        {
            _metadata.RequestRefresh();
            throw;
        }

        if (subject is null) return null;
        var identity = await GetIdentityAsync(tokens.AccessToken, ct);
        var localAccount = _settings.LocalAccount(subject);
        if (identity?.Subject != subject || localAccount is null) return null;

        return new(subject, localAccount, tokens.AccessToken,
            startedAt.AddSeconds(Math.Min(tokens.ExpiresIn, MaxLifetime.TotalSeconds)));
    }

    internal async Task<CdsSsoIdentity?> GetIdentityAsync(string accessToken, CancellationToken ct)
    {
        var config = await _metadata!.GetConfigurationAsync(ct);
        using var client = _clients.CreateClient(nameof(CdsSsoClient));
        using var request = new HttpRequestMessage(HttpMethod.Get, config.UserInfoEndpoint);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", accessToken);
        using var response = await client.SendAsync(request, ct);
        if (IsDenied(response.StatusCode)) return null;
        response.EnsureSuccessStatusCode();
        return await response.Content.ReadFromJsonAsync<CdsSsoIdentity>(cancellationToken: ct);
    }

    internal string? ValidateIdToken(string token, IEnumerable<SecurityKey> keys, string nonce)
    {
        var handler = new JwtSecurityTokenHandler { MapInboundClaims = false };
        handler.ValidateToken(token, new TokenValidationParameters
        {
            ValidIssuer = _settings.Issuer!.AbsoluteUri,
            ValidAudience = _settings.ClientId,
            IgnoreTrailingSlashWhenValidatingAudience = false,
            IssuerSigningKeys = keys,
            ValidAlgorithms = [SecurityAlgorithms.RsaSha256],
            ValidateIssuerSigningKey = true,
            ValidateIssuer = true,
            ValidateAudience = true,
            ValidateLifetime = true,
            RequireSignedTokens = true,
            RequireExpirationTime = true,
            ClockSkew = TimeSpan.FromSeconds(15)
        }, out var validated);
        var jwt = (JwtSecurityToken)validated;
        return jwt.Audiences.SequenceEqual([_settings.ClientId])
            && jwt.Claims.SingleOrDefault(claim => claim.Type == "nonce")?.Value == nonce
            && !string.IsNullOrWhiteSpace(jwt.Subject) ? jwt.Subject : null;
    }

    private static bool IsDenied(HttpStatusCode status) =>
        status is HttpStatusCode.BadRequest or HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden;

    private sealed class MetadataRetriever(Uri issuer) : IConfigurationRetriever<OpenIdConnectConfiguration>
    {
        public async Task<OpenIdConnectConfiguration> GetConfigurationAsync(string address, IDocumentRetriever retriever, CancellationToken ct)
        {
            var metadata = JsonSerializer.Deserialize<DiscoveryReply>(await retriever.GetDocumentAsync(address, ct));
            if (metadata is null || metadata.Issuer != issuer.AbsoluteUri || !IsIssuerEndpoint(metadata.Authorize)
                || !IsIssuerEndpoint(metadata.Token) || !IsIssuerEndpoint(metadata.UserInfo) || !IsIssuerEndpoint(metadata.Keys))
                throw new InvalidOperationException("Untrusted CDS OIDC metadata.");

            var config = new OpenIdConnectConfiguration
            {
                Issuer = metadata.Issuer,
                AuthorizationEndpoint = metadata.Authorize,
                TokenEndpoint = metadata.Token,
                UserInfoEndpoint = metadata.UserInfo,
                JwksUri = metadata.Keys
            };
            var jwks = new JsonWebKeySet(await retriever.GetDocumentAsync(metadata.Keys, ct));
            foreach (var key in jwks.GetSigningKeys()) config.SigningKeys.Add(key);
            return config;
        }

        private bool IsIssuerEndpoint([System.Diagnostics.CodeAnalysis.NotNullWhen(true)] string? address) => CdsSsoSettings.TryHttps(address, out var endpoint)
            && endpoint!.Authority == issuer.Authority
            && endpoint.AbsolutePath.StartsWith(issuer.AbsolutePath + "/", StringComparison.Ordinal);
    }

    private sealed record DiscoveryReply(
        [property: JsonPropertyName("issuer")] string? Issuer,
        [property: JsonPropertyName("authorization_endpoint")] string? Authorize,
        [property: JsonPropertyName("token_endpoint")] string? Token,
        [property: JsonPropertyName("userinfo_endpoint")] string? UserInfo,
        [property: JsonPropertyName("jwks_uri")] string? Keys);

    private sealed record TokenReply(
        [property: JsonPropertyName("id_token")] string? IdToken,
        [property: JsonPropertyName("access_token")] string? AccessToken,
        [property: JsonPropertyName("expires_in")] int ExpiresIn,
        [property: JsonPropertyName("token_type")] string? TokenType);
}

internal sealed record CdsSsoFlow(string State, string Nonce, string Verifier, string SessionProof, string ReturnUrl);
internal sealed record CdsSsoIdentity([property: JsonPropertyName("sub")] string? Subject);
internal sealed record CdsSsoDelegation(string Subject, string LocalAccount, string AccessToken, DateTime ExpiresAt);
