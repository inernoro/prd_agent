using System.Security.Cryptography;
using System.Text;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Infrastructure.Services;

/// <summary>
/// 节点身份 + HMAC 鉴权（系统级跨节点互传）。详见 doc/design.peer-sync.md §5.1。
///
/// 签名串：HMAC_SHA256(sharedSecret, "{METHOD}\n{path}\n{ts}\n{sha256(body)}")。
/// 共享密钥永不出现在 URL / 日志 / 前端；时间戳偏移超 5 分钟拒绝（防重放）。
/// </summary>
public class PeerNodeService : IPeerNodeService
{
    private const int MaxSkewMs = 5 * 60 * 1000;

    private readonly MongoDbContext _db;

    public PeerNodeService(MongoDbContext db)
    {
        _db = db;
    }

    public async Task<string> GetSelfNodeIdAsync(CancellationToken ct = default)
    {
        // 优先环境变量覆盖：允许同 DB 部署的不同分支（如 CDS 灰度环境共享 MongoDB）用 env
        // 强制不同 nodeId 以测试互传；也用于运维需要重置节点身份的场景。
        var envOverride = Environment.GetEnvironmentVariable("PEER_NODE_ID_OVERRIDE");
        if (!string.IsNullOrWhiteSpace(envOverride))
            return envOverride.Trim();

        var existing = await _db.AppSettings.Find(s => s.Id == "global").FirstOrDefaultAsync(ct);
        if (existing != null && !string.IsNullOrWhiteSpace(existing.MapInstanceId))
            return existing.MapInstanceId!;

        // 关键修复（PR #742 review P1）：旧版 SetOnInsert 在「AppSettings.global 已存在但 MapInstanceId 为空」
        // 的升级场景下是 no-op —— 每次调用都返回新 GUID 但永不落库，导致 HMAC 身份在请求间漂移、配对失效。
        // 改为：缺失文档时 InsertOne（带唯一约束兜底）；存在但 MapInstanceId 空时显式 $set 持久化。
        var newId = Guid.NewGuid().ToString("N");
        if (existing == null)
        {
            try
            {
                await _db.AppSettings.InsertOneAsync(
                    new AppSettings { Id = "global", MapInstanceId = newId, UpdatedAt = DateTime.UtcNow },
                    cancellationToken: ct);
                return newId;
            }
            catch (MongoWriteException)
            {
                // 并发：另一进程刚插入。重读取它的 MapInstanceId。
            }
        }
        else
        {
            // 文档存在但 MapInstanceId 为空：用条件 $set 落入，仅当当前仍为空时写（避免并发覆盖）。
            var filter = Builders<AppSettings>.Filter.And(
                Builders<AppSettings>.Filter.Eq(s => s.Id, "global"),
                Builders<AppSettings>.Filter.Or(
                    Builders<AppSettings>.Filter.Eq(s => s.MapInstanceId, (string?)null),
                    Builders<AppSettings>.Filter.Eq(s => s.MapInstanceId, string.Empty)));
            var update = Builders<AppSettings>.Update
                .Set(s => s.MapInstanceId, newId)
                .Set(s => s.UpdatedAt, DateTime.UtcNow);
            await _db.AppSettings.UpdateOneAsync(filter, update, cancellationToken: ct);
        }
        var reloaded = await _db.AppSettings.Find(s => s.Id == "global").FirstOrDefaultAsync(ct);
        if (reloaded != null && !string.IsNullOrWhiteSpace(reloaded.MapInstanceId))
            return reloaded.MapInstanceId!;
        // 极端兜底：不返回未持久化的 GUID 给上层（保证调用方拿到的 nodeId 永远是 DB 里那个）
        throw new InvalidOperationException("PeerNodeService.GetSelfNodeIdAsync: 无法持久化 MapInstanceId");
    }

    public (string ts, string sign) Sign(string sharedSecret, string method, string path, string body)
    {
        var ts = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds().ToString();
        var sign = Compute(sharedSecret, method, path, ts, body);
        return (ts, sign);
    }

    public bool Verify(string sharedSecret, string method, string path, string body, string ts, string sign)
    {
        if (string.IsNullOrEmpty(sharedSecret) || string.IsNullOrEmpty(ts) || string.IsNullOrEmpty(sign))
            return false;
        if (!long.TryParse(ts, out var tsMs)) return false;
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        if (Math.Abs(now - tsMs) > MaxSkewMs) return false;

        var expected = Compute(sharedSecret, method, path, ts, body);
        var expectedBytes = Encoding.UTF8.GetBytes(expected);
        var signBytes = Encoding.UTF8.GetBytes(sign);
        // PR #742 review Medium fix：FixedTimeEquals 在两数组长度不同时会抛 ArgumentException，
        // 让恶意/畸形 X-Peer-Sign 头把 [AllowAnonymous] 端点打成 500 而不是 401。先比长度。
        if (expectedBytes.Length != signBytes.Length) return false;
        // 常量时间比较，防时序侧信道
        return CryptographicOperations.FixedTimeEquals(expectedBytes, signBytes);
    }

    private static string Compute(string sharedSecret, string method, string path, string ts, string body)
    {
        var bodyHash = Sha256Hex(body ?? string.Empty);
        var payload = $"{method.ToUpperInvariant()}\n{path}\n{ts}\n{bodyHash}";
        var key = Convert.FromBase64String(NormalizeSecret(sharedSecret));
        using var hmac = new HMACSHA256(key);
        var hash = hmac.ComputeHash(Encoding.UTF8.GetBytes(payload));
        return Convert.ToHexString(hash).ToLowerInvariant();
    }

    private static string NormalizeSecret(string s)
    {
        // SharedSecret 存的是 base64。容错：非法 base64 时按 UTF8 兜底（不应发生，但避免抛异常）。
        try { _ = Convert.FromBase64String(s); return s; }
        catch { return Convert.ToBase64String(Encoding.UTF8.GetBytes(s)); }
    }

    private static string Sha256Hex(string s)
    {
        using var sha = SHA256.Create();
        return Convert.ToHexString(sha.ComputeHash(Encoding.UTF8.GetBytes(s ?? string.Empty))).ToLowerInvariant();
    }

    /// <summary>生成一个新的 32 字节共享密钥（base64）。</summary>
    public static string GenerateSharedSecret()
        => Convert.ToBase64String(RandomNumberGenerator.GetBytes(32));

    /// <summary>生成一个高熵一次性配对码（URL-safe）。</summary>
    public static string GeneratePairingCode()
        => Convert.ToBase64String(RandomNumberGenerator.GetBytes(18))
            .Replace("+", "-").Replace("/", "_").TrimEnd('=');
}
