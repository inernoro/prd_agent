namespace PrdAgent.Core.Models;

/// <summary>
/// 产品管理智能体 — 需求与缺陷互转、产品缺陷 / 非产品缺陷划分常量。
/// </summary>
public static class ProductDefectLinkageCatalog
{
    /// <summary>需求 FormData：勾选「产品缺陷」时写入该 key，值为 <see cref="RequirementProductDefectValue"/>。</summary>
    public const string RequirementProductDefectFormKey = "产品缺陷";

    public const string RequirementProductDefectValue = "是";

    /// <summary>缺陷划分：产品缺陷（默认）。</summary>
    public const string ProductDefect = "缺陷";

    /// <summary>缺陷划分：非产品缺陷。</summary>
    public const string NonProductDefect = "非产品缺陷";

    public static readonly string[] AllClassifications = { ProductDefect, NonProductDefect };

    public static string NormalizeClassification(string? value)
        => value == NonProductDefect ? NonProductDefect : ProductDefect;

    public static bool IsProductDefectRequirement(Dictionary<string, string>? formData)
        => formData != null
           && formData.TryGetValue(RequirementProductDefectFormKey, out var v)
           && v == RequirementProductDefectValue;
}
