using MongoDB.Bson;
using MongoDB.Bson.Serialization;
using PrdAgent.Core.LlmGateway;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Gateway;

/// <summary>
/// 共享集合双写方漂移的回归守卫。
///
/// 事故：网关控制台直接以文档形式往同一张调用方表写自己的托管标记，而本侧的强类型
/// 视图没有声明该字段、也没有容错。启动阶段整表读取抛格式异常，把 serving 进程带崩，
/// 表现为预览环境网关长期不可用。
///
/// 两条判据缺一不可：
/// 1. 未声明字段不得让反序列化抛异常（治崩溃）；
/// 2. 未声明字段必须原样往返（治静默丢失）——去重逻辑会把原始文档整份归档，
///    注释承诺「保留每一份源文档」，用「忽略未知字段」会让这句承诺当场落空。
/// </summary>
public class GatewayAppCallerExtraElementsTests
{
    private static BsonDocument BuildDocumentWithForeignFields() => new()
    {
        { "_id", "caller-1" },
        { "TenantId", "tenant-1" },
        { "AppCallerCode", "demo-caller" },
        { "RequestType", "chat" },
        // 以下两个字段由另一个写方维护，本侧类型里没有声明。
        { "SystemManaged", true },
        { "SomeFutureFlag", "written-by-another-writer" },
    };

    [Fact]
    public void 未声明字段不应让反序列化抛异常()
    {
        var document = BuildDocumentWithForeignFields();

        var record = BsonSerializer.Deserialize<GatewayAppCallerRecord>(document);

        record.AppCallerCode.ShouldBe("demo-caller");
        record.RequestType.ShouldBe("chat");
    }

    [Fact]
    public void 未声明字段必须原样往返而不是被悄悄丢掉()
    {
        var document = BuildDocumentWithForeignFields();

        var record = BsonSerializer.Deserialize<GatewayAppCallerRecord>(document);
        var roundTripped = record.ToBsonDocument();

        roundTripped.Contains("SystemManaged").ShouldBeTrue(
            customMessage: "托管标记在往返后消失了；归档承诺保留源文档，这里一丢，归档就是残缺的");
        roundTripped["SystemManaged"].AsBoolean.ShouldBeTrue();
        roundTripped.Contains("SomeFutureFlag").ShouldBeTrue(
            customMessage: "另一个写方将来新增的字段同样会被丢掉，说明收容位没生效");
        roundTripped["SomeFutureFlag"].AsString.ShouldBe("written-by-another-writer");
    }
}
