namespace PrdAgent.Infrastructure.GitHub;

/// <summary>
/// GitHub OAuth Device Flow (RFC 8628) 基础设施服务接口。
///
/// 定位：
///   和 <see cref="IGitHubClient"/> 同属 GitHub 基础设施层。
///   封装"per-user OAuth 授权"这一横切能力，让任何需要让用户用自己
///   GitHub 账号做事的应用（PR 审查、日报、其他检测等）都能直接注入使用。
///
/// 为什么用 Device Flow 而不是 Web Flow：
///   本项目部署在 CDS 动态域名（每分支一个 <c>&lt;branch&gt;.miduo.org</c>）。
///   Web Flow 要求 Callback URL 预先注册且不支持通配符，CDS 上根本不可用；
///   Device Flow 完全不需要 Callback URL，本地/CDS/生产共用一套代码，
///   是 <c>gh auth login</c> 同款机制。
///
/// 调用流程：
///   1. <see cref="StartDeviceFlowAsync"/> 返回 user_code + 签名过的 flow_token
///   2. 前端显示 user_code，引导用户在新标签页完成授权
///   3. <see cref="PollDeviceFlowAsync"/> 每几秒轮询一次，直到 Done / Expired / Denied
///   4. <see cref="FetchUserInfoAsync"/> 用得到的 access token 拉 GitHub 用户信息
///   5. 调用方把 (userId, GitHubLogin, access token) 持久化到
///      <see cref="PrdAgent.Core.Models.GitHubUserConnection"/>
///
/// 安全：
///   - <c>device_code</c> 永远不出后端——前端只看到 HMAC 签名的无状态 flow_token
///   - HMAC 密钥从 <c>Jwt:Secret</c> 取，启动时 fail-fast
///   - 多实例部署天然安全，无需共享 session
/// </summary>
public interface IGitHubOAuthService
{
    /// <summary>
    /// 向 GitHub 请求 device_code。
    /// 返回给前端的 flow_token 是签名后的 (device_code, userId, expiry) 三元组，
    /// 前端在 poll 时原样回传，后端验签后解出 device_code 继续和 GitHub 交互。
    /// </summary>
    Task<DeviceFlowStartResult> StartDeviceFlowAsync(string userId, CancellationToken ct);

    /// <summary>
    /// 验证 flow_token 并向 GitHub 轮询一次。返回规范化的结果枚举：
    /// Pending（继续轮询） / SlowDown（调大间隔） / Expired / Denied / Done(token)。
    /// </summary>
    Task<DeviceFlowPollResult> PollDeviceFlowAsync(
        string userId,
        string flowToken,
        CancellationToken ct);

    /// <summary>
    /// 用 access_token 拉取当前 GitHub 用户信息（login / id / avatar）。
    /// </summary>
    Task<GitHubUserInfo> FetchUserInfoAsync(string accessToken, CancellationToken ct);

    /// <summary>
    /// 在 GitHub 那边撤销**整份授权**（delete an app authorization）。
    ///
    /// 只删本地密文不等于用户"断开"了：GitHub 的已授权应用列表里那一条还在。
    /// 注意撤销单把 token 也不够——那只让这一把失效，应用仍然列在用户的授权清单里，
    /// 而按钮承诺的是"收回授权"。所以走的是删授权那个接口，它连带作废该应用签发的所有 token。
    ///
    /// 返回值是有限枚举而不是 bool：没撤成时调用方要如实告诉用户"本地已删、GitHub 那边没撤掉、
    /// 请自行去设置里移除"，不能假装成功（external-cause-first：要不要紧 + 下一步）。
    /// </summary>
    Task<GitHubTokenRevocation> RevokeTokenAsync(string accessToken, CancellationToken ct);
}

/// <summary>撤销 GitHub 授权的结果。五态，调用方必须逐个表态。</summary>
public enum GitHubTokenRevocation
{
    /// <summary>GitHub 已确认撤销（204）。</summary>
    Revoked,

    /// <summary>本地压根没有可撤的令牌（没连过 / 连接记录已空），不是失败，也没有要用户处理的事。</summary>
    NothingToRevoke,

    /// <summary>
    /// GitHub 回了 404：它不认这把令牌属于当前这个应用。
    ///
    /// 有两种可能，而且**分不开**——用户早已自己移除过（那就等于撤销成功），
    /// 或者本站的应用凭据在这把令牌签发之后换过（那把旧令牌在旧应用名下可能仍然有效）。
    /// 连接记录里没存签发它的应用身份，所以无从判断，一律按"未确认"报，请用户自己去看一眼。
    /// </summary>
    Unverified,

    /// <summary>没配 ClientSecret，撤销接口要求 Basic 认证，调不了。本地照删，但要说清 GitHub 侧没动。</summary>
    NotConfigured,

    /// <summary>调用失败（网络、GitHub 报错）。本地照删，但要说清 GitHub 侧没撤掉。</summary>
    Failed,
}
