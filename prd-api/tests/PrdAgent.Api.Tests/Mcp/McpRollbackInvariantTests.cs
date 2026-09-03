using System;
using System.IO;
using PrdAgent.Api.Controllers.Api;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Mcp;

/// <summary>
/// 幂等回滚的两条不变量。两条都坏在「补偿写了一半」上，而且都不会红：接口照常返回、
/// 页面照常打开，只是数字对不上或者内容被别人盖了。
/// </summary>
public class McpRollbackInvariantTests
{
    [Fact]
    public void 条目没删掉时_文档计数不许减()
    {
        // 清理失败时条目是被**刻意留下来**占住确定性 id 的，它还在列表里看得见。
        // 这时候减计数 = 库摘要永久少算一条，而且没人会来补。
        DocumentStoreOpenApiController.ShouldRestoreDocumentCount(countedIn: true, entryDeleted: false)
            .ShouldBeFalse();
        DocumentStoreOpenApiController.ShouldRestoreDocumentCount(countedIn: true, entryDeleted: true)
            .ShouldBeTrue();
        // 压根没计进去过的，删没删都不减
        DocumentStoreOpenApiController.ShouldRestoreDocumentCount(countedIn: false, entryDeleted: true)
            .ShouldBeFalse();
        DocumentStoreOpenApiController.ShouldRestoreDocumentCount(countedIn: false, entryDeleted: false)
            .ShouldBeFalse();
    }

    [Fact]
    public void 建站必须先占数据库的坑_再上传对象()
    {
        // 站点 id 带幂等键时是确定性的 —— 两个并发请求算出同一个 COS key。
        // 先传后插的话，输掉数据库竞争的那一方已经把赢家的 index.html 覆盖掉了：
        // 元数据是赢家的、页面内容是输家的，而两边都收到「去重成功」。
        //
        // 这条读源码断言，不起服务：要复现得同时有 Mongo 与对象存储，还要卡住两个请求的时序，
        // 单测造不出来；而这条约定的实质就是「别再把这两步的顺序换回去」。
        var body = MethodBody("CreateFromContentAsync");
        var insert = body.IndexOf("HostedSites.InsertOneAsync", StringComparison.Ordinal);
        var upload = body.IndexOf("UploadToKeyAsync", StringComparison.Ordinal);

        insert.ShouldBeGreaterThan(-1, customMessage: "CreateFromContentAsync 里找不到插入站点记录那一步");
        upload.ShouldBeGreaterThan(-1, customMessage: "CreateFromContentAsync 里找不到上传对象那一步");
        insert.ShouldBeLessThan(upload,
            customMessage: "建站必须先插入站点记录（原子地定胜负）再上传对象，否则并发的输家会覆盖赢家的页面");
    }

    private const string SiteServicePath = "HostedSiteService.cs";

    /// <summary>截出某个方法从签名到下一个方法签名之间的源码片段。</summary>
    private static string MethodBody(string methodName)
    {
        var path = Path.Combine(RepoRoot(), "prd-api", "src", "PrdAgent.Infrastructure", "Services", SiteServicePath);
        var src = File.ReadAllText(path);
        var start = src.IndexOf($"public async Task<HostedSite> {methodName}(", StringComparison.Ordinal);
        start.ShouldBeGreaterThan(-1, customMessage: $"{SiteServicePath} 里找不到方法 {methodName}");
        var next = src.IndexOf("\n    public ", start + 1, StringComparison.Ordinal);
        return next > start ? src[start..next] : src[start..];
    }

    /// <summary>从测试程序集所在目录向上找仓库根（以 CLAUDE.md 与 prd-api 同时存在为准）。</summary>
    private static string RepoRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir != null)
        {
            if (File.Exists(Path.Combine(dir.FullName, "CLAUDE.md"))
                && Directory.Exists(Path.Combine(dir.FullName, "prd-api")))
                return dir.FullName;
            dir = dir.Parent;
        }
        throw new InvalidOperationException("找不到仓库根：向上没有同时含 CLAUDE.md 与 prd-api 的目录");
    }
}
