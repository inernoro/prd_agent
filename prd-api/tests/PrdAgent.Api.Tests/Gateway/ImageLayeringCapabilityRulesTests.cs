using MongoDB.Bson;
using PrdAgent.Core.Models;
using PrdAgent.LlmGw.Provisioning;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Gateway;

/// <summary>
/// 图片分层能力卡判据的回归。这两条判据的共同点是「写错了照样编译、照样跑、不报错」，
/// 只有卡片状态永远不对——所以必须有测试钉住。
/// </summary>
public class ImageLayeringCapabilityRulesTests
{
    private const string ModelId = FalImageLayeringProvisioning.ModelId;

    private static BsonDocument Exchange(bool enabled = true, bool modelEnabled = true, bool withKey = true)
    {
        var doc = new BsonDocument
        {
            ["_id"] = "ex1",
            ["Enabled"] = enabled,
            ["Models"] = new BsonArray
            {
                new BsonDocument { ["ModelId"] = ModelId, ["Enabled"] = modelEnabled },
                new BsonDocument { ["ModelId"] = "other-model", ["Enabled"] = false },
            },
        };
        if (withKey) doc["TargetApiKeyEncrypted"] = "cipher";
        return doc;
    }

    private static BsonDocument LogicalModel(bool enabled = true)
        => new() { ["_id"] = "lm1", ["Enabled"] = enabled };

    private static BsonDocument Offering() => new() { ["_id"] = "of1" };

    [Fact]
    public void IsInstalled_AllPiecesEnabled_ReturnsTrue()
        => ImageLayeringCapabilityRules.IsInstalled(Exchange(), LogicalModel(), Offering(), ModelId)
            .ShouldBeTrue();

    [Fact]
    public void IsInstalled_DisabledExchange_ReturnsFalse()
    {
        // 运行时解析要求 Exchange.Enabled == true；漏查这一条，管理员一禁用卡片仍报「已安装」而请求全挂。
        ImageLayeringCapabilityRules.IsInstalled(Exchange(enabled: false), LogicalModel(), Offering(), ModelId)
            .ShouldBeFalse();
    }

    [Fact]
    public void IsInstalled_DisabledModelEntry_ReturnsFalse()
    {
        // 同理：解析还要求 Exchange 下那个模型条目本身 Enabled。
        ImageLayeringCapabilityRules.IsInstalled(Exchange(modelEnabled: false), LogicalModel(), Offering(), ModelId)
            .ShouldBeFalse();
    }

    [Fact]
    public void IsInstalled_DisabledLogicalModel_ReturnsFalse()
        => ImageLayeringCapabilityRules.IsInstalled(Exchange(), LogicalModel(enabled: false), Offering(), ModelId)
            .ShouldBeFalse();

    [Fact]
    public void IsInstalled_MissingOffering_ReturnsFalse()
        => ImageLayeringCapabilityRules.IsInstalled(Exchange(), LogicalModel(), null, ModelId)
            .ShouldBeFalse();

    [Fact]
    public void IsInstalled_MissingKey_ReturnsFalse()
        => ImageLayeringCapabilityRules.IsInstalled(Exchange(withKey: false), LogicalModel(), Offering(), ModelId)
            .ShouldBeFalse();

    [Fact]
    public void IsInstalled_MissingEnabledFlags_DefaultsToEnabled()
    {
        // 存量文档可能压根没写 Enabled 字段，此时应按启用处理，不能把老配置误判成没装。
        var exchange = new BsonDocument
        {
            ["_id"] = "ex1",
            ["TargetApiKeyEncrypted"] = "cipher",
            ["Models"] = new BsonArray { new BsonDocument { ["ModelId"] = ModelId } },
        };
        ImageLayeringCapabilityRules.IsInstalled(exchange, new BsonDocument { ["_id"] = "lm1" }, Offering(), ModelId)
            .ShouldBeTrue();
    }

    [Fact]
    public void UpstreamModelLogField_MustExistOnTheLogDocumentThatIsActuallyWritten()
    {
        // 验证查询按这个字段名过滤请求日志。写入端是 LlmRequestLog——
        // 字段名对不上不会报错，只会永远 0 命中，让验证状态卡死在「等待验证」。
        typeof(LlmRequestLog)
            .GetProperty(ImageLayeringCapabilityRules.UpstreamModelLogField)
            .ShouldNotBeNull(
                $"网关请求日志上没有 {ImageLayeringCapabilityRules.UpstreamModelLogField} 字段，" +
                "按它过滤会永远查不到记录");

        // 历史上这里写过 ActualModel——那是 RouterTrace DTO 的字段名，不是落库字段名。
        typeof(LlmRequestLog).GetProperty("ActualModel")
            .ShouldBeNull("LlmRequestLog 不该出现 ActualModel；若确需新增，请同步修正本判据的取值口径");
    }
}
