using System.Security.Cryptography;
using System.Text;

namespace PrdAgent.Infrastructure.Services;

/// <summary>
/// 分享链接密码加密 + 校验 + 失败锁 服务。
///
/// 用途：取代原先各 Controller 里 <c>providedPwd == share.Password</c> 的明文字符串比对。
/// 三件事一起做：
///   1. 密码用 PBKDF2-SHA256 + 16 bytes 随机盐做 100_000 轮迭代后存 Hash（足以抵抗离线彩虹表）
///   2. 校验走 <see cref="CryptographicOperations.FixedTimeEquals"/>，避免时序侧信道
///   3. 失败次数累计达阈值即锁定一段时间，遏制在线枚举密码
///
/// 历史背景：2026-05-20 用户审计发现 4 个分享体系（webpage/report/document-store/workflow）
/// 的密码都是明文存储 + 普通字符串比对 + 无失败锁。本服务统一收口安全策略，调用方只暴露
/// "校验"和"哈希"两个动词。
///
/// 旧数据兼容：本服务**不**关心旧分享的明文密码。调用方在 PasswordHash 为空时自行走
/// 明文比对回退路径，由 <see cref="ConstantTimeStringEquals"/> 保证那一路也是恒时比对。
/// </summary>
public interface ISharePasswordService
{
    /// <summary>
    /// 为新分享生成 (hash, salt) 对。盐 16 bytes，hash 32 bytes，都 base64 编码。
    /// 调用方应当同时把明文塞进 Password 字段供"按密码去重展示给分享者"，把 hash/salt
    /// 塞进 PasswordHash/PasswordSalt 供后续校验。
    /// </summary>
    SharePasswordHash Hash(string password);

    /// <summary>
    /// 恒时比对 hash。返回 true 即密码正确。
    /// 注意：这里只校验"密码对不对"，不处理失败计数；调用方拿到结果后自行调
    /// <see cref="ShouldLock"/> + 更新 FailedAttempts/LockedUntil。
    /// </summary>
    bool Verify(string password, string storedHash, string storedSalt);

    /// <summary>
    /// 旧分享专用：恒时明文比对。等价于 <c>a == b</c> 但走 FixedTimeEquals，
    /// 长度不同也不会通过字符串短路提前 return（虽然长度本身也算泄露 1 bit，
    /// 但比 == 操作符的逐字符短路安全得多）。
    /// </summary>
    bool ConstantTimeStringEquals(string a, string b);

    /// <summary>
    /// 滑动窗口速率限制（不按 IP，按分享链接）。
    /// 调用方传入该分享链接的"最近尝试时间戳列表"，本方法负责：
    /// 1. 清理 > Window 的过期条目（返回值里的 PrunedAttempts 是清理后列表）
    /// 2. 判断剩余条目数是否已达 MaxAttempts 上限
    /// 3. 如已达上限，给出还需等待多久才能再试（RetryAfter）
    /// 4. 否则把当前 UtcNow 追加进去（PrunedAttempts 含本次）
    ///
    /// 为什么不按 IP？容器 / 反向代理 / 局域网 NAT 共享出口 IP 都会让 IP 限速失真 ——
    /// per-shareLink 限速对正常用户最友好（哪怕同事粗心，也只锁该分享链接的访问者，
    /// 不会"我能进 Slack 但不能开链接"），且攻击者拿到链接的复用价值也只能针对这一条。
    /// </summary>
    /// <param name="recentAttempts">该 ShareLink 上记录的最近尝试时间戳（UTC）</param>
    RateLimitResult CheckRateLimit(IReadOnlyList<DateTime> recentAttempts);
}

/// <summary>速率限制结果。Allowed=false 时 RetryAfter 给前端做倒计时</summary>
public readonly record struct RateLimitResult(
    bool Allowed,
    TimeSpan RetryAfter,
    List<DateTime> PrunedAttempts);

/// <summary>Hash 结果：base64 hash + base64 salt</summary>
public readonly record struct SharePasswordHash(string Hash, string Salt);

public class SharePasswordService : ISharePasswordService
{
    /// <summary>PBKDF2 迭代次数。100_000 是 OWASP 2023 给 SHA-256 的最低推荐</summary>
    private const int Iterations = 100_000;
    private const int SaltBytes = 16;
    private const int HashBytes = 32;

    /// <summary>速率限制窗口长度</summary>
    public static readonly TimeSpan RateLimitWindow = TimeSpan.FromMinutes(1);

    /// <summary>
    /// 窗口内最大尝试次数。10 是凡人输入上限（手输 6 字符密码每分钟也试不到 10 次），
    /// 攻击者每分钟 10 次 × 12 位强密码（78 bits 熵）= 数十年才能暴破。
    /// </summary>
    public const int MaxAttemptsPerWindow = 10;

    public SharePasswordHash Hash(string password)
    {
        var salt = RandomNumberGenerator.GetBytes(SaltBytes);
        var hash = Rfc2898DeriveBytes.Pbkdf2(
            Encoding.UTF8.GetBytes(password),
            salt,
            Iterations,
            HashAlgorithmName.SHA256,
            HashBytes);
        return new SharePasswordHash(Convert.ToBase64String(hash), Convert.ToBase64String(salt));
    }

    public bool Verify(string password, string storedHash, string storedSalt)
    {
        if (string.IsNullOrEmpty(storedHash) || string.IsNullOrEmpty(storedSalt))
            return false;
        byte[] saltBytes, expectedBytes;
        try
        {
            saltBytes = Convert.FromBase64String(storedSalt);
            expectedBytes = Convert.FromBase64String(storedHash);
        }
        catch (FormatException)
        {
            // 存量记录格式坏掉时（理论上不会出现）一律视为校验失败，不抛出
            return false;
        }
        var actualBytes = Rfc2898DeriveBytes.Pbkdf2(
            Encoding.UTF8.GetBytes(password),
            saltBytes,
            Iterations,
            HashAlgorithmName.SHA256,
            HashBytes);
        return CryptographicOperations.FixedTimeEquals(actualBytes, expectedBytes);
    }

    public bool ConstantTimeStringEquals(string a, string b)
    {
        if (a == null || b == null) return false;
        var ab = Encoding.UTF8.GetBytes(a);
        var bb = Encoding.UTF8.GetBytes(b);
        if (ab.Length != bb.Length) return false;
        return CryptographicOperations.FixedTimeEquals(ab, bb);
    }

    public RateLimitResult CheckRateLimit(IReadOnlyList<DateTime> recentAttempts)
    {
        var now = DateTime.UtcNow;
        var cutoff = now - RateLimitWindow;
        // 只保留窗口内的尝试，过期的丢弃。攻击者等过窗口就能重新尝试，但凡人也一样能继续操作
        var pruned = (recentAttempts ?? Array.Empty<DateTime>())
            .Where(t => t > cutoff)
            .ToList();
        if (pruned.Count >= MaxAttemptsPerWindow)
        {
            // 距最早的窗口内尝试满 1 分钟时，列表会自动缩短一个 —— 就是"还需等待的时间"
            var earliest = pruned.Min();
            var retryAfter = (earliest + RateLimitWindow) - now;
            if (retryAfter < TimeSpan.Zero) retryAfter = TimeSpan.FromSeconds(1);
            return new RateLimitResult(Allowed: false, retryAfter, pruned);
        }
        pruned.Add(now);
        return new RateLimitResult(Allowed: true, TimeSpan.Zero, pruned);
    }
}
