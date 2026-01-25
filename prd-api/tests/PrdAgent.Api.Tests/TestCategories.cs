namespace PrdAgent.Api.Tests;

/// <summary>
/// 测试分类常量定义
/// </summary>
/// <remarks>
/// 使用方式：
/// - CI测试：[Trait("Category", TestCategories.CI)]
/// - 集成测试：[Trait("Category", TestCategories.Integration)]
///
/// 运行命令：
/// - 仅CI测试：dotnet test --filter "Category=CI"
/// - 仅集成测试：dotnet test --filter "Category=Integration"
/// - 排除集成测试：dotnet test --filter "Category!=Integration"
/// </remarks>
public static class TestCategories
{
    /// <summary>
    /// CI测试 - 使用内存数据，无外部依赖，适合自动化CI流程
    /// </summary>
    public const string CI = "CI";

    /// <summary>
    /// 集成测试 - 需要真实外部服务（数据库、云存储等），需配置环境变量
    /// </summary>
    public const string Integration = "Integration";

    /// <summary>
    /// 单元测试 - 纯内存计算，无I/O依赖
    /// </summary>
    public const string Unit = "Unit";

    /// <summary>
    /// 图像处理测试 - 涉及图像生成/处理
    /// </summary>
    public const string Image = "Image";

    /// <summary>
    /// 并发测试 - 验证线程安全
    /// </summary>
    public const string Concurrency = "Concurrency";
}
