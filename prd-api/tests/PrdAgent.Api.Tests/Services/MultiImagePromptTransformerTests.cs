using PrdAgent.Infrastructure.Services;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

/// <summary>
/// MultiImagePromptTransformer 单元测试
///
/// 测试用户输入到模型 prompt 的转换逻辑
/// </summary>
public class MultiImagePromptTransformerTests
{
    #region ExtractRefIds 测试

    [Fact]
    public void ExtractRefIds_SingleRef_ReturnsOne()
    {
        var result = MultiImagePromptTransformer.ExtractRefIds("让@img12变成卡通风格");

        Assert.Single(result);
        Assert.Equal(12, result[0]);
    }

    [Fact]
    public void ExtractRefIds_MultipleRefs_ReturnsInOrder()
    {
        var result = MultiImagePromptTransformer.ExtractRefIds("让@img12打@img9");

        Assert.Equal(2, result.Count);
        Assert.Equal(12, result[0]); // 先出现
        Assert.Equal(9, result[1]);  // 后出现
    }

    [Fact]
    public void ExtractRefIds_DuplicateRefs_Deduplicated()
    {
        var result = MultiImagePromptTransformer.ExtractRefIds("@img12 @img9 @img12 融合");

        Assert.Equal(2, result.Count);
        Assert.Equal(12, result[0]);
        Assert.Equal(9, result[1]);
        // @img12 出现两次，但只记录一次
    }

    [Fact]
    public void ExtractRefIds_NoRefs_ReturnsEmpty()
    {
        var result = MultiImagePromptTransformer.ExtractRefIds("普通文本没有引用");

        Assert.Empty(result);
    }

    [Fact]
    public void ExtractRefIds_EmptyInput_ReturnsEmpty()
    {
        Assert.Empty(MultiImagePromptTransformer.ExtractRefIds(""));
        Assert.Empty(MultiImagePromptTransformer.ExtractRefIds(null!));
        Assert.Empty(MultiImagePromptTransformer.ExtractRefIds("   "));
    }

    [Fact]
    public void ExtractRefIds_RefsAtDifferentPositions_AllExtracted()
    {
        // 头部
        var result1 = MultiImagePromptTransformer.ExtractRefIds("@img1@img2 融合");
        Assert.Equal(new[] { 1, 2 }, result1);

        // 尾部
        var result2 = MultiImagePromptTransformer.ExtractRefIds("融合 @img1@img2");
        Assert.Equal(new[] { 1, 2 }, result2);

        // 中间
        var result3 = MultiImagePromptTransformer.ExtractRefIds("把@img1放进@img2里");
        Assert.Equal(new[] { 1, 2 }, result3);

        // 分散
        var result4 = MultiImagePromptTransformer.ExtractRefIds("@img5 和 @img3 还有 @img7");
        Assert.Equal(new[] { 5, 3, 7 }, result4);
    }

    [Fact]
    public void ExtractRefIds_CaseInsensitive()
    {
        var result = MultiImagePromptTransformer.ExtractRefIds("@IMG1 @Img2 @img3");

        Assert.Equal(3, result.Count);
        Assert.Equal(new[] { 1, 2, 3 }, result);
    }

    #endregion

    #region Transform 测试

    [Fact]
    public void Transform_MultipleRefs_ReplacedByOrder()
    {
        var mapping = new Dictionary<int, int> { { 12, 1 }, { 9, 2 } };

        var result = MultiImagePromptTransformer.Transform("让@img12打@img9", mapping);

        Assert.Equal("让图1打图2", result);
    }

    [Fact]
    public void Transform_DuplicateRefs_SameOrderNumber()
    {
        var mapping = new Dictionary<int, int> { { 12, 1 }, { 9, 2 } };

        var result = MultiImagePromptTransformer.Transform("@img12 @img9 @img12 融合", mapping);

        Assert.Equal("图1 图2 图1 融合", result);
    }

    [Fact]
    public void Transform_UnknownRef_Preserved()
    {
        var mapping = new Dictionary<int, int> { { 12, 1 } };

        var result = MultiImagePromptTransformer.Transform("@img12 和 @img99", mapping);

        Assert.Equal("图1 和 @img99", result); // @img99 不在映射中，保持原样
    }

    [Fact]
    public void Transform_EmptyMapping_NoChange()
    {
        var result = MultiImagePromptTransformer.Transform("让@img12打@img9", new Dictionary<int, int>());

        Assert.Equal("让@img12打@img9", result);
    }

    [Fact]
    public void Transform_NoRefs_NoChange()
    {
        var mapping = new Dictionary<int, int> { { 12, 1 } };

        var result = MultiImagePromptTransformer.Transform("普通文本", mapping);

        Assert.Equal("普通文本", result);
    }

    [Fact]
    public void Transform_LargeRefId_Works()
    {
        var mapping = new Dictionary<int, int> { { 123456, 1 } };

        var result = MultiImagePromptTransformer.Transform("@img123456 很大的数字", mapping);

        Assert.Equal("图1 很大的数字", result);
    }

    #endregion

    #region TransformDirect 测试（一步完成）

    [Fact]
    public void TransformDirect_SimpleCase()
    {
        var result = MultiImagePromptTransformer.TransformDirect("让@img12打@img9");

        Assert.Equal("让图1打图2", result);
    }

    [Fact]
    public void TransformDirect_ComplexCase()
    {
        var result = MultiImagePromptTransformer.TransformDirect("把@img5放进@img3的背景里，然后加上@img5的风格");

        Assert.Equal("把图1放进图2的背景里，然后加上图1的风格", result);
    }

    [Fact]
    public void TransformDirect_ManyRefs()
    {
        var result = MultiImagePromptTransformer.TransformDirect("@img100@img50@img75@img25 四张图融合");

        Assert.Equal("图1图2图3图4 四张图融合", result);
    }

    [Fact]
    public void TransformDirect_ChineseText()
    {
        var result = MultiImagePromptTransformer.TransformDirect("让@img1里的乌龟和@img2里的鳄鱼打架");

        Assert.Equal("让图1里的乌龟和图2里的鳄鱼打架", result);
    }

    #endregion

    #region BuildRefIdToOrderMapping 测试

    [Fact]
    public void BuildRefIdToOrderMapping_CorrectMapping()
    {
        var mapping = MultiImagePromptTransformer.BuildRefIdToOrderMapping("@img12 @img9 @img5");

        Assert.Equal(3, mapping.Count);
        Assert.Equal(1, mapping[12]); // 第一个出现
        Assert.Equal(2, mapping[9]);  // 第二个出现
        Assert.Equal(3, mapping[5]);  // 第三个出现
    }

    [Fact]
    public void BuildRefIdToOrderMapping_WithDuplicates()
    {
        var mapping = MultiImagePromptTransformer.BuildRefIdToOrderMapping("@img12 @img9 @img12");

        Assert.Equal(2, mapping.Count); // 去重后只有2个
        Assert.Equal(1, mapping[12]);
        Assert.Equal(2, mapping[9]);
    }

    #endregion
}
