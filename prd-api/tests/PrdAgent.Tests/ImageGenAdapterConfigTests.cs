using PrdAgent.Infrastructure.LLM;
using Xunit;
using Xunit.Abstractions;

namespace PrdAgent.Tests;

/// <summary>
/// 生图模型适配器配置测试
/// 用于打印所有配置的尺寸信息，方便与官方文档对照校验
/// </summary>
public class ImageGenAdapterConfigTests
{
    private readonly ITestOutputHelper _output;

    public ImageGenAdapterConfigTests(ITestOutputHelper output)
    {
        _output = output;
    }

    /// <summary>
    /// 打印所有适配器的尺寸配置（按分辨率分组）
    /// 运行命令: dotnet test --filter "FullyQualifiedName~PrintAllAdapterSizeConfigs" -- xunit.DiagnosticMessages=true
    /// </summary>
    [Fact]
    public void PrintAllAdapterSizeConfigs()
    {
        _output.WriteLine("========== 生图模型尺寸配置汇总 ==========");
        _output.WriteLine($"配置总数: {ImageGenModelConfigs.Configs.Count}");
        _output.WriteLine("");

        foreach (var config in ImageGenModelConfigs.Configs)
        {
            _output.WriteLine($"## {config.DisplayName} ({config.ModelIdPattern})");
            _output.WriteLine($"   Provider: {config.Provider}");
            
            if (!string.IsNullOrEmpty(config.OfficialDocUrl))
                _output.WriteLine($"   Doc URL: {config.OfficialDocUrl}");
            
            if (!string.IsNullOrEmpty(config.LastUpdated))
                _output.WriteLine($"   Last Updated: {config.LastUpdated}");
            
            _output.WriteLine($"   Constraint Type: {config.SizeConstraintType}");
            _output.WriteLine("");

            foreach (var (tier, sizes) in config.SizesByResolution)
            {
                if (sizes.Count == 0)
                {
                    _output.WriteLine($"   [{tier.ToUpper()}] (not supported)");
                }
                else
                {
                    _output.WriteLine($"   [{tier.ToUpper()}] {sizes.Count} sizes:");
                    foreach (var opt in sizes)
                    {
                        _output.WriteLine($"      - {opt.Size} ({opt.AspectRatio})");
                    }
                }
            }

            _output.WriteLine("");
            _output.WriteLine("-------------------------------------------");
            _output.WriteLine("");
        }
    }

    /// <summary>
    /// 验证所有配置的 SizesByResolution 结构完整性
    /// </summary>
    [Fact]
    public void AllConfigsHaveValidSizesByResolution()
    {
        foreach (var config in ImageGenModelConfigs.Configs)
        {
            Assert.NotNull(config.SizesByResolution);
            Assert.True(config.SizesByResolution.ContainsKey("1k"), $"{config.ModelIdPattern} missing 1k tier");
            Assert.True(config.SizesByResolution.ContainsKey("2k"), $"{config.ModelIdPattern} missing 2k tier");
            Assert.True(config.SizesByResolution.ContainsKey("4k"), $"{config.ModelIdPattern} missing 4k tier");

            // 确保至少有一个分辨率档位有尺寸
            var totalSizes = config.SizesByResolution.Values.Sum(x => x.Count);
            Assert.True(totalSizes > 0, $"{config.ModelIdPattern} has no sizes configured");

            // 验证每个尺寸选项都有效
            foreach (var (tier, sizes) in config.SizesByResolution)
            {
                foreach (var opt in sizes)
                {
                    Assert.False(string.IsNullOrEmpty(opt.Size), $"{config.ModelIdPattern}/{tier} has empty size");
                    Assert.False(string.IsNullOrEmpty(opt.AspectRatio), $"{config.ModelIdPattern}/{tier} has empty aspect ratio");
                    Assert.Matches(@"^\d+x\d+$", opt.Size); // 格式必须是 WxH
                    Assert.Matches(@"^\d+:\d+$", opt.AspectRatio); // 格式必须是 W:H
                }
            }
        }
    }

    /// <summary>
    /// 验证 GetAdapterInfo 返回正确的 SizesByResolution
    /// </summary>
    [Theory]
    [InlineData("doubao-seedream-4-5", true, 0, 7, 5)] // 4.5: 不支持1k, 2k有7个, 4k有5个
    [InlineData("doubao-seedream-4-0", true, 7, 5, 3)] // 4.0: 1k有7个, 2k有5个, 4k有3个
    [InlineData("doubao-seedream-3", true, 8, 0, 0)]   // 3.0: 1k有8个, 不支持2k/4k
    [InlineData("dall-e-3", true, 3, 0, 0)]            // DALL-E 3: 1k有3个, 不支持2k/4k
    [InlineData("unknown-model", false, 0, 0, 0)]      // 未知模型
    public void GetAdapterInfo_ReturnsSizesByResolution(
        string modelName, 
        bool shouldMatch,
        int expected1k, 
        int expected2k, 
        int expected4k)
    {
        var info = ImageGenModelAdapterRegistry.GetAdapterInfo(modelName);

        if (!shouldMatch)
        {
            Assert.Null(info);
            return;
        }

        Assert.NotNull(info);
        Assert.True(info.Matched);
        Assert.Equal(expected1k, info.SizesByResolution["1k"].Count);
        Assert.Equal(expected2k, info.SizesByResolution["2k"].Count);
        Assert.Equal(expected4k, info.SizesByResolution["4k"].Count);
    }

    /// <summary>
    /// 打印适配器信息的 JSON 格式（方便前端调试）
    /// </summary>
    [Theory]
    [InlineData("doubao-seedream-4-5")]
    [InlineData("nano-banana")]
    public void PrintAdapterInfoAsJson(string modelName)
    {
        var info = ImageGenModelAdapterRegistry.GetAdapterInfo(modelName);
        Assert.NotNull(info);

        _output.WriteLine($"Model: {modelName}");
        _output.WriteLine($"Adapter: {info.AdapterName}");
        _output.WriteLine("");
        _output.WriteLine("SizesByResolution:");
        
        foreach (var (tier, sizes) in info.SizesByResolution)
        {
            _output.WriteLine($"  \"{tier}\": [");
            foreach (var opt in sizes)
            {
                _output.WriteLine($"    {{ \"size\": \"{opt.Size}\", \"aspectRatio\": \"{opt.AspectRatio}\" }},");
            }
            _output.WriteLine("  ],");
        }
    }
}
