namespace PrdAgent.Core.Models;

public static class AdminNotificationSections
{
    public const string Personal = "personal";
    public const string Admin = "admin";

    public static string Normalize(string? section)
    {
        var value = (section ?? string.Empty).Trim().ToLowerInvariant();
        return value switch
        {
            Personal => Personal,
            Admin => Admin,
            _ => Personal,
        };
    }

    public static string Label(string? section)
    {
        return Normalize(section) == Admin ? "管理员通知" : "个人通知";
    }
}

public sealed record AdminNotificationSourceDefinition(
    string Source,
    string Label,
    string Section,
    string Description);

/// <summary>
/// 通知来源目录。新增站内通知来源时必须在这里登记来源、归属分区和用途。
/// 个人通知是用户自己的工作流消息；管理员通知是系统运营、额度、VOC、网关等管理消息。
/// </summary>
public static class AdminNotificationSourceCatalog
{
    private static readonly AdminNotificationSourceDefinition[] SourceDefinitions =
    [
        new("defect-agent", "缺陷管理", AdminNotificationSections.Personal, "别人提交、指派、验收、AI 修复等与当前用户相关的缺陷通知"),
        new("report-agent", "周报月报", AdminNotificationSections.Personal, "周报、月报、日报提交、退回、审阅和协作通知"),
        new("pm-agent", "任务协作", AdminNotificationSections.Personal, "项目任务、待办协作和个人执行提醒"),
        new("review-agent", "评审协作", AdminNotificationSections.Personal, "评审、验收和代码审阅相关通知"),
        new("workflow-agent", "工作流", AdminNotificationSections.Personal, "工作流运行结果和个人处理事项"),
        new("shortcuts", "快捷指令", AdminNotificationSections.Personal, "快捷指令执行结果和个人提醒"),
        new("speech-to-text", "语音转文字", AdminNotificationSections.Personal, "语音转文字后生成的文本和处理结果"),
        new("voice-transcript", "语音转文字", AdminNotificationSections.Personal, "语音转文字后生成的文本和处理结果"),
        new("transcription", "语音转文字", AdminNotificationSections.Personal, "语音转写、会议纪要和个人文本生成结果"),
        new("weekly-report", "周报", AdminNotificationSections.Personal, "周报生成、提交和协作提醒"),
        new("monthly-report", "月报", AdminNotificationSections.Personal, "月报生成、提交和协作提醒"),

        new("admin-notice", "管理员站内信", AdminNotificationSections.Admin, "管理员公告、配置提醒和人工通知"),
        new("server-expiry", "服务器到期", AdminNotificationSections.Admin, "服务器、证书、域名和部署资源到期提醒"),
        new("system", "系统通知", AdminNotificationSections.Admin, "系统级通知和默认管理消息"),
        new("system-alert", "系统预警", AdminNotificationSections.Admin, "模型池、平台密钥、开放平台额度等运营告警"),
        new("platform-key-integrity", "平台密钥", AdminNotificationSections.Admin, "平台密钥完整性和配置风险提醒"),
        new("llm-gateway-quota", "模型额度", AdminNotificationSections.Admin, "模型网关额度不足、用量异常和计费风险"),
        new("open-platform", "开放平台", AdminNotificationSections.Admin, "开放平台额度、凭证和接入配置通知"),
        new("api-request-alert", "API 请求问题", AdminNotificationSections.Admin, "慢接口、错误率、调用失败和网关异常告警"),
        new("api-request-log", "API 请求日志", AdminNotificationSections.Admin, "API 请求日志和接口观测通知"),
        new("gateway-alert", "网关告警", AdminNotificationSections.Admin, "网关故障、限流和调用链路异常"),
        new("user-voice", "用户之声", AdminNotificationSections.Admin, "真实用户反馈、体验痛点和 VOC 运营消息"),
        new("team-activity-voice", "用户之声", AdminNotificationSections.Admin, "团队动态中的用户声音和反馈消息"),
        new("user-feedback", "用户反馈", AdminNotificationSections.Admin, "用户主动反馈和产品体验反馈"),
    ];

    private static readonly IReadOnlyDictionary<string, AdminNotificationSourceDefinition> DefinitionMap =
        SourceDefinitions.ToDictionary(x => x.Source, StringComparer.OrdinalIgnoreCase);

    public static IReadOnlyList<AdminNotificationSourceDefinition> Definitions { get; } = SourceDefinitions;

    public static IReadOnlyCollection<string> AllowedEventSources { get; } = SourceDefinitions
        .Select(x => x.Source)
        .ToArray();

    public static AdminNotificationSourceDefinition? Find(string? source)
    {
        var value = NormalizeSource(source);
        return string.IsNullOrWhiteSpace(value) ? null : DefinitionMap.GetValueOrDefault(value);
    }

    public static string ResolveSection(string? source, string? explicitSection = null)
    {
        if (!string.IsNullOrWhiteSpace(explicitSection))
            return AdminNotificationSections.Normalize(explicitSection);

        return Find(source)?.Section ?? AdminNotificationSections.Personal;
    }

    public static string ResolveSourceLabel(string? source)
    {
        var definition = Find(source);
        if (definition != null) return definition.Label;

        var value = NormalizeSource(source);
        return string.IsNullOrWhiteSpace(value) ? "未分类通知" : value;
    }

    public static string NormalizeSource(string? source)
    {
        return (source ?? string.Empty).Trim().ToLowerInvariant();
    }
}
