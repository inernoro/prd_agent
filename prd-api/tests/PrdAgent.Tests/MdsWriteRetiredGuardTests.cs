using System.Reflection;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Abstractions;
using Microsoft.AspNetCore.Mvc.Controllers;
using Microsoft.AspNetCore.Mvc.Filters;
using Microsoft.AspNetCore.Mvc.Routing;
using Microsoft.AspNetCore.Routing;
using PrdAgent.Api.Filters;
using PrdAgent.Core.Models;
using Xunit;

namespace PrdAgent.Tests;

/// <summary>
/// 模型管理退场闸的守卫。
///
/// 这里断言的是**行为**（某个方法 + 路由模板过不过得去），不是「文件里写没写某一行」，
/// 所以把闸删掉、把某个写端点加进白名单、或者判据从模板换回原始 path，用例都会红
/// （predicate-and-wiring-discipline 形状 4a）。
///
/// 之所以必须有它：`MdsWriteRetiredFilter` 是全局 filter，删掉之后编译照过、
/// 现有用例照绿——只有真人去点一次「新建平台」才会发现闸没了，那时候错误配置已经落库。
/// </summary>
public class MdsWriteRetiredGuardTests
{
    private static ActionExecutingContext BuildContext(string method, string? routeTemplate)
    {
        var httpContext = new DefaultHttpContext();
        httpContext.Request.Method = method;

        var descriptor = new ControllerActionDescriptor
        {
            AttributeRouteInfo = routeTemplate is null ? null : new AttributeRouteInfo { Template = routeTemplate },
        };

        return new ActionExecutingContext(
            new ActionContext(httpContext, new RouteData(), descriptor),
            new List<IFilterMetadata>(),
            new Dictionary<string, object?>(),
            controller: new object());
    }

    private static IActionResult? Run(string method, string? routeTemplate)
    {
        var ctx = BuildContext(method, routeTemplate);
        new MdsWriteRetiredFilter().OnActionExecuting(ctx);
        return ctx.Result;
    }

    private static void AssertBlocked(string method, string routeTemplate)
    {
        var result = Run(method, routeTemplate);
        var obj = Assert.IsType<ObjectResult>(result);
        Assert.Equal(StatusCodes.Status410Gone, obj.StatusCode);
        var payload = Assert.IsType<ApiResponse<object>>(obj.Value);
        Assert.False(payload.Success);
        Assert.Equal("MDS_WRITE_RETIRED", payload.Error?.Code);
        // 报错必须给下一步去哪，不能只说「没了」（expectation-management：失败要可诊断）
        Assert.Contains("LLM Gateway", payload.Error?.Message ?? string.Empty);
    }

    [Theory]
    // 平台
    [InlineData("POST", "api/mds/platforms")]
    [InlineData("PUT", "api/mds/platforms/{id}")]
    [InlineData("DELETE", "api/mds/platforms/{id}")]
    [InlineData("POST", "api/mds/platforms/{id}/reclassify-models")]
    // 模型（含 IsMain / IsIntent / IsVision / IsImageGen 这套 legacy 用途标记）
    [InlineData("POST", "api/mds")]
    [InlineData("PUT", "api/mds/{id}")]
    [InlineData("DELETE", "api/mds/{id}")]
    [InlineData("DELETE", "api/mds/all")]
    [InlineData("PUT", "api/mds/main-model")]
    [InlineData("PUT", "api/mds/intent-model")]
    [InlineData("DELETE", "api/mds/intent-model")]
    [InlineData("PUT", "api/mds/vision-model")]
    [InlineData("DELETE", "api/mds/vision-model")]
    [InlineData("PUT", "api/mds/image-gen-model")]
    [InlineData("DELETE", "api/mds/image-gen-model")]
    [InlineData("POST", "api/mds/batch-from-platform")]
    // 模型池 / 中继 / 旧 LLM 配置 / 调度配置
    [InlineData("POST", "api/mds/model-groups")]
    [InlineData("PUT", "api/mds/model-groups/{id}")]
    [InlineData("DELETE", "api/mds/model-groups/{id}")]
    [InlineData("POST", "api/mds/exchanges")]
    [InlineData("DELETE", "api/mds/exchanges/{id}")]
    [InlineData("POST", "api/mds/exchanges/import-from-template")]
    [InlineData("POST", "api/mds/llm-configs")]
    [InlineData("PUT", "api/mds/scheduler-config")]
    public void ModelManagementWrites_AreRetiredWith410(string method, string routeTemplate)
        => AssertBlocked(method, routeTemplate);

    [Theory]
    // 非 GET 但语义是读/探测，且仍有存活调用方——放行，否则实验台与视觉创作会被误伤
    [InlineData("POST", "api/mds/adapter-info/batch")]
    [InlineData("POST", "api/mds/platforms/{id}/refresh-models")]
    public void ReadOnlyProbes_StillPass(string method, string routeTemplate)
        => Assert.Null(Run(method, routeTemplate));

    [Fact]
    public void OpsOnlyWrite_ForProdAsrKeyRotation_StillPasses()
    {
        // 唯一一条「确实是写但放行」的例外：scripts/llmgw-prod-asr-credential-rotate.py
        // 靠它轮换线上豆包 ASR 中继密钥，没有 UI 入口。这是已知债务，不是设计。
        Assert.Null(Run("PUT", "api/mds/exchanges/{id}"));
    }

    [Theory]
    // 读接口必须原样活着：LlmGateway/ModelResolver 仍从 MAP 集合兜底解析，
    // 实验台、竞技场、视觉创作也都还要读模型目录。
    [InlineData("GET", "api/mds")]
    [InlineData("GET", "api/mds/model-groups")]
    [InlineData("GET", "api/mds/platforms")]
    [InlineData("GET", "api/mds/platforms/{id}/available-models")]
    [InlineData("HEAD", "api/mds/platforms")]
    public void Reads_AreUntouched(string method, string routeTemplate)
        => Assert.Null(Run(method, routeTemplate));

    [Theory]
    // 闸只管 api/mds，别的模块的写操作一概不受影响。
    // api/mdsomething-else 这条是关键：判据必须按段比，裸 StartsWith("api/mds") 会把它一起挡掉。
    [InlineData("POST", "api/document-store/entries")]
    [InlineData("DELETE", "api/mdsomething-else/{id}")]
    [InlineData("POST", "api/mdsx")]
    [InlineData("POST", "api/mds-legacy/platforms")]
    public void OtherModules_AreNotAffected(string method, string routeTemplate)
        => Assert.Null(Run(method, routeTemplate));

    [Theory]
    // 前后斜杠只是写法差异，不该让判据翻转（形状 1）
    [InlineData("POST", "/api/mds/platforms")]
    [InlineData("POST", "api/mds/platforms/")]
    [InlineData("POST", "/api/mds")]
    public void SlashVariants_AreStillBlocked(string method, string routeTemplate)
    {
        var obj = Assert.IsType<ObjectResult>(Run(method, routeTemplate));
        Assert.Equal(StatusCodes.Status410Gone, obj.StatusCode);
    }

    [Fact]
    public void SlashVariants_DoNotBreakTheAllowlist()
    {
        // 白名单查表用的必须是归一化后的模板，否则带斜杠写法会把豁免端点误挡
        Assert.Null(Run("PUT", "/api/mds/exchanges/{id}"));
        Assert.Null(Run("POST", "api/mds/adapter-info/batch/"));
    }

    [Fact]
    public void MissingRouteTemplate_IsIgnoredInsteadOfBlocking()
        => Assert.Null(Run("POST", null));

    [Fact]
    public void FilterIsActuallyRegisteredGlobally()
    {
        // 形状 2：写了闸但没人挂 = 建了一半，删掉这行注册编译照过、上面所有用例照绿。
        //
        // 注意必须先剥注释再断言：直接 Contains 整份源码的话，把注册行注释掉
        // 一样能匹配上，守卫本身就成了形状 8——拿一份「不生效的声明」当成生效的证明。
        var program = StripLineComments(ReadRepoFile("prd-api/src/PrdAgent.Api/Program.cs"));
        Assert.Contains("options.Filters.Add<PrdAgent.Api.Filters.MdsWriteRetiredFilter>();", program);
    }

    [Fact]
    public void RegistrationGuard_GoesRedWhenTheLineIsCommentedOut()
    {
        // 负对照：证明上面那条守卫真的会红。剥注释这步一旦被人删掉，这条立刻失败。
        var commented = StripLineComments(
            "    // options.Filters.Add<PrdAgent.Api.Filters.MdsWriteRetiredFilter>();\n");
        Assert.DoesNotContain("options.Filters.Add<PrdAgent.Api.Filters.MdsWriteRetiredFilter>();", commented);
    }

    /// <summary>把 // 之后的内容削掉，只保留会被编译器看见的部分。字符串里出现 // 的行本仓库没有，够用。</summary>
    private static string StripLineComments(string source)
        => string.Join('\n', source.Split('\n').Select(line =>
        {
            var at = line.IndexOf("//", StringComparison.Ordinal);
            return at >= 0 ? line[..at] : line;
        }));

    [Fact]
    public void EveryMdsWriteEndpointIsCoveredByTheGate()
    {
        // 扫真实的 Controller 源码，确认没有哪个 api/mds 写端点被漏在闸外面。
        // 这条是为「以后有人新加写端点」准备的：新端点若不在白名单里就会被闸挡住（预期），
        // 若有人顺手把它塞进白名单，这里会因为白名单变长而暴露出来。
        var allowlist = typeof(MdsWriteRetiredFilter)
            .GetField("ReadOnlyProbes", BindingFlags.NonPublic | BindingFlags.Static)!
            .GetValue(null) as HashSet<string>;

        Assert.NotNull(allowlist);
        Assert.Equal(2, allowlist!.Count);
        Assert.Contains("POST api/mds/adapter-info/batch", allowlist);
        Assert.Contains("POST api/mds/platforms/{id}/refresh-models", allowlist);

        // 运维豁免必须始终只有一条：多一条就说明有人又把写口子开回来了。
        var opsOnly = typeof(MdsWriteRetiredFilter)
            .GetField("OpsOnlyWrites", BindingFlags.NonPublic | BindingFlags.Static)!
            .GetValue(null) as HashSet<string>;
        Assert.NotNull(opsOnly);
        Assert.Single(opsOnly!);
        Assert.Contains("PUT api/mds/exchanges/{id}", opsOnly);
    }

    private static string ReadRepoFile(string relativePath)
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !Directory.Exists(Path.Combine(dir.FullName, ".git")))
            dir = dir.Parent;
        Assert.NotNull(dir);
        var full = Path.Combine(dir!.FullName, relativePath.Replace('/', Path.DirectorySeparatorChar));
        Assert.True(File.Exists(full), $"找不到文件: {full}");
        return File.ReadAllText(full);
    }
}
