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
}
