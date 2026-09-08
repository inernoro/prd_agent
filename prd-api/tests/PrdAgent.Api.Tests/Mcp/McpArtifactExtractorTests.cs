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

    [Fact]
    public void 只回_id_的写入工具_按类型反推站内深链()
    {
        // 建库 / 建条目 / 建文学工作区都只回 id，没有任何 url。
        // 不反推的话，这几条记录在面板上既没有「打开」也看不到 id ——
        // 而「一点就打开智能体刚做出来的东西」正是这块面板存在的理由。
        McpArtifactExtractor.Extract("map_kb_create_store", true,
                """{"success":true,"data":{"storeId":"st1","name":"资料库"}}""")
            .Url.ShouldBe("/document-store?store=st1");

        // 条目要带上它所属的库：DocumentStorePage 的深链解析只在 store 存在时才读 entry
        McpArtifactExtractor.Extract("map_kb_create_entry", true,
                """{"success":true,"data":{"entryId":"e1","storeId":"st1","title":"稿子"}}""")
            .Url.ShouldBe("/document-store?store=st1&entry=e1");

        McpArtifactExtractor.Extract("map_literary_create_workspace", true,
                """{"success":true,"data":{"workspaceId":"w1","title":"长文"}}""")
            .Url.ShouldBe("/literary-agent/w1");
    }

    [Fact]
    public void 反推不出来的一律不编地址()
    {
        // 缺 storeId 的条目：给一个点开是空白页的链接，比没有链接更糟。
        McpArtifactExtractor.Extract("map_kb_create_entry", true,
                """{"success":true,"data":{"entryId":"e1","title":"稿子"}}""")
            .Url.ShouldBeNull();

        // 还没跑完的生图 run 没有可点的地址，也不许拿 runId 拼一个
        var run = McpArtifactExtractor.Extract("map_visual_generate_image", true,
            """{"success":true,"data":{"runId":"r1","status":"Queued"}}""");
        run.Id.ShouldBe("r1");
        run.Url.ShouldBeNull();
    }

    /// <summary>
    /// 一次多张的生图，跑到一半时 GetRun 会回 finished:false 而 images 里已经有第一张的地址。
    /// 照着那个地址取产物，接入台会把整件事判成「已落地」并打绿灯 —— 而另外几张还在跑、
    /// 甚至可能失败。产物出来没有，以 finished 为准，不以「有没有第一个地址」为准。
    /// </summary>
    [Fact]
    public void Extract_生图跑到一半_不认那第一张的地址()
    {
        var body = """
        {"success":true,"data":{"runId":"r9","finished":false,"total":4,"done":1,
         "images":[{"assetId":"a1","url":"https://cdn/1.png"}]}}
        """;

        var art = McpArtifactExtractor.Extract("map_visual_get_run", producesArtifacts: false, body);

        art.Kind.ShouldBe("image-run");
        art.Id.ShouldBe("r9");
        art.Url.ShouldBeNull(customMessage: "还没跑完就给出地址，接入台会把整件事打成绿色成功");
    }

    /// <summary>
    /// `runId` 只对视觉工具意味着生图任务。
    ///
    /// 登记的动态接口（例如技能执行）回的是 { runId, userMessageId, assistantMessageId }
    /// 而永远没有图片地址 —— 无条件映射成 image-run 的话，那次**成功**的调用会被
    /// 接入台判成「还没出结果」，且永远不会变：没有任何轮询会给它一个地址。
    /// </summary>
    [Fact]
    public void 非视觉工具的runId_不算生图任务()
    {
        var body = """
        {"success":true,"data":{"runId":"r1","userMessageId":"u1","assistantMessageId":"a1"}}
        """;

        var art = McpArtifactExtractor.Extract("skill_execute", producesArtifacts: true, body);

        art.Id.ShouldBe("r1", customMessage: "身份不该丢，归并还要用它");
        art.Kind.ShouldNotBe("image-run",
            customMessage: "非视觉工具的 runId 被当成生图任务，那条记录会永远停在「还没出结果」");
    }

    [Fact]
    public void 视觉工具的runId_照旧算生图任务()
    {
        var body = """{"success":true,"data":{"runId":"r1","status":"Queued"}}""";

        McpArtifactExtractor.Extract("map_visual_generate_image", true, body).Kind
            .ShouldBe("image-run");
    }

    /// <summary>
    /// 判据收成白名单之后，这条同时是「**状态字段缺席**仍然认地址」的锚 ——
    /// 它的响应体里没有 status，旧响应和别的路径都可能这样，一缺就整类丢链接是另一种坏。
    /// 谁把判据改成「没有 status 也不认」，这里会红。
    /// </summary>
    [Fact]
    public void Extract_生图跑完_finished为真_照常认地址()
    {
        var body = """
        {"success":true,"data":{"runId":"r9","finished":true,"total":1,"done":1,
         "images":[{"assetId":"a1","url":"https://cdn/1.png"}]}}
        """;

        McpArtifactExtractor.Extract("map_visual_get_run", false, body).Url
            .ShouldBe("https://cdn/1.png");
    }

    /// <summary>
    /// 判据是「不是 false 才下探」，不是「必须是 true」：字段缺席时仍要给出地址。
    /// 写成必须为真的话，哪天响应里没这个字段，记录上那个「打开」会静默消失。
    /// </summary>
    [Fact]
    public void Extract_没有finished字段时_仍然认地址()
    {
        var body = """
        {"success":true,"data":{"runId":"r9","status":"Completed",
         "images":[{"assetId":"a1","url":"https://cdn/1.png"}]}}
        """;

        McpArtifactExtractor.Extract("map_visual_get_run", false, body).Url
            .ShouldBe("https://cdn/1.png");
    }

    /// <summary>
    /// finished:true 也包含**没成**的终态：IsRunFinished 对 Failed / Cancelled 同样返回 true，
    /// 而 worker 在多张里坏了一张时会把整条 run 记成 Failed 却留着已成那几张的地址。
    /// 只看 finished 的话，一条失败的 run 照样被认出产物，接入台随即打绿灯写「落地」。
    /// </summary>
    [Theory]
    [InlineData("Failed")]
    [InlineData("Cancelled")]
    public void Extract_跑完但没成的run_不认它留下的那几张地址(string status)
    {
        // 这段 JSON 以两个右花括号收尾，插值 raw string 会把它当成插值的收尾（编译不过）。
        // 所以不插值，用占位符替换最省事。
        var body = """
        {"success":true,"data":{"runId":"r9","status":"__STATUS__","finished":true,
         "total":4,"done":1,"failed":3,
         "images":[{"assetId":"a1","url":"https://cdn/1.png"}]}}
        """.Replace("__STATUS__", status);

        var art = McpArtifactExtractor.Extract("map_visual_get_run", producesArtifacts: false, body);

        art.Kind.ShouldBe("image-run");
        art.Url.ShouldBeNull(customMessage: $"{status} 的 run 仍给出地址，接入台会把它显示成绿色成功并写「落地」");
    }

    /// <summary>
    /// 计数满了但终态还没写：<c>IsRunFinished</c> 是「终态 <b>或</b> done + failed &gt;= total」，
    /// 而 worker 要等所有条目跑完、读回最终计数才写 Status。这中间 GetRun 会同时回
    /// 「跑完了」「还在跑」和已成那几张的地址 —— 这一版之前放行了它。
    ///
    /// 这条用例连同下面那条，一起推翻了上一版的取舍（「只拦明说没成的两种，认不出来的放行」）：
    /// 那条理由是「哪天多个新状态，『打开』会静默消失」，但那是假设的将来，
    /// 而这个窗口是现在就存在的缺陷，且**误报成功比丢链接更糟** ——
    /// 丢链接用户看得见（没得点），误报成功用户看不见（以为图出来了）。
    /// </summary>
    [Theory]
    [InlineData("Running")]
    [InlineData("Queued")]
    [InlineData("SomethingNew")]
    public void Extract_状态不是Completed_一律不认地址(string status)
    {
        var body = """
        {"success":true,"data":{"runId":"r9","status":"__STATUS__","finished":true,
         "total":4,"done":3,"failed":1,
         "images":[{"assetId":"a1","url":"https://cdn/1.png"}]}}
        """.Replace("__STATUS__", status);

        McpArtifactExtractor.Extract("map_visual_get_run", false, body).Url
            .ShouldBeNull(customMessage: $"status={status} 却认了地址，接入台会把它显示成绿色成功并写「落地」");
    }
}
