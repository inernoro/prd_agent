using System.IO;
using System.Text.RegularExpressions;
using Xunit;

namespace PrdAgent.Tests;

/// <summary>
/// 解包进度的接线守卫。
///
/// 这条链路是「服务层建好了、控制器那一跳没接」的典型：ReuploadAsync 早就收 uploadId
/// 并往下传给 ExtractAndUploadZip，而控制器既不收也不传，前端也没带。表现是换 ZIP 时
/// 进度面板一直停在「等待中」——编译过、测试全绿、通读也看不出来，只有真去换一次才知道。
/// 删掉这几处接线不会让任何别的用例变红，所以必须有这一条。
/// </summary>
public class UploadProgressWiringTests
{
    private static string ReadRepoFile(string relative)
    {
        var dir = new DirectoryInfo(System.AppContext.BaseDirectory);
        while (dir != null
               && !(File.Exists(Path.Combine(dir.FullName, "AGENTS.md"))
                    && Directory.Exists(Path.Combine(dir.FullName, "prd-api"))))
        {
            dir = dir.Parent;
        }
        Assert.NotNull(dir);
        var full = Path.Combine(dir!.FullName, relative.Replace('/', Path.DirectorySeparatorChar));
        Assert.True(File.Exists(full), $"找不到文件: {full}");
        return File.ReadAllText(full);
    }

    [Fact]
    public void 重传要把进度键一路传到解包层_否则面板永远停在等待中()
    {
        var ctrl = ReadRepoFile("prd-api/src/PrdAgent.Api/Controllers/Api/WebPagesController.cs");
        var svc = ReadRepoFile("prd-api/src/PrdAgent.Infrastructure/Services/HostedSiteService.cs");
        var api = ReadRepoFile("prd-admin/src/services/real/webPages.ts");

        // 控制器：收得到、传得下、收得了尾
        var body = SourceSlice.Member(ctrl, "public async Task<IActionResult> Reupload(");
        Assert.Contains("[FromForm] string? uploadId", body);
        Assert.Contains("uploadId: uploadId", body);
        Assert.Contains("_uploadProgress.CompleteAsync(uploadId)", body);

        // 服务层：这个参数真的往下走到解包，不是收了就丢
        Assert.Contains("ExtractAndUploadZip(siteId, fileBytes, uploadId)", svc);

        // 前端：表单里真的带上了。
        //
        // 断的是「这个函数收得到 uploadId 并且真的塞进了表单」，不是它的完整位置参数列表——
        // 原先钉整串签名，后来给它加了个 `signal` 参数（中止用）就当场判红，而它要防的那件事
        // 一个字没变。钉签名字面量属于形状 4a：改坏了不一定红，改对了反而红。
        var fnBody = SourceSlice.Member(api, "export async function reuploadSite(");
        Assert.Matches(new Regex(@"uploadId\?: string"), fnBody);
        Assert.Contains("fd.append('uploadId', uploadId)", fnBody);
    }

    [Fact]
    public void 入口文件判据只许有一份_否则幻灯片检测会对着别的文件跑()
    {
        // 原来解包中途只认根目录精确的 index.html，而最终选入口时还支持 index.htm
        // 与「第一个 HTML」。后果是用 index.htm / slides.html 打包的 reveal.js 稿子
        // 检测根本不跑，被存成普通网页。两处必须用同一条判据。
        var svc = ReadRepoFile("prd-api/src/PrdAgent.Infrastructure/Services/HostedSiteService.cs");

        Assert.Contains("private static string? SelectEntryPath(", svc);
        // 解包前定的入口与解包后定的最终入口，都走这一条
        Assert.Equal(2, Regex.Matches(svc, @"SelectEntryPath\(").Count - 1); // 1 处定义 + 2 处调用
        Assert.Contains("var plannedEntry = SelectEntryPath(", svc);
        Assert.Contains("var entryFile = SelectEntryPath(", svc);
        // 检测必须对着那个入口跑
        Assert.Contains("string.Equals(relativePath, plannedEntry, System.StringComparison.OrdinalIgnoreCase)"
            .Replace("System.", ""), svc);
        // 不许退回「循环里一边扫一边认，且只认 index.html」的老写法
        Assert.DoesNotContain("string? entrySoFar = null;", svc);
    }
}
