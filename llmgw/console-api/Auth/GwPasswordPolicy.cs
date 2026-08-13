namespace PrdAgent.LlmGw.Auth;

/// <summary>
/// 网关本地账号的口令最低强度规则。
/// </summary>
public static class GwPasswordPolicy
{
    public const int MinimumLength = 12;

    public static bool MeetsMinimumLength(string? password) =>
        !string.IsNullOrWhiteSpace(password) && password.Length >= MinimumLength;
}
