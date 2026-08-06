using System.Text.RegularExpressions;

namespace PrdAgent.LlmGw.Auth;

/// <summary>
/// 本地口令（用户名 + 口令直接登录）的准入判定。
///
/// 由来：MAP 一键登录会自动建号，用户名是 <c>map-{hash}</c>、口令是建号时随机生成的 48 字节，
/// 两个值都没有任何人知道。而改密端点无条件校验旧口令，于是这类账号既登不进来、也改不了口令——
/// 网关名义上是独立账号体系，实际上那把锁没有配钥匙。这里把「什么时候必须验旧口令」和
/// 「什么样的用户名可以被认领」抽成纯函数，两个判定都只有一处定义。
/// </summary>
public static class LocalPasswordPolicy
{
    public const int MinPasswordLength = 12;
    public const int MinUsernameLength = 3;
    public const int MaxUsernameLength = 32;

    /// <summary>
    /// 自动建号占用的用户名前缀。真人不得认领这个命名空间，
    /// 否则会与后续 SSO 建号撞名（撞上唯一索引后新用户直接建不出来）。
    /// </summary>
    public const string ReservedUsernamePrefix = "map-";

    private static readonly Regex UsernamePattern = new("^[a-z0-9][a-z0-9._-]*$", RegexOptions.Compiled);

    /// <summary>外部身份提供方建的账号（当前只有 MAP 联邦）。</summary>
    public static bool IsFederatedIdentity(string? identityProvider)
        => !string.IsNullOrWhiteSpace(identityProvider);

    /// <summary>
    /// 改密时是否必须校验旧口令。判据是「这次请求有没有别的方式证明过身份」，
    /// 不是「账号属于谁」——所以入参里有会话来源。
    ///
    /// 两种豁免，都建立在「坚持要旧口令拦不住任何人，只会把本人锁死」之上：
    /// 其一，会话由外部身份提供方（MAP 一键登录）换来——持有它的人此刻就能再走一遍 SSO，
    /// 旧口令没有增加任何门槛，却是忘记口令时唯一的回家路；
    /// 其二，联邦账号且真人从未设置过本地口令——库里的哈希是建号时随机生成的，没有人知道那个值。
    ///
    /// 用口令登录得到的会话一律照常校验：那种会话不证明 SSO 身份，豁免它等于让被盗会话可以直接改密。
    /// </summary>
    public static bool RequiresOldPassword(
        string? identityProvider,
        bool passwordChangedByUser,
        bool sessionFromFederatedLogin = false)
    {
        if (sessionFromFederatedLogin) return false;
        return !IsFederatedIdentity(identityProvider) || passwordChangedByUser;
    }

    /// <summary>
    /// 账号当前是否持有「有人知道的」口令。种子账号的口令来自部署环境变量，算知道；
    /// 联邦账号在真人设置之前不算。这是账号自身的属性，与本次会话怎么来的无关——
    /// 所以刻意不接会话来源，避免和 <see cref="RequiresOldPassword"/> 混为一谈。
    /// </summary>
    public static bool HasUsablePassword(string? identityProvider, bool passwordChangedByUser)
        => !IsFederatedIdentity(identityProvider) || passwordChangedByUser;

    /// <summary>
    /// 规范化真人认领的登录名：统一小写（登录查询区分大小写，不统一会出现看着一样却登不进的两个账号），
    /// 限定字符集与长度，并挡住自动建号保留前缀。
    /// </summary>
    public static bool TryNormalizeUsername(string? raw, out string normalized, out string? error)
    {
        normalized = (raw ?? string.Empty).Trim().ToLowerInvariant();
        if (normalized.Length is < MinUsernameLength or > MaxUsernameLength)
        {
            error = $"登录名需为 {MinUsernameLength}-{MaxUsernameLength} 位";
            return false;
        }
        if (!UsernamePattern.IsMatch(normalized))
        {
            error = "登录名只能用小写字母、数字、点、下划线和连字符，且需以字母或数字开头";
            return false;
        }
        if (normalized.StartsWith(ReservedUsernamePrefix, StringComparison.Ordinal))
        {
            error = $"{ReservedUsernamePrefix} 开头的登录名由一键登录自动占用，请换一个";
            return false;
        }
        error = null;
        return true;
    }
}
