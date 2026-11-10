using System.Net;
using System.Net.Sockets;
using System.Text.Json.Serialization;
using MongoDB.Bson;

namespace PrdAgent.GatewayTransport;

public sealed class UpstreamProxyWrite
{
    public string Mode { get; set; } = "inherit";
    public string? Address { get; set; }
    public string? Username { get; set; }
    public string? Password { get; set; }
    public bool ClearPassword { get; set; }
}

public sealed record UpstreamProxyView(string Mode, string? Address, string? Username, bool HasPassword);

// 仅在计算阶段解密，发送与重试消费同一份快照；禁止序列化凭据。
public sealed record ResolvedUpstreamProxy(string Mode, string? Address, string? Username,
    [property: JsonIgnore] string? Password)
{
    public override string ToString() => $"{Mode}: {Address}";
}

public static class UpstreamProxy
{
    public const string Field = "UpstreamProxy";
    public static BsonDocument? Read(BsonDocument? owner)
        => owner?.GetValue(Field, BsonNull.Value) is BsonDocument doc ? doc : null;

    private static string? Text(BsonDocument? doc, string key)
        => doc?.GetValue(key, BsonNull.Value) is BsonString value ? value.Value : null;

    public static UpstreamProxyView View(BsonDocument? doc, string defaultMode = "inherit")
        => new(Text(doc, "Mode") ?? defaultMode, Text(doc, "Address"), Text(doc, "Username"),
            !string.IsNullOrEmpty(Text(doc, "PasswordEncrypted")));

    public static BsonDocument Build(UpstreamProxyWrite input, BsonDocument? previous,
        Func<string, string> encrypt, bool global = false)
    {
        var mode = (input.Mode ?? "").Trim().ToLowerInvariant();
        if (mode is not ("inherit" or "direct" or "custom") || global && mode == "inherit")
            throw new ArgumentException("请选择跟随全局、强制直连或独立代理；全局设置请选择直连或代理");
        if (mode != "custom") return new BsonDocument("Mode", mode);
        if (!Uri.TryCreate(input.Address?.Trim(), UriKind.Absolute, out var uri)
            || uri.Scheme is not ("http" or "https" or "socks5")
            || string.IsNullOrEmpty(uri.Host) || uri.Port is < 1 or > 65535
            || uri.UserInfo.Length > 0 || uri.AbsolutePath != "/" || uri.Query.Length > 0 || uri.Fragment.Length > 0)
            throw new ArgumentException("代理地址请填写 http://主机:端口、https://主机:端口或 socks5://主机:端口；账号密码请分开填写");
        var username = input.Username?.Trim() ?? "";
        if (username.Length > 255 || username.Any(char.IsControl) || input.Password?.Length > 1024)
            throw new ArgumentException("代理账号或密码超出长度限制，或账号含有无效字符");
        var password = input.ClearPassword ? null : string.IsNullOrEmpty(input.Password)
            ? Text(previous, "PasswordEncrypted") : encrypt(Convert.ToBase64String(System.Text.Encoding.UTF8.GetBytes(input.Password)));
        if (password is not null && username.Length == 0)
            throw new ArgumentException("使用代理密码时，请同时填写代理账号；移除认证请勾选清除密码");
        return new BsonDocument
        {
            { "Mode", mode }, { "Address", uri.GetLeftPart(UriPartial.Authority) },
            { "Username", username }, { "PasswordEncrypted", (BsonValue?)password ?? BsonNull.Value },
        };
    }

    public static ResolvedUpstreamProxy? Resolve(BsonDocument? local, BsonDocument? global,
        Func<string, string?> decrypt)
    {
        var selected = View(local).Mode == "inherit" ? global : local;
        if (selected is null) return null; // 未配置时保留部署既有的出站行为。
        var view = View(selected, "direct");
        if (view.Mode == "direct") return new("direct", null, null, null);
        if (view.Mode != "custom" || string.IsNullOrEmpty(view.Address))
            throw new InvalidOperationException("代理配置无效，请重新保存代理设置");
        var ciphertext = Text(selected, "PasswordEncrypted");
        var password = ciphertext is null ? null : decrypt(ciphertext);
        if (ciphertext is not null && string.IsNullOrEmpty(password))
            throw new InvalidOperationException("代理密码无法读取，请重新填写代理密码后保存");
        if (password is not null)
        {
            try { password = System.Text.Encoding.UTF8.GetString(Convert.FromBase64String(password)); }
            catch (FormatException) { throw new InvalidOperationException("代理密码格式无效，请重新填写代理密码后保存"); }
        }
        return new("custom", view.Address, view.Username, password);
    }

    public static bool IsPublicAddress(IPAddress address) => SafeOutboundAddressPolicy.IsPublicAddress(address);

    public static SocketsHttpHandler CreateHandler(ResolvedUpstreamProxy proxy, bool publicOnly)
    {
        var handler = new SocketsHttpHandler
        {
            AllowAutoRedirect = false,
            UseProxy = proxy.Mode is "custom" or "system",
            ConnectTimeout = TimeSpan.FromSeconds(15),
        };
        if (proxy.Mode == "custom")
        {
            handler.Proxy = new WebProxy(proxy.Address!)
            {
                Credentials = string.IsNullOrEmpty(proxy.Username) ? null : new NetworkCredential(proxy.Username, proxy.Password),
                BypassProxyOnLocal = false,
            };
        }
        // 使用代理时这里钉住代理的真实地址；不把目标域名交给本地 DNS。
        // 外部租户不能把代理指向网关内网；直连时同样固定到校验过的目标 IP。
        if (publicOnly) handler.ConnectCallback = ConnectPublicAsync;
        return handler;
    }

    private static async ValueTask<Stream> ConnectPublicAsync(SocketsHttpConnectionContext context, CancellationToken ct)
    {
        var host = context.DnsEndPoint.Host;
        var addresses = IPAddress.TryParse(host, out var literal) ? new[] { literal } : await Dns.GetHostAddressesAsync(host, ct);
        if (addresses.Length == 0 || addresses.Any(address => !IsPublicAddress(address)))
            throw new HttpRequestException("代理或上游解析到了内网或保留地址，已拒绝连接");
        Exception? lastError = null;
        foreach (var address in addresses)
        {
            var socket = new Socket(address.AddressFamily, SocketType.Stream, ProtocolType.Tcp) { NoDelay = true };
            try
            {
                await socket.ConnectAsync(new IPEndPoint(address, context.DnsEndPoint.Port), ct);
                return new NetworkStream(socket, ownsSocket: true);
            }
            catch (Exception ex) { socket.Dispose(); lastError = ex; }
        }
        throw lastError ?? new HttpRequestException("连接失败");
    }
}
