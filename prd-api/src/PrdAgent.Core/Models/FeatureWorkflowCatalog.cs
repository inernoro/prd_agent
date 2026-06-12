namespace PrdAgent.Core.Models;

/// <summary>
/// MAP 内置「标准功能流程」目录：种子写入 MongoDB 与状态说明 SSOT。
/// </summary>
public static class FeatureWorkflowCatalog
{
    public const string WorkflowName = "标准功能流程";

    public const string Planned = "planned";
    public const string Developing = "developing";
    public const string Testing = "testing";
    public const string Released = "released";
    /// <summary>终态 Key 沿用 cancelled，展示名为「已下架」。</summary>
    public const string Delisted = "cancelled";

    public static readonly IReadOnlyDictionary<string, string> StateLabels = new Dictionary<string, string>
    {
        [Planned] = "规划中",
        [Developing] = "开发中",
        [Testing] = "测试中",
        [Released] = "已发布",
        [Delisted] = "已下架",
    };

    public static readonly IReadOnlyDictionary<string, string> StateDescriptions = new Dictionary<string, string>
    {
        [Planned] = "功能已登记并纳入产品能力库，待排入本版本开发计划",
        [Developing] = "功能正在本版本内开发实现",
        [Testing] = "功能开发已完成，进入测试与验收",
        [Released] = "功能已随本版本正式发布上线",
        [Delisted] = "功能规划调整或不再提供，已从产品中下架（保留历史记录）",
    };
}
