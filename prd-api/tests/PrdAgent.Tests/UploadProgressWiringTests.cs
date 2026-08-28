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
        var reuploadAt = ctrl.IndexOf("public async Task<IActionResult> Reupload(", System.StringComparison.Ordinal);
        Assert.True(reuploadAt > 0, "找不到重传端点");
        var body = ctrl[reuploadAt..System.Math.Min(reuploadAt + 2600, ctrl.Length)];
        Assert.Contains("[FromForm] string? uploadId", body);
        Assert.Contains("uploadId: uploadId", body);
        Assert.Contains("_uploadProgress.CompleteAsync(uploadId)", body);

        // 服务层：这个参数真的往下走到解包，不是收了就丢
        Assert.Contains("ExtractAndUploadZip(siteId, fileBytes, uploadId)", svc);

        // 前端：表单里真的带上了
        var reuploadFn = api.IndexOf("export async function reuploadSite(", System.StringComparison.Ordinal);
        Assert.True(reuploadFn > 0);
        var fnBody = api[reuploadFn..System.Math.Min(reuploadFn + 900, api.Length)];
        Assert.Matches(new Regex(@"reuploadSite\(id: string, file: File, uploadId\?: string\)"), fnBody);
        Assert.Contains("fd.append('uploadId', uploadId)", fnBody);
    }
}
