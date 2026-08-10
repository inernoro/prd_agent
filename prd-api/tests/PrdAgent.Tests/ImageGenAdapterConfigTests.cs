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

            var totalSizes = config.SizesByResolution.Values.Sum(x => x.Count);
            if (config.SizesNotApplicable)
            {
                // 不存在"选尺寸"的模型（语义分层等）本就没有尺寸可列。
                // 豁免必须彻底：声明了不适用却又配了尺寸，说明两处判据打架，照样判红。
                Assert.True(totalSizes == 0,
                    $"{config.ModelIdPattern} 声明 SizesNotApplicable，却配了 {totalSizes} 个尺寸选项");
            }
            else
            {
                // 会进尺寸选择器的模型，至少要有一个分辨率档位有尺寸
                Assert.True(totalSizes > 0, $"{config.ModelIdPattern} has no sizes configured");
            }

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

    [Fact]
    public void AdaptiveConfigs_DistinguishPromptTransportFromSizeNotApplicable()
    {
        var promptTransport = ImageGenModelAdapterRegistry.TryMatch("gpt-image-2-all");
        Assert.NotNull(promptTransport);
        Assert.Equal(SizeConstraintTypes.Adaptive, promptTransport.SizeConstraintType);
        Assert.Equal(SizeParamFormats.None, promptTransport.SizeParamFormat);
        Assert.False(promptTransport.SizesNotApplicable);
        Assert.Contains(promptTransport.SizesByResolution["1k"], x => x.AspectRatio == "3:4" && x.Size == "768x1024");

        var sizeNotApplicable = ImageGenModelAdapterRegistry.TryMatch("fal-qwen-image-layered");
        Assert.NotNull(sizeNotApplicable);
        Assert.True(sizeNotApplicable.SizesNotApplicable);
    }

    [Fact]
    public void OpenRouterGptImage2_UsesSamePromptSizeTransport()
    {
        var config = ImageGenModelAdapterRegistry.TryMatch("openai/gpt-image-2");

        Assert.NotNull(config);
        Assert.Equal(SizeConstraintTypes.Adaptive, config.SizeConstraintType);
        Assert.Equal(SizeParamFormats.None, config.SizeParamFormat);
        Assert.False(config.SizesNotApplicable);
        Assert.Contains(config.SizesByResolution["1k"], x => x.AspectRatio == "3:4" && x.Size == "768x1024");
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
