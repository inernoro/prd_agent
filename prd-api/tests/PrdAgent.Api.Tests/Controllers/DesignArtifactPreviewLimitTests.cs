using System.Reflection;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc;
using PrdAgent.Api.Controllers.Api;
using Xunit;

namespace PrdAgent.Api.Tests.Controllers;

/// <summary>
/// 实时预览的传输上限要容得下 JSON 转义后的整页（Codex P2）：CDS 用 JSON.stringify 推送，
/// 引号、反斜杠、换行各变两个字符。上限若按 HTML 原始大小 + 4 KB 算，属性密集的页面
/// 在 Kestrel 就被 413，进不了按解码后大小判的那道校验，实时预览静默断掉。
/// </summary>
public class DesignArtifactPreviewLimitTests
{
    [Fact]
    public void TransportLimit_FitsWorstCaseEscapedPageAtTheHtmlLimit()
    {
        // 恰好 1 MiB、全是需要转义的字符：解码后合法，传输时体积翻倍。
        var html = new string('"', DesignArtifactRuntimeController.MaxPreviewHtmlBytes);
        var body = JsonSerializer.Serialize(new { html, revision = int.MaxValue },
            new JsonSerializerOptions { Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping });
        Assert.True(Encoding.UTF8.GetByteCount(body) <= DesignArtifactRuntimeController.MaxPreviewRequestBytes);
    }

    [Fact]
    public void PreviewEndpoint_DeclaresTheEscapedTransportLimit()
    {
        var attribute = typeof(DesignArtifactRuntimeController)
            .GetMethod(nameof(DesignArtifactRuntimeController.PushWorkspacePreview))!
            .GetCustomAttribute<RequestSizeLimitAttribute>();
        Assert.NotNull(attribute);
        // RequestSizeLimitAttribute 不公开上限值，只能读它构造时存下的字段。
        var field = typeof(RequestSizeLimitAttribute).GetField("_bytes", BindingFlags.Instance | BindingFlags.NonPublic);
        Assert.NotNull(field);
        Assert.Equal((long)DesignArtifactRuntimeController.MaxPreviewRequestBytes, (long)field!.GetValue(attribute)!);
    }
}
