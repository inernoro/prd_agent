namespace PrdAgent.Api.Tests;

/// <summary>
/// 测试分类常量
/// </summary>
/// <remarks>
/// 原则：默认所有测试都是 CI 测试，只标记需要排除的
///
/// 用法：
/// - 需要真实外部服务的测试加 [Trait("Category", TestCategories.Integration)]
/// - CI 运行: dotnet test --filter "Category!=Integration"
/// - 本地全量: dotnet test
/// </remarks>
public static class TestCategories
{
    /// <summary>
    /// 集成测试 - 需要真实外部服务，CI 中排除
    /// </summary>
    public const string Integration = "Integration";
}
