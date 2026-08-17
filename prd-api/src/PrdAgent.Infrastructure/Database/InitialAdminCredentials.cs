using Microsoft.Extensions.Configuration;
using PrdAgent.Core.Services;

namespace PrdAgent.Infrastructure.Database;

/// <summary>
/// 首次建库与显式用户初始化共用的管理员凭据解析入口。
/// </summary>
public sealed record InitialAdminCredentials(string Username, string Password)
{
    public const string UsernameKey = "MAP_INITIAL_ADMIN_USERNAME";
    public const string PasswordKey = "MAP_INITIAL_ADMIN_PASSWORD";
    private const string RootUsernameKey = "ROOT_ACCESS_USERNAME";
    private const string RootPasswordKey = "ROOT_ACCESS_PASSWORD";

    public static InitialAdminCredentials Resolve(IConfiguration configuration)
    {
        var configuredUsername = (configuration[UsernameKey] ?? string.Empty).Trim();
        var configuredPassword = configuration[PasswordKey] ?? string.Empty;
        var hasDedicatedValue = !string.IsNullOrWhiteSpace(configuredUsername)
            || !string.IsNullOrWhiteSpace(configuredPassword);

        if (hasDedicatedValue)
        {
            return ValidatePair(configuredUsername, configuredPassword, UsernameKey, PasswordKey);
        }

        var rootUsername = (configuration[RootUsernameKey] ?? string.Empty).Trim();
        var rootPassword = configuration[RootPasswordKey] ?? string.Empty;
        var hasRootValue = !string.IsNullOrWhiteSpace(rootUsername)
            || !string.IsNullOrWhiteSpace(rootPassword);
        if (hasRootValue)
        {
            return ValidatePair(rootUsername, rootPassword, RootUsernameKey, RootPasswordKey);
        }

        throw new InvalidOperationException(
            $"首次管理员凭据未配置。请同时设置 {UsernameKey} 和 {PasswordKey}，再重试初始化。");
    }

    private static InitialAdminCredentials ValidatePair(
        string username,
        string password,
        string usernameKey,
        string passwordKey)
    {
        if (string.IsNullOrWhiteSpace(username) || string.IsNullOrWhiteSpace(password))
        {
            throw new InvalidOperationException(
                $"管理员凭据必须成对配置：{usernameKey} 与 {passwordKey} 缺一不可。");
        }

        if (username.Length is < 4 or > 32
            || !username.All(ch => char.IsAsciiLetterOrDigit(ch) || ch == '_'))
        {
            throw new InvalidOperationException(
                $"{usernameKey} 必须为 4 至 32 位字母、数字或下划线。");
        }

        var passwordError = PasswordValidator.Validate(password);
        if (passwordError is not null)
        {
            throw new InvalidOperationException($"{passwordKey} 不符合密码强度要求：{passwordError}");
        }

        return new InitialAdminCredentials(username, password);
    }
}
