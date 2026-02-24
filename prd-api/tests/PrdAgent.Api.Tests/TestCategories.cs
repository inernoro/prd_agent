namespace PrdAgent.Api.Tests;

/// <summary>
/// 测试分类常量
/// </summary>
/// <remarks>
/// 原则：默认所有测试都是 CI 测试，只标记需要排除的
///
/// 分类：
/// - Integration：需要真实外部服务（API、数据库）
/// - Manual：本地手动运行（压力测试、矩阵渲染、批量数据）
///
/// 用法：
/// - 需要真实外部服务的测试加 [Trait("Category", TestCategories.Integration)]
/// - 耗时/压力/本地专用测试加 [Trait("Category", TestCategories.Manual)]
/// - CI 运行: dotnet test --filter "Category!=Integration&amp;Category!=Manual"
/// - 本地全量: dotnet test
/// </remarks>
public static class TestCategories
{
    /// <summary>
    /// 集成测试 - 需要真实外部服务（API、数据库），CI 中排除
    /// </summary>
    public const string Integration = "Integration";

    /// <summary>
    /// 手动测试 - 耗时压力测试、矩阵渲染、批量数据等，仅本地手动运行
    /// </summary>
    public const string Manual = "Manual";
}
