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
        var existing = await _db.AppSettings.Find(s => s.Id == "global").FirstOrDefaultAsync(ct);
        if (existing != null && !string.IsNullOrWhiteSpace(existing.MapInstanceId))
            return existing.MapInstanceId!;

        var newId = Guid.NewGuid().ToString("N");
        var update = Builders<AppSettings>.Update
            .SetOnInsert(s => s.MapInstanceId, newId)
            .SetOnInsert(s => s.UpdatedAt, DateTime.UtcNow);
        await _db.AppSettings.UpdateOneAsync(
            s => s.Id == "global", update, new UpdateOptions { IsUpsert = true }, ct);
        var reloaded = await _db.AppSettings.Find(s => s.Id == "global").FirstOrDefaultAsync(ct);
        return reloaded?.MapInstanceId ?? newId;
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
        // 常量时间比较，防时序侧信道
        return CryptographicOperations.FixedTimeEquals(
            Encoding.UTF8.GetBytes(expected), Encoding.UTF8.GetBytes(sign));
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
