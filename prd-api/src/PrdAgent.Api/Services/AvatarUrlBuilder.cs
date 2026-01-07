using PrdAgent.Core.Models;

namespace PrdAgent.Api.Services;

/// <summary>
/// 统一构造头像可渲染 URL：
/// - 数据库存 AvatarFileName（仅文件名，不含域名/路径）
/// - 各端展示需要 avatarUrl：由服务端按规则拼接后下发（desktop/第三方无需知道拼接规则）
/// </summary>
public static class AvatarUrlBuilder
{
    public const string AvatarPathPrefix = "icon/backups/head";
    public const string DefaultNoHeadFile = "nohead.png";

    private static readonly Dictionary<string, string> DefaultBotAvatarFiles = new()
    {
        ["pm"] = "bot_pm.gif",
        ["dev"] = "bot_dev.gif",
        ["qa"] = "bot_qa.gif",
    };

    public static string? Build(IConfiguration cfg, User? user)
    {
        if (cfg == null) return null;
        var baseUrl = (cfg["TENCENT_COS_PUBLIC_BASE_URL"] ?? string.Empty).Trim().TrimEnd('/');
        if (string.IsNullOrWhiteSpace(baseUrl)) return null;

        var file = ResolveAvatarFileName(user);
        if (string.IsNullOrWhiteSpace(file)) file = DefaultNoHeadFile;

        // 全局约束：COS 对象 key 必须全小写 [[memory:12726348]]
        file = file.Trim().ToLowerInvariant();

        return $"{baseUrl}/{AvatarPathPrefix}/{file}";
    }

    /// <summary>
    /// 根据 AvatarFileName 构造头像 URL（用于已知文件名的场景）
    /// </summary>
    public static string? Build(IConfiguration cfg, string? avatarFileName)
    {
        if (cfg == null) return null;
        var baseUrl = (cfg["TENCENT_COS_PUBLIC_BASE_URL"] ?? string.Empty).Trim().TrimEnd('/');
        if (string.IsNullOrWhiteSpace(baseUrl)) return null;

        var file = (avatarFileName ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(file)) file = DefaultNoHeadFile;

        // 全局约束：COS 对象 key 必须全小写
        file = file.ToLowerInvariant();

        return $"{baseUrl}/{AvatarPathPrefix}/{file}";
    }

    private static string ResolveAvatarFileName(User? user)
    {
        if (user == null) return DefaultNoHeadFile;

        // 1) 明确设置的头像文件名优先（支持 png/gif/webp 等；不强行固定后缀）
        var file = (user.AvatarFileName ?? string.Empty).Trim();
        if (!string.IsNullOrWhiteSpace(file)) return file;

        var username = (user.Username ?? string.Empty).Trim();
        var usernameLower = username.ToLowerInvariant();

        // 2) 机器人账号：兜底默认头像
        if (user.UserType == UserType.Bot || usernameLower.StartsWith("bot_"))
        {
            var kind = (user.BotKind?.ToString() ?? string.Empty).Trim().ToLowerInvariant();
            if (string.IsNullOrWhiteSpace(kind))
            {
                kind = usernameLower.StartsWith("bot_") ? usernameLower.Replace("bot_", "") : "";
            }

            if (!DefaultBotAvatarFiles.TryGetValue(kind, out file))
            {
                file = DefaultBotAvatarFiles["dev"];
            }

            return file;
        }

        // 3) 人类用户：默认固定规则为 {login}.png（即使对象不存在也能作为 src 占位；渲染失败由 nohead.png 兜底）
        if (!string.IsNullOrWhiteSpace(usernameLower))
        {
            return $"{usernameLower}.png";
        }

        // 4) 最终兜底：nohead.png
        return DefaultNoHeadFile;
    }
}


