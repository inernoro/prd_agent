using PrdAgent.Api.Services.Mcp;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Mcp;

/// <summary>
/// 调用记录里的「产物」识别。这段代码删掉之后，接入台照样渲染、全量测试照样绿 ——
/// 只是每条记录后面那个「打开」按钮永远不出现。所以它需要一条守卫。
/// </summary>
public class McpArtifactExtractorTests
{
    [Fact]
    public void Extract_顶层带_url_的响应_认出产物地址()
    {
        var body = """{"success":true,"data":{"siteId":"s1","title":"周报","url":"https://x/y.html"}}""";

        var art = McpArtifactExtractor.Extract("map_web_publish_page", producesArtifacts: true, body);

        art.Kind.ShouldBe("site");
        art.Id.ShouldBe("s1");
        art.Url.ShouldBe("https://x/y.html");
        art.Title.ShouldBe("周报");
    }

    [Fact]
    public void Extract_生图跑完的响应_地址在_images_数组里_也要认出来()
    {
        // 视觉创作查 run 的响应把地址挂在 data.images[].url 上，顶层没有 url。
        // 只认顶层的话，生图记录永远是「有 runId、点不开图」—— 而那正是这条记录的用处。
        var body = """
        {"success":true,"data":{"runId":"r1","status":"Completed","images":[{"assetId":"a1","url":"https://cdn/1.png"}]}}
        """;

        var art = McpArtifactExtractor.Extract("map_visual_get_run", producesArtifacts: false, body);

        art.Kind.ShouldBe("image-run");
        art.Id.ShouldBe("r1");
        art.Url.ShouldBe("https://cdn/1.png");
    }

    [Fact]
    public void Extract_列表类工具的_items_地址_不算这次的产物()
    {
        // 下探数组只对已认出的生图任务做。无差别扫会把 map_web_list_pages 坑掉：
        // 第一条既有站点的地址会被当成「这次做出来的东西」，记录上长出一个指向别处的「打开」。
        var body = """
        {"success":true,"data":{"total":2,"items":[{"siteId":"s1","url":"https://x/old.html"}]}}
        """;

        var art = McpArtifactExtractor.Extract("map_web_list_pages", producesArtifacts: false, body);

        art.Url.ShouldBeNull();
        art.Kind.ShouldBeNull();
    }

    [Fact]
    public void Extract_读类工具拿到的既有对象_不算这次的产物()
    {
        // 判据是工具的写入语义，不是名字里有没有 _get_ ——
        // knowledge_base_read_entry 名字里没有那个片段，但它同样是纯读，
        // 回的 data.entryId 不该被记成「这次做出来的东西」。
        var body = """{"success":true,"data":{"entryId":"k1","title":"某篇文档"}}""";

        var art = McpArtifactExtractor.Extract("knowledge_base_read_entry", producesArtifacts: false, body);

        art.Kind.ShouldBeNull();
        art.Url.ShouldBeNull();
    }

    [Fact]
    public void IsDeduplicated_只在下游明确回了幂等命中时成立()
    {
        McpArtifactExtractor.IsDeduplicated("""{"success":true,"data":{"siteId":"s1","deduplicated":true}}""")
            .ShouldBeTrue();
        McpArtifactExtractor.IsDeduplicated("""{"success":true,"data":{"siteId":"s1"}}""")
            .ShouldBeFalse();
        McpArtifactExtractor.IsDeduplicated(null).ShouldBeFalse();
    }

    [Fact]
    public void ExtractErrorMessage_优先取接口自己的中文说明()
    {
        McpArtifactExtractor.ExtractErrorMessage("""{"success":false,"error":{"code":"X","message":"额度用完了"}}""")
            .ShouldBe("额度用完了");
    }
}
