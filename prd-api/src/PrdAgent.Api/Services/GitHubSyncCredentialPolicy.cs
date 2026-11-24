using PrdAgent.Infrastructure.GitHub;

namespace PrdAgent.Api.Services;

/// <summary>一次目录同步要用的 GitHub 凭据：匿名 / 已授权 / 明确阻断。</summary>
public readonly record struct GitHubSyncCredential(string? Token, string? BlockReason, bool HasConnection)
{
    public static GitHubSyncCredential Anonymous() => new(null, null, false);
    public static GitHubSyncCredential Authorized(string token) => new(token, null, true);
    public static GitHubSyncCredential Blocked(string reason) => new(null, reason, true);

    /// <summary>写进日志的一个词，让「这一轮到底带没带授权」在事后可查。</summary>
    public string Mode => BlockReason != null ? "blocked" : Token != null ? "authorized" : "anonymous";
}

/// <summary>
/// 「这条 GitHub 目录订阅这一轮该用什么凭据」的唯一判据。
///
/// 核心一条：**盖过连接身份的条目，解不出 token 时不许退回匿名**。
/// GitHub 对无权访问的私有仓返回的是 404 而不是 403，所以静默降级的后果
/// 不是「少了点什么」，而是用户收到一个和「目录不存在」无法区分的错误，
/// 等五分钟等不到任何文档也说不清为什么（2026-09-09 验收 P1 就是这么来的）。
///
/// 抽成纯函数是为了能被单测直接打红：谁把降级写回去，这里立刻变红。
/// </summary>
public static class GitHubSyncCredentialPolicy
{
    public const string DisconnectedReason =
        "GitHub 授权已断开：这条同步是用某个 GitHub 账号建立的，该账号的连接已不存在。请在知识库里重新连接 GitHub 后再试。";

    public const string ExpiredReason =
        "GitHub 授权已失效，请在知识库里重新连接 GitHub 账号后再试。";

    public const string UnreadableReason =
        "GitHub 授权凭据无法读取（可能是平台密钥轮换导致），请重新连接 GitHub 账号后再试。";

    /// <summary>
    /// 手贴 URL 建订阅时，这个用户的 GitHub 连接当下能不能用。
    /// <c>Unknown</c> 是网络抖动这类**没问出结论**的情况，不是「不能用」。
    /// </summary>
    public enum ConnectionUsability { Usable, Revoked, Unknown }

    /// <summary>
    /// 手贴 URL 的订阅要不要盖上连接身份。
    ///
    /// 盖了就意味着同步一定带 token（解不出来会按上面的规则**阻断**，不退回匿名）。
    /// 所以「连接记录还在、但用户已经在 GitHub 那边撤销了授权」这一种必须不盖：
    /// 公开仓本来匿名就能同步，盖上去反而每天必然 401——把本来能用的路径改坏了。
    /// 而问不出结论（网络抖动）时保持盖章：那才是保住私有仓的一侧，
    /// 且失败会以可诊断的授权错误出现，不会退化成与「目录不存在」无法区分的 404。
    /// </summary>
    public static bool ShouldStampConnection(bool hasConnectionRecord, ConnectionUsability usability)
        => hasConnectionRecord && usability != ConnectionUsability.Revoked;

    /// <summary>条目上是否盖了「用某个用户的 GitHub 连接来同步」的身份。</summary>
    public static bool HasConnectionStamp(string? connectionUserId)
        => !string.IsNullOrWhiteSpace(connectionUserId);

    /// <summary>
    /// 给出这一轮的凭据。<paramref name="resolvedToken"/> 与 <paramref name="failure"/> 二选一：
    /// 前者非空即已授权；两者都空表示解密等非领域异常。
    /// </summary>
    public static GitHubSyncCredential Decide(
        string? connectionUserId,
        string? resolvedToken,
        GitHubException? failure)
    {
        if (!HasConnectionStamp(connectionUserId))
            return GitHubSyncCredential.Anonymous();

        if (!string.IsNullOrEmpty(resolvedToken))
            return GitHubSyncCredential.Authorized(resolvedToken!);

        var reason = failure?.Code switch
        {
            GitHubErrorCodes.GITHUB_NOT_CONNECTED => DisconnectedReason,
            GitHubErrorCodes.GITHUB_TOKEN_EXPIRED => ExpiredReason,
            null => UnreadableReason,
            _ => ExpiredReason,
        };
        return GitHubSyncCredential.Blocked(reason);
    }
}
