using System.Security.Cryptography;
using System.Text;

namespace PrdAgent.Core.Models;

/// <summary>版本登记的系统主数据。</summary>
public sealed class VersionRegistrySystem
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string Name { get; set; } = string.Empty;
    /// <summary>用于去重的名称，不作为显示字段。</summary>
    public string NormalizedName { get; set; } = string.Empty;
    /// <summary>history_seed / manual。</summary>
    public string Source { get; set; } = VersionRegistrySource.Manual;
    public string CreatedBy { get; set; } = string.Empty;
    public string? CreatedByName { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}

/// <summary>版本登记的应用主数据；应用全局唯一且只归属一个系统。</summary>
public sealed class VersionRegistryApplication
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string SystemId { get; set; } = string.Empty;
    /// <summary>归属系统名称的主数据冗余，供检索和显示使用。</summary>
    public string SystemName { get; set; } = string.Empty;
    public string Name { get; set; } = string.Empty;
    /// <summary>应用名全局去重键；同名应用不能归属多个系统。</summary>
    public string NormalizedName { get; set; } = string.Empty;
    /// <summary>来源历史表的已知最高 T 号，仅作为首建序列基线。</summary>
    public string? InternalBaselineCode { get; set; }
    /// <summary>来源历史表的已知最高 V 号，仅作为首建序列基线。</summary>
    public string? FormalBaselineCode { get; set; }
    /// <summary>history_seed / manual。</summary>
    public string Source { get; set; } = VersionRegistrySource.Manual;
    public string CreatedBy { get; set; } = string.Empty;
    public string? CreatedByName { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}

/// <summary>版本登记使用的稳定名称键和主数据种子。</summary>
public static class VersionRegistryCatalog
{
    public static string NormalizeName(string? value) => string.Concat((value ?? string.Empty)
        .Trim()
        .Where(character => !char.IsWhiteSpace(character)))
        .ToUpperInvariant();

    public static string CreateSystemId(string normalizedName) => CreateStableId("version-registry-system", normalizedName);

    public static string CreateApplicationId(string normalizedName) => CreateStableId("version-registry-application", normalizedName);

    public static string CreateSequenceId(string prefix, string applicationId) => $"{prefix.ToUpperInvariant()}:{applicationId}";

    private static string CreateStableId(string category, string normalizedName)
    {
        var digest = SHA256.HashData(Encoding.UTF8.GetBytes($"{category}:{normalizedName}"));
        return $"{category}-{Convert.ToHexString(digest).ToLowerInvariant()}";
    }

    /// <summary>
    /// 由 2026-09-29 的 T/V 历史登记表归并而来；冲突应用以最新计划立项或上线日期所属系统为准。
    /// 仅保留主数据和每个应用的最高编号基线，完整历史仍通过导入快照保存。
    /// </summary>
    public static IReadOnlyList<string> InitialSystemNames { get; } = new List<string>
    {
        "产业路由器",
        "大数据引擎系统",
        "赋码采集关联系统",
        "平台支撑系统",
        "IMP",
    };

    /// <summary>
    /// 应用归属按冲突规则保留一个当前系统；系统目录独立于当前应用，避免历史系统因冲突处理而消失。
    /// </summary>
    public static IReadOnlyList<VersionRegistrySeed> InitialSeeds { get; } = new List<VersionRegistrySeed>
    {
        new("产业路由器", "新经销助手", "T1.7.0", "V1.6.1"),
        new("产业路由器", "业务帮帮", "T1.2.2", "V1.2.2"),
        new("产业路由器", "掌柜云助手", null, "V3.0.0"),
        new("大数据引擎系统", "帮助中心", "T2.8.0", "V1.0.0"),
        new("大数据引擎系统", "防窜物流", "T3.3.6", "V3.3.8"),
        new("大数据引擎系统", "互动营销", "T3.48.0", "V3.33.0"),
        new("大数据引擎系统", "会员小程序", "T2.6.11", "V2.5.10"),
        new("大数据引擎系统", "金牌导购员", "T1.5.1", "V1.3.0"),
        new("大数据引擎系统", "品牌商后台基础", "T6.18.9", "V4.26.1"),
        new("大数据引擎系统", "商户助手小程序", "T0.1.0", null),
        new("大数据引擎系统", "社交云店", "T1.16.5", "V1.18.4"),
        new("大数据引擎系统", "外勤管理", "T0.1.0", "V0.1.0"),
        new("大数据引擎系统", "万能零售助手", "T3.7.8", "V3.4.5"),
        new("大数据引擎系统", "微商城", null, null),
        new("大数据引擎系统", "微商控价", "T3.2.0", "V3.2.0"),
        new("大数据引擎系统", "智能营销", "T3.1.20", "V2.14.15"),
        new("大数据引擎系统", "DCRM", "T1.4.3", "V1.4.2"),
        new("赋码采集关联系统", "赋码采集关联系统", "T1.2.0", null),
        new("平台支撑系统", "米多总后台", "T3.14.2", "V3.13.1"),
        new("平台支撑系统", "企微助手", null, null),
        new("IMP", "IMP助手", "T0.1.0", null),
    };
}

public sealed record VersionRegistrySeed(string SystemName, string ApplicationName, string? InternalBaselineCode, string? FormalBaselineCode);

public static class VersionRegistrySource
{
    public const string HistorySeed = "history_seed";
    public const string Manual = "manual";
}

/// <summary>
/// 产品评审智能体内的版本登记记录。
/// T 与 V 是独立编号空间；登记字段以原有立项/上线登记表为准。
/// </summary>
public class VersionRegistration
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    /// <summary>登记时的系统主数据快照；旧历史数据可为空。</summary>
    public string? SystemId { get; set; }
    public string? SystemName { get; set; }
    /// <summary>登记时的应用主数据快照；新申请必须有值，旧历史数据可为空。</summary>
    public string? ApplicationId { get; set; }
    public string? ApplicationName { get; set; }
    /// <summary>internal（T）/ formal（V）</summary>
    public string Kind { get; set; } = VersionRegistrationKind.Internal;
    public string Code { get; set; } = string.Empty;
    /// <summary>正式版本关联的内部版本号；手工来源同样保留在此。</summary>
    public string? TCode { get; set; }
    /// <summary>review_submission / internal_registration / manual_t / history_import</summary>
    public string SourceType { get; set; } = VersionRegistrationSourceType.ReviewSubmission;
    public string? ReviewSubmissionId { get; set; }
    public string? SourceInternalRegistrationId { get; set; }

    public string ProjectType { get; set; } = "standard";
    public string VersionType { get; set; } = "minor";
    public bool? NeedUiDesign { get; set; }
    public bool? IsAiPoc { get; set; }
    public bool? IsGlobalOpen { get; set; }
    public string? DemandSource { get; set; }
    public string? PlanName { get; set; }
    public string? PlanUrl { get; set; }
    public string? RequirementDescription { get; set; }
    public string? DepartmentName { get; set; }
    public string? OwnerName { get; set; }
    public List<string> ProjectMemberNames { get; set; } = new();
    public DateTime? PlannedProjectAt { get; set; }
    public DateTime? PlannedReleaseAt { get; set; }
    public string? ContractParty { get; set; }
    public string? DevelopmentStatus { get; set; }
    public string? Remark { get; set; }

    /// <summary>completed；保留状态字段，便于后续扩展撤回/作废但不回收编号。</summary>
    public string Status { get; set; } = VersionRegistrationStatus.Completed;
    public string CreatedBy { get; set; } = string.Empty;
    public string? CreatedByName { get; set; }
    /// <summary>历史导入时关联的不可变快照。</summary>
    public string? SourceSnapshotId { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}

/// <summary>历史导入或当前登记簿的不可变存档。</summary>
public class VersionRegistrationSnapshot
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string Name { get; set; } = string.Empty;
    /// <summary>history_import / current_registry</summary>
    public string SourceType { get; set; } = VersionRegistrationSnapshotSourceType.CurrentRegistry;
    public string? SourceAttachmentId { get; set; }
    public string? SourceFileName { get; set; }
    public int ImportedCount { get; set; }
    public int SkippedCount { get; set; }
    public List<VersionRegistration> Records { get; set; } = new();
    public List<VersionRegistrationImportError> Errors { get; set; } = new();
    public string CreatedBy { get; set; } = string.Empty;
    public string? CreatedByName { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}

/// <summary>每个应用的 T/V 各有一条乐观并发序列，避免同时申领到同一编号。</summary>
public class VersionRegistrationSequence
{
    /// <summary>T:{applicationId} 或 V:{applicationId}，作为 Mongo _id 保证一条应用序列唯一。</summary>
    public string Id { get; set; } = string.Empty;
    public int Major { get; set; }
    public int Medium { get; set; }
    public int Minor { get; set; }
    public long Revision { get; set; }
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}

public class VersionRegistrationImportError
{
    public int Row { get; set; }
    public string Message { get; set; } = string.Empty;
}

public static class VersionRegistrationKind
{
    public const string Internal = "internal";
    public const string Formal = "formal";
}

public static class VersionRegistrationSourceType
{
    public const string ReviewSubmission = "review_submission";
    public const string InternalRegistration = "internal_registration";
    public const string ManualT = "manual_t";
    public const string HistoryImport = "history_import";
}

public static class VersionRegistrationSnapshotSourceType
{
    public const string HistoryImport = "history_import";
    public const string CurrentRegistry = "current_registry";
}

public static class VersionRegistrationStatus
{
    public const string Completed = "completed";
}
