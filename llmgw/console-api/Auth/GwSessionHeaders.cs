namespace PrdAgent.LlmGw.Auth;

/// <summary>
/// 滑动续期用的响应头：会话被自动延长时，服务端把新 token 通过这两个头下发，
/// 前端替换本地会话即可，无需重新登录、也无需前端定时轮询。
/// </summary>
public static class GwSessionHeaders
{
    /// <summary>换发的新 token（仅在本次请求触发续期时出现）。</summary>
    public const string Token = "X-Gw-Token";

    /// <summary>新 token 的过期时间（ISO-8601 UTC）。</summary>
    public const string TokenExpiresAt = "X-Gw-Token-Expires-At";
}
