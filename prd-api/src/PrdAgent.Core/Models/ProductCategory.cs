namespace PrdAgent.Core.Models;

/// <summary>
/// 产品管理智能体 — 产品类型（可增删改查管理，替代写死的 ProductGrade 枚举）。
///
/// 取代原先硬编码的「核心 / 重要 / 普通 / 实验」四值枚举：
/// 内置 4 项用固定 Id（core / important / normal / experimental）以兼容存量
/// Product.Grade 数据，可改名 / 改色 / 排序但不可删除；用户新增的类型用 Guid。
/// Product.Grade 字段即存本实体的 Id。
/// </summary>
public class ProductCategory
{
    /// <summary>主键（内置项用固定 key，自定义项用 Guid）</summary>
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>类型名称（如「核心」）</summary>
    public string Name { get; set; } = string.Empty;

    /// <summary>展示色（hex，如 #38bdf8）</summary>
    public string Color { get; set; } = "#9ca3af";

    /// <summary>排序（越小越靠前）</summary>
    public int SortOrder { get; set; }

    /// <summary>是否内置（内置项可改名/改色/排序，不可删除）</summary>
    public bool IsBuiltin { get; set; }

    /// <summary>软删除标记</summary>
    public bool IsDeleted { get; set; }

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;

    /// <summary>内置 4 项的种子定义（首次访问时 find-or-create）。Id 与旧 ProductGrade 常量对齐。</summary>
    public static readonly ProductCategory[] BuiltinSeeds =
    {
        new() { Id = ProductGrade.Core,         Name = "核心", Color = "#38bdf8", SortOrder = 0, IsBuiltin = true },
        new() { Id = ProductGrade.Important,    Name = "重要", Color = "#f59e0b", SortOrder = 1, IsBuiltin = true },
        new() { Id = ProductGrade.Normal,       Name = "普通", Color = "#9ca3af", SortOrder = 2, IsBuiltin = true },
        new() { Id = ProductGrade.Experimental, Name = "实验", Color = "#a78bfa", SortOrder = 3, IsBuiltin = true },
    };
}
