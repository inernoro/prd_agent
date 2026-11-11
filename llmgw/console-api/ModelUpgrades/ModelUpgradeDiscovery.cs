using System.Text.Json;
using Microsoft.AspNetCore.Http;
using MongoDB.Bson;
using PrdAgent.GatewayTransport;
using PrdAgent.LlmGw.Auth;
using PrdAgent.LlmGw.Mongo;
using PrdAgent.LlmGw.Provisioning;
using PrdAgent.LlmGw.Security;
using MongoDB.Driver;

namespace PrdAgent.LlmGw.ModelUpgrades;

public interface IModelUpgradeDiscovery
{
    Task<HashSet<string>> DiscoverAsync(ModelUpgradeState state, BsonDocument provider, CancellationToken ct);
}

/// <summary>复用官方预设的 models URL、代理与加密读取。只拉清单，不发送付费推理。</summary>
public sealed class ModelUpgradeDiscovery(UpstreamProxyService proxies, IConfiguration config, string internalTenantId, IMongoDatabase gateway) : IModelUpgradeDiscovery
{
    public static ProviderPreset RequireOfficial(BsonDocument provider)
    {
        if (!Uri.TryCreate(provider.AsNullableString("ApiUrl"), UriKind.Absolute, out var url)
            || url.Scheme != "https" || url.UserInfo.Length > 0 || url.Port != 443)
            throw new ModelUpgradeException("OFFICIAL_PROVIDER_REQUIRED", "自动更新仅接受已登记的官方 HTTPS Provider，请核对上游地址。", 400);
        return ProviderPresets.All.FirstOrDefault(p => Uri.TryCreate(p.ApiUrl, UriKind.Absolute, out var known)
            && known.Scheme == "https" && string.Equals(known.Host, url.Host, StringComparison.OrdinalIgnoreCase))
            ?? throw new ModelUpgradeException("OFFICIAL_PROVIDER_REQUIRED", "此上游地址不属于官方预设，未自动发现或更新。", 400);
    }

    public async Task<HashSet<string>> DiscoverAsync(ModelUpgradeState state, BsonDocument provider, CancellationToken ct)
    {
        var preset = RequireOfficial(provider);
        if (!preset.SupportsModelDiscovery)
            throw new ModelUpgradeException("DISCOVERY_UNSUPPORTED", "此官方上游未提供当前支持的模型清单接口，请先导入明确候选并用真实业务请求验收。", 409);
        var context = new DefaultHttpContext();
        context.Items[TenantAccess.ItemKey] = new TenantAccessContext(state.TenantId, "", state.TenantId == internalTenantId,
            state.ActorConsoleUserId, state.ActorUsername, "", 0, "admin", []);
        var resolved = await proxies.ResolveAsync(context, provider);
        var key = GwApiKeyCrypto.Decrypt(provider.AsNullableString("ApiKeyEncrypted"), config);
        if (!key.Success) throw new ModelUpgradeException("KEY_UNREADABLE", "官方 Provider 密钥不可读取，请在上游设置中修复后重新检查。", 409);
        using var client = new HttpClient(UpstreamProxy.CreateHandler(resolved ?? new("system", null, null, null), state.TenantId != internalTenantId));
        return await new ModelUpgradeDiscoveryAudit(gateway, config).ExecuteAsync(state, provider,
            new Uri(ProviderPresets.ResolveModelsUrl(provider.GetStringOrEmpty("ApiUrl"))), client, key.PlainText!, ct);
    }

    public static HashSet<string> ReadModelNames(byte[] body)
    {
        using var json = JsonDocument.Parse(body);
        if (json.RootElement.ValueKind != JsonValueKind.Object || !json.RootElement.TryGetProperty("data", out var data) || data.ValueKind != JsonValueKind.Array)
            throw new ModelUpgradeException("DISCOVERY_SHAPE", "上游未返回模型清单，本次未判断任何型号退役。", 502);
        return data.EnumerateArray().Where(x => x.ValueKind == JsonValueKind.Object && x.TryGetProperty("id", out var id) && id.ValueKind == JsonValueKind.String)
            .Select(x => x.GetProperty("id").GetString()!).ToHashSet(StringComparer.Ordinal);
    }
}
