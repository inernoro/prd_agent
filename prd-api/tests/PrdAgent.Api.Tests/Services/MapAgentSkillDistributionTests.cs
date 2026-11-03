using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using PrdAgent.Api.Controllers.Api.OfficialSkills;
using PrdAgent.Core.Models;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public class MapAgentSkillDistributionTests
{
    private static OfficialSkillsController Controller()
    {
        var config = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["ServerUrl"] = "https://map.example.test",
        }).Build();
        var context = new DefaultHttpContext();
        context.Request.Scheme = "https";
        context.Request.Host = new HostString("map.example.test");
        return new OfficialSkillsController(config, NullLogger<OfficialSkillsController>.Instance)
        {
            ControllerContext = new ControllerContext { HttpContext = context },
        };
    }

    private static string Digest(byte[] data) => Convert.ToHexString(SHA256.HashData(data)).ToLowerInvariant();

    private static JsonElement Manifest(OfficialSkillsController controller)
    {
        var result = Assert.IsType<OkObjectResult>(controller.MapAgentManifest());
        var envelope = Assert.IsType<ApiResponse<object>>(result.Value);
        Assert.True(envelope.Success);
        return JsonSerializer.SerializeToElement(envelope.Data);
    }

    private static Dictionary<string, byte[]> Unpack(FileContentResult response)
    {
        using var stream = new MemoryStream(response.FileContents);
        using var zip = new ZipArchive(stream, ZipArchiveMode.Read);
        return zip.Entries.ToDictionary(entry => entry.FullName, entry =>
        {
            using var input = entry.Open();
            using var output = new MemoryStream();
            input.CopyTo(output);
            return output.ToArray();
        });
    }

    [Fact]
    public void ManifestMatchesActualRepeatedDownloadsAndEveryFile()
    {
        var controller = Controller();
        var manifest = Manifest(controller);
        var first = Assert.IsType<FileContentResult>(controller.Download("map-agent"));
        var second = Assert.IsType<FileContentResult>(controller.Download("map-agent"));
        Assert.Equal(first.FileContents, second.FileContents);
        Assert.Equal(manifest.GetProperty("sha256").GetString(), Digest(first.FileContents));
        Assert.Equal("https://map.example.test/api/official-skills/map-agent/download",
            manifest.GetProperty("downloadUrl").GetString());
        var files = Unpack(first);
        foreach (var file in manifest.GetProperty("files").EnumerateArray())
        {
            var path = "map-agent/" + file.GetProperty("path").GetString();
            Assert.Equal(file.GetProperty("sha256").GetString(), Digest(files[path]));
        }
        Assert.Equal(files.Count, manifest.GetProperty("files").GetArrayLength());
        Assert.Contains("map-agent/SKILL.md", files.Keys);
        Assert.Contains("map-agent/scripts/skill_manager.py", files.Keys);
        Assert.DoesNotContain("map-agent/scripts/test_skill_manager.py", files.Keys);
    }

    [Fact]
    public void PreviewManifestDownloadsStayOnTheActualExternalOrigin()
    {
        var controller = Controller();
        controller.Request.Host = new HostString("preview.example.test");
        controller.Request.Headers["X-Forwarded-Host"] = "untrusted.example.test";
        controller.Request.Headers["X-Forwarded-Proto"] = "https";
        var manifest = Manifest(controller);
        foreach (var name in new[] { "downloadUrl", "manifestUrl", "installerUrl", "workBuddyDownloadUrl" })
            Assert.StartsWith("https://preview.example.test/", manifest.GetProperty(name).GetString());
    }

    [Fact]
    public void WorkBuddyPackageAddsRequiredMetadataAndKeepsTheSameBodyAndScripts()
    {
        var controller = Controller();
        var manifest = Manifest(controller);
        var standard = Unpack(Assert.IsType<FileContentResult>(controller.Download("map-agent")));
        var workBuddyResult = Assert.IsType<FileContentResult>(controller.Download("map-agent", "workbuddy"));
        var workBuddy = Unpack(workBuddyResult);
        Assert.Equal(manifest.GetProperty("workBuddySha256").GetString(), Digest(workBuddyResult.FileContents));
        Assert.NotEqual(manifest.GetProperty("sha256").GetString(), manifest.GetProperty("workBuddySha256").GetString());
        Assert.EndsWith("?client=workbuddy", manifest.GetProperty("workBuddyDownloadUrl").GetString());
        var regular = Encoding.UTF8.GetString(standard["map-agent/SKILL.md"]);
        var adapted = Encoding.UTF8.GetString(workBuddy["map-agent/SKILL.md"]);
        var regularEnd = regular.IndexOf("\n---", 3, StringComparison.Ordinal);
        var adaptedEnd = adapted.IndexOf("\n---", 3, StringComparison.Ordinal);
        Assert.Equal(regular[regularEnd..], adapted[adaptedEnd..]);
        var header = adapted[..adaptedEnd];
        foreach (var name in new[] { "name", "description", "display_name", "display_name_en",
                     "description_zh", "description_en", "version", "author" })
            Assert.Contains(header.Split('\n'), line => line.StartsWith(name + ":", StringComparison.Ordinal));
        Assert.DoesNotContain(regular.Split('\n'), line => line.StartsWith("display_name:", StringComparison.Ordinal));
        foreach (var pair in standard.Where(pair => pair.Key != "map-agent/SKILL.md"))
            Assert.Equal(pair.Value, workBuddy[pair.Key]);
    }

    [Fact]
    public void InstallerDownloadIsExactlyTheBundledScriptAndNoCredentialIsNeeded()
    {
        var controller = Controller();
        var manifest = Manifest(controller);
        var response = Assert.IsType<FileContentResult>(controller.MapAgentInstaller());
        var package = Unpack(Assert.IsType<FileContentResult>(controller.Download("map-agent")));
        Assert.Equal(package["map-agent/scripts/skill_manager.py"], response.FileContents);
        Assert.Equal(manifest.GetProperty("installerSha256").GetString(), Digest(response.FileContents));
        Assert.Empty(controller.User.Claims);
        foreach (var name in new[] { nameof(OfficialSkillsController.MapAgentManifest), nameof(OfficialSkillsController.MapAgentInstaller) })
            Assert.NotEmpty(typeof(OfficialSkillsController).GetMethod(name)!.GetCustomAttributes(typeof(AllowAnonymousAttribute), true));
    }

    [Fact]
    public void OtherOfficialSkillDownloadsRetainTheirOriginalContent()
    {
        var entry = OfficialSkillCatalog.Find("findmapskills");
        Assert.NotNull(entry);
        var files = Unpack(Assert.IsType<FileContentResult>(Controller().Download("findmapskills", "workbuddy")));
        var original = entry.Files.Single(file => file.Path == "SKILL.md").Content;
        var expected = original.Replace("${PRD_AGENT_BASE:?缺 base URL。导出 PRD_AGENT_BASE=https://your-platform}",
            "${PRD_AGENT_BASE:=https://map.example.test}");
        Assert.Equal(expected, Encoding.UTF8.GetString(files["findmapskills/SKILL.md"]));
        Assert.DoesNotContain("map-agent/SKILL.md", files.Keys);
    }
}
