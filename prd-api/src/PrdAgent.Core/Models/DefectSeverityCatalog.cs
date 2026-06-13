namespace PrdAgent.Core.Models;

/// <summary>
/// 产品管理缺陷严重程度（V2.6 四档）。SSOT：StructuredData[TapdDefectFieldCatalog.DefectSeverity]。
/// TAPD 导出列「严重程度」五档（紧急/高/中/低/无关紧要）仅在有原文时映射；无值不推断。
/// </summary>
public static class DefectSeverityCatalog
{
    public const string LevelFatal = "致命";
    public const string LevelSerious = "严重";
    public const string LevelNormal = "一般";
    public const string LevelMinor = "轻微";

    public static readonly string[] AllLevels = { LevelFatal, LevelSerious, LevelNormal, LevelMinor };

    /// <summary>TAPD「严重程度」五档 → V2.6 四档；无法识别或为空时返回 null。</summary>
    public static string? TryNormalizeTapdToLevel(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw)) return null;
        var text = raw.Trim();
        if (AllLevels.Contains(text)) return text;

        return text switch
        {
            "紧急" => LevelFatal,
            "高" => LevelSerious,
            "中" => LevelNormal,
            "低" or "无关紧要" => LevelMinor,
            _ => null,
        };
    }

    public static Dictionary<string, string> BuildImportStructuredPatch(string? rawTapdSeverity, string? level)
    {
        var patch = new Dictionary<string, string>();
        if (!string.IsNullOrWhiteSpace(level) && AllLevels.Contains(level))
            patch[TapdDefectFieldCatalog.DefectSeverity] = level;
        if (!string.IsNullOrWhiteSpace(rawTapdSeverity))
            patch[TapdDefectFieldCatalog.TapdSeveritySource] = rawTapdSeverity.Trim();
        return patch;
    }
}
