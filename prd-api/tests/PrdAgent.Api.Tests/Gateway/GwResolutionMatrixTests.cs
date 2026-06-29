using System.Text.RegularExpressions;
using PrdAgent.Core.Models;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Gateway;

/// <summary>
/// A 层（结构矩阵）：对全部已注册 appCallerCode 入口做反射级 MECE 校验——纯静态、无 Mongo、CI 真跑。
///
/// 数据源 AppCallerRegistrationService.GetAllDefinitions()（反射扫 AppCallerRegistry，与生产同步服务同一份）。
/// 解析快照（actualModel/平台/协议）由 doc/report.gw-test-matrix.md 第 2 节渲染的 golden 夹具承载
/// （需 Mongo，CI 标 Integration 跳过）；本测试只校验「每个入口注册合法 + ModelType 合法 + 命名规范」。
///
/// 对应 doc/spec.llm-gateway-test-matrix.md D1/D3/E18/E19。
/// </summary>
public class GwResolutionMatrixTests
{
    // ModelType 13 类白名单（与 codebase-snapshot / AppCallerRegistry 口径一致）。
    private static readonly HashSet<string> AllowedModelTypes = new()
    {
        "chat", "intent", "vision", "generation", "code", "long-context",
        "embedding", "rerank", "asr", "tts", "video-gen", "audio-gen", "moderation",
    };

    // appCallerCode 命名规范：kebab 段（含连字符），以 ::{model-type} 结尾。
    private static readonly Regex CodePattern =
        new(@"^[a-z0-9-]+(\.[a-z0-9-]+)*::[a-z0-9-]+$", RegexOptions.Compiled);

    public static IEnumerable<object[]> AllCodes() =>
        AppCallerRegistrationService.GetAllDefinitions().Select(d => new object[] { d.AppCode });

    // ── 每个注册入口逐个真跑：命名规范 + ModelType 合法 + 声明非空 ──
    [Theory]
    [MemberData(nameof(AllCodes))]
    public void EveryRegisteredCode_IsWellFormed(string appCode)
    {
        var def = AppCallerRegistrationService.GetAllDefinitions().First(d => d.AppCode == appCode);

        appCode.ShouldNotBeNullOrWhiteSpace();
        CodePattern.IsMatch(appCode).ShouldBeTrue($"{appCode}: 不符 kebab.{{...}}::{{model-type}} 命名");

        // 后缀 model-type 必须是 13 类之一。
        var suffix = appCode.Split("::")[^1];
        AllowedModelTypes.ShouldContain(suffix, $"{appCode}: 后缀 ModelType '{suffix}' 不在 13 类白名单");

        // 声明的 ModelTypes 数组非空且每个成员合法。
        def.ModelTypes.ShouldNotBeEmpty($"{appCode}: ModelTypes 声明为空");
        foreach (var mt in def.ModelTypes)
            AllowedModelTypes.ShouldContain(mt, $"{appCode}: 声明的 ModelType '{mt}' 不在白名单");
    }

    // ── 聚合：入口集合完整性 ──
    [Fact]
    public void Registry_HasNoDuplicateCodes_AndReasonableSize()
    {
        var defs = AppCallerRegistrationService.GetAllDefinitions();
        defs.Count.ShouldBeGreaterThanOrEqualTo(100, "注册入口数异常偏少，疑似反射扫描漏");
        var dup = defs.GroupBy(d => d.AppCode).Where(g => g.Count() > 1).Select(g => g.Key).ToList();
        dup.ShouldBeEmpty($"存在重复 appCallerCode: {string.Join(", ", dup)}");
    }

    // ── 聚合 + canary：负向控制证明白名单校验非空跑 ──
    [Fact]
    public void Canary_IllegalModelType_MustBeDetected()
    {
        // 一个真实存在的合法后缀必须通过。
        AllowedModelTypes.ShouldContain("chat");
        // 故意非法的 ModelType 必须被白名单判出（否则校验是空的）。
        AllowedModelTypes.Contains("frobnicate-not-a-type").ShouldBeFalse();
        CodePattern.IsMatch("Bad.Code::Chat").ShouldBeFalse("大写应被命名规范拒绝");
        CodePattern.IsMatch("good-app.feature::chat").ShouldBeTrue();
    }
}
