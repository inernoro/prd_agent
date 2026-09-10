using MongoDB.Bson;
using MongoDB.Bson.Serialization;
using PrdAgent.Core.LlmGateway;
using PrdAgent.Infrastructure.Database;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Gateway;

/// <summary>
/// 读方必须对写方宽容（degradation-must-alarm 层 0 / predicate-and-wiring-discipline 形状 2、3）。
///
/// 2026-09-09 事故：console-api 用弱类型 BsonDocument 往 llmgw_app_callers 写了
/// SystemManaged，serving 用强类型 GatewayAppCallerRecord 读同一个集合，而该类没有这个
/// 属性、所在进程也没装忽略额外字段的约定 —— 鉴权路径上 FormatException 打成 500，
/// 前端退回本地关键词判定，页面看着完全正常，全部验收判绿。
///
/// 讽刺的是写方那侧守卫齐全（归属、退役、并发路径都钉死在 GatewayRoutingWiringGuardTests），
/// 却没有任何一条问过「读方认识这个字段吗」—— 守卫自己也只建了一半。这个文件补的就是那一半。
///
/// 这几条删掉之后编译照过、其余测试照绿，只会在下一次写方加字段时再炸一遍，所以必须有守卫。
/// </summary>
public sealed class GatewayRecordSchemaToleranceTests
{
    private static string RepoRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir != null)
        {
            if (File.Exists(Path.Combine(dir.FullName, "CLAUDE.md"))
                && Directory.Exists(Path.Combine(dir.FullName, "prd-api")))
            {
                return dir.FullName;
            }
            dir = dir.Parent;
        }
        throw new InvalidOperationException("找不到仓库根：向上没有同时含 CLAUDE.md 与 prd-api 的目录");
    }

    /// <summary>
    /// 行为断言（不是断言某段实现的字面存在）：库里多出来的字段不许把读方打崩。
    /// 把 RegisterConventionsOnly 里的 IgnoreExtraElements 拿掉，这条立刻变红。
    /// </summary>
    [Fact]
    public void 强类型读到库里多出来的字段不许抛()
    {
        BsonClassMapRegistration.RegisterConventionsOnly();

        var doc = new BsonDocument
        {
            { "_id", "caller-1" },
            { "TenantId", "tenant-1" },
            { "AppCallerCode", "smart-device.command-parse" },
            // 写方今天就在写的那个字段。
            { "SystemManaged", true },
            // 明天某个进程会写、而今天这个类还不认识的那个字段 —— 它同样不许炸。
            // 这一条才是守卫的真正意图：不是补一个 SystemManaged 了事。
            { "SomeFieldWrittenByAnotherProcessLater", "x" },
        };

        var record = Should.NotThrow(() => BsonSerializer.Deserialize<GatewayAppCallerRecord>(doc));
        record.AppCallerCode.ShouldBe("smart-device.command-parse");
        record.SystemManaged.ShouldBe(true);
    }

    /// <summary>
    /// 三态不许收敛成两态：写方是 BsonDocument，它能写 true、写 false、也能整个不写这个字段。
    /// 读方收敛成 bool 就会把「还没有这个字段的存量文档」读成 false，替 console-api 的
    /// callerIsOurs 兜底判定下了它没打算下的结论。
    /// </summary>
    [Fact]
    public void 系统托管标记必须保持三态()
    {
        BsonClassMapRegistration.RegisterConventionsOnly();

        var absent = BsonSerializer.Deserialize<GatewayAppCallerRecord>(new BsonDocument
        {
            { "_id", "caller-2" },
            { "TenantId", "tenant-1" },
            { "AppCallerCode", "legacy.caller" },
        });

        absent.SystemManaged.ShouldBeNull(
            customMessage: "存量文档没有这个字段时必须是 null；读成 false 等于替写方下结论");
    }

    /// <summary>
    /// 接线守卫（形状 2）：约定必须真的有人调用。
    /// serving 是独立进程，不跑 MAP 的 BsonClassMapRegistration.Register()，
    /// 这一行删掉不会有任何测试变红，只会在下一次写方加字段时再 500 一次。
    /// </summary>
    [Fact]
    public void serving进程启动必须装载全局BSON约定()
    {
        var program = File.ReadAllText(Path.Combine(RepoRoot(), "llmgw", "serving", "Program.cs"));

        program.ShouldContain(
            "BsonClassMapRegistration.RegisterConventionsOnly()",
            customMessage: "serving 不跑 MAP 的类映射注册，不显式装约定就一直是 driver 的严格模式");

        // 约定是懒生效的：class map 一旦建立就不再追溯，所以必须排在任何 Mongo 读写之前。
        var conventionAt = program.IndexOf("RegisterConventionsOnly()", StringComparison.Ordinal);
        var firstContextAt = program.IndexOf("new LlmGatewayDataContext(", StringComparison.Ordinal);
        conventionAt.ShouldBeGreaterThanOrEqualTo(0);
        firstContextAt.ShouldBeGreaterThan(
            conventionAt,
            customMessage: "约定必须装在 Mongo context 构建之前 —— class map 懒建，装晚了不追溯，等于没装");
    }

    /// <summary>
    /// 双保险：直接查 class map 的属性，不依赖上面那次反序列化的时序。
    /// </summary>
    [Fact]
    public void 网关记录类的映射必须忽略额外字段()
    {
        BsonClassMapRegistration.RegisterConventionsOnly();

        BsonClassMap.LookupClassMap(typeof(GatewayAppCallerRecord)).IgnoreExtraElements.ShouldBeTrue(
            customMessage: "多进程共库时读方必须宽容，否则任一进程加字段都是一次破坏性变更");
    }
}
