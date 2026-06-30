using System.Text.Json;
using PrdAgent.Infrastructure.LlmGateway;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Gateway;

/// <summary>
/// 安全契约（纯单元，CI 常驻，无 HTTP / 无 Mongo）：GatewayModelResolution 跨进程 HTTP 回传给调用方时
/// 序列化形态绝不包含 ApiKey —— [JsonIgnore] 守住「密钥不过 HTTP 线」（compute-then-send，serving 端
/// 重解析补 ApiKey 不外泄）。替代被标 Integration 的真 socket 跨进程往返测试在 CI 内对该安全契约的覆盖。
/// 见 doc/design.llm-gateway-physical-isolation.md。
/// </summary>
public class GatewaySerializationSecurityTests
{
    [Fact]
    public void GatewayModelResolution_Serialized_MustNotLeakApiKey()
    {
        const string secret = "SECRET-must-not-cross";
        var res = new GatewayModelResolution
        {
            Success = true,
            ActualModel = "m1",
            Protocol = "openai",
            ApiKey = secret,
        };

        // 两条序列化口径（默认 + 显式 PascalCase，对齐 serving 端 jsonOpts）都不得泄露 ApiKey。
        foreach (var opts in new[]
                 {
                     new JsonSerializerOptions(),
                     new JsonSerializerOptions { PropertyNamingPolicy = null },
                 })
        {
            var json = JsonSerializer.Serialize(res, opts);
            json.ShouldNotContain(secret);
            json.ShouldNotContain("ApiKey");
            json.ShouldNotContain("apiKey");
            // 解析回来的字段仍在（证明序列化本身工作，只是 ApiKey 被忽略）。
            json.ShouldContain("m1");
        }
    }
}
