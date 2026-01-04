namespace PrdAgent.Api.Models.Responses;

/// <summary>
/// 初始化群内默认机器人账号响应
/// </summary>
public class BootstrapGroupBotsResponse
{
    public string GroupId { get; set; } = string.Empty;
    public List<GroupMemberResponse> Bots { get; set; } = new();
}


