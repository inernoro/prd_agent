using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using PrdAgent.Api.Controllers.Api;
using PrdAgent.Api.Mcp;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Mcp;

/// <summary>
/// 开放层收进来的调用方文本必须有上限 —— 而且这件事要**枚举着**守，不是一处一处补。
///
/// 「调用方给的无界文本原样落库」这个形状在本轮 Review 里连着中了六次：HTML 正文、幂等键、
/// 站点元数据、分享链元数据、知识库建库与建条目、生图尺寸。每修一处，下一轮就在**另一个**
/// 端点上复发 —— 典型的形状 3（判据分裂）：每处各判各的，没有一个能被枚举的判据。
///
/// 所以这里不写「WebPages 的 title 有没有上限」这种一处一条的断言，而是**反射列出**
/// 开放层全部请求 DTO 的每一个字符串字段，逐个要求它在下面这张账本里有交代。
/// 新增一个字段而不做决定，这条测试当场变红 —— 这正是前六次缺的那道闸。
/// </summary>
public class McpInputBoundsTests
{
    /// <summary>字段的处置方式。写进账本就是一次显式决定，不是默认放行。</summary>
    private enum Bound
    {
        /// <summary>走 McpInputBounds 的字节上限。</summary>
        Metadata,
        /// <summary>内容类字段，有自己更大的专属上限（HTML 4MB / 正文 20 万字）。</summary>
        OwnContentCap,
        /// <summary>有限形状：枚举值或正则，不当自由文本存。</summary>
        FiniteShape,
        /// <summary>会被哈希成定长指纹再落库，原文不进库。</summary>
        Hashed,
        /// <summary>要能在库里查得到才用，查不到就报错 —— 存在性本身就是上限。</summary>
        MustExist,
        /// <summary>不落库：只当查询条件或即时判断用。</summary>
        NotPersisted,
    }

    private static readonly Dictionary<string, Bound> Ledger = new(StringComparer.Ordinal)
    {
        ["CreateStoreRequest.Name"] = Bound.Metadata,
        ["CreateStoreRequest.Description"] = Bound.Metadata,
        ["CreateStoreRequest.Tags"] = Bound.Metadata,
        ["CreateStoreRequest.ClientRequestId"] = Bound.Hashed,

        ["CreateEntryRequest.Title"] = Bound.Metadata,
        ["CreateEntryRequest.Summary"] = Bound.Metadata,
        ["CreateEntryRequest.Tags"] = Bound.Metadata,
        ["CreateEntryRequest.ParentId"] = Bound.Metadata,
        ["CreateEntryRequest.Content"] = Bound.OwnContentCap,
        ["CreateEntryRequest.ClientRequestId"] = Bound.Hashed,

        ["UpdateEntryContentRequest.Content"] = Bound.OwnContentCap,
        // 版本令牌：要能被解析成时间戳才生效，解析不了直接 400
        ["UpdateEntryContentRequest.ExpectedUpdatedAt"] = Bound.FiniteShape,

        ["CreateWorkspaceRequest.Title"] = Bound.Metadata,
        ["CreateWorkspaceRequest.Content"] = Bound.OwnContentCap,
        ["CreateWorkspaceRequest.ClientRequestId"] = Bound.Hashed,

        ["WriteContentRequest.Content"] = Bound.OwnContentCap,
        ["WriteContentRequest.Mode"] = Bound.FiniteShape,
        ["WriteContentRequest.ExpectedUpdatedAt"] = Bound.FiniteShape,

        ["GenerateImageRequest.Prompt"] = Bound.OwnContentCap,
        ["GenerateImageRequest.Size"] = Bound.FiniteShape,
        ["GenerateImageRequest.ClientRequestId"] = Bound.Hashed,

        ["PublishPageRequest.HtmlContent"] = Bound.OwnContentCap,
        ["PublishPageRequest.Title"] = Bound.Metadata,
        ["PublishPageRequest.Description"] = Bound.Metadata,
        ["PublishPageRequest.Folder"] = Bound.Metadata,
        ["PublishPageRequest.Tags"] = Bound.Metadata,
        ["PublishPageRequest.ClientRequestId"] = Bound.Hashed,

        ["CreateShareRequest.Title"] = Bound.Metadata,
        ["CreateShareRequest.Description"] = Bound.Metadata,

        // 管理面绑定模型池：这两个是模型 id 列表，要在模型目录里查得到才生效
        ["SetBindingRequest.ChatModels"] = Bound.MustExist,
        ["SetBindingRequest.ImageModels"] = Bound.MustExist,
    };

    /// <summary>
    /// 每个「有自己内容上限」的字段是**新建**内容还是**覆盖**既有内容。
    ///
    /// 覆盖类必须带版本令牌，否则那次写入会无声地盖掉用户在界面上刚做的编辑。
    /// 知识库那一路修完之后，文学创作的 mode=replace 是同一族里的下一个，
    /// 下一轮 Review 才被指出来 —— 所以这件事也要枚举着守，不靠谁记得。
    /// </summary>
    private enum ContentKind { Create, Overwrite }

    private static readonly Dictionary<string, ContentKind> ContentSemantics = new(StringComparer.Ordinal)
    {
        ["CreateEntryRequest.Content"] = ContentKind.Create,
        ["CreateWorkspaceRequest.Content"] = ContentKind.Create,
        ["PublishPageRequest.HtmlContent"] = ContentKind.Create,
        ["GenerateImageRequest.Prompt"] = ContentKind.Create,
        ["UpdateEntryContentRequest.Content"] = ContentKind.Overwrite,
        ["WriteContentRequest.Content"] = ContentKind.Overwrite,
    };

    [Fact]
    public void 覆盖既有正文的入参_必须能接调用方的版本令牌()
    {
        foreach (var (key, dto, _) in TextFields())
        {
            if (!Ledger.TryGetValue(key, out var bound) || bound != Bound.OwnContentCap) continue;

            ContentSemantics.ContainsKey(key).ShouldBeTrue(
                $"{key} 是内容类字段，但没说它是新建还是覆盖。" +
                "覆盖类必须带版本令牌，否则会无声盖掉用户刚做的编辑 —— 在 ContentSemantics 里补一行。");

            if (ContentSemantics[key] != ContentKind.Overwrite) continue;
            dto.GetProperty("ExpectedUpdatedAt").ShouldNotBeNull(
                $"{dto.Name} 会覆盖既有正文，却收不了调用方的版本令牌（ExpectedUpdatedAt）。" +
                "没有它，「智能体读到 → 用户改了 → 智能体覆盖」这条路会把用户的编辑弄丢。");
        }

        // 反向：账本里留着已经删掉的字段，就是一条永远绿的死断言
        var seen = TextFields().Select(f => f.Key).ToHashSet(StringComparer.Ordinal);
        foreach (var key in ContentSemantics.Keys)
            seen.ShouldContain(key, customMessage: $"ContentSemantics 里的 {key} 在代码里已经不存在了，删掉这一行");
    }

    private static IEnumerable<(string Key, Type Owner, PropertyInfo Prop)> TextFields()
    {
        var asm = typeof(WebPagesOpenApiController).Assembly;
        foreach (var controller in asm.GetTypes()
                     .Where(t => t.Name.EndsWith("OpenApiController", StringComparison.Ordinal))
                     .OrderBy(t => t.Name, StringComparer.Ordinal))
        foreach (var dto in controller.GetNestedTypes(BindingFlags.Public)
                     .Where(t => t.Name.EndsWith("Request", StringComparison.Ordinal))
                     .OrderBy(t => t.Name, StringComparer.Ordinal))
        foreach (var prop in dto.GetProperties(BindingFlags.Public | BindingFlags.Instance)
                     .Where(p => p.PropertyType == typeof(string)
                                 || p.PropertyType == typeof(List<string>))
                     .OrderBy(p => p.Name, StringComparer.Ordinal))
            yield return ($"{dto.Name}.{prop.Name}", dto, prop);
    }

    [Fact]
    public void 开放层每个字符串入参_都要在账本里有交代()
    {
        var seen = new List<string>();
        foreach (var (key, _, _) in TextFields())
        {
            seen.Add(key);
            Ledger.ContainsKey(key).ShouldBeTrue(
                $"开放层新增了入参 {key}，但没决定它怎么被限住。" +
                "在 McpInputBoundsTests 的账本里补一行：走字节上限 / 有自己的内容上限 / 有限形状 / 会被哈希 / 必须存在 / 不落库。" +
                "这一步不是形式——前六次「无界输入落库」全是从这里漏过去的。");
        }

        // 反向也要成立：账本里留着已经删掉的字段，就是一条永远绿的死断言。
        foreach (var key in Ledger.Keys)
            seen.ShouldContain(key, customMessage: $"账本里的 {key} 在代码里已经不存在了，删掉这一行");
    }

    [Fact]
    public void 字节上限按UTF8算_不按字符数()
    {
        // 一个汉字 3 字节。按字符数判的话，512 的上限对中文等于 1536，形同虚设。
        McpInputBounds.Text(new string('标', 300), McpInputBounds.TitleBytes, "title")
            .ShouldNotBeNull("中文按字符数放行了");
        McpInputBounds.Text(new string('a', 300), McpInputBounds.TitleBytes, "title")
            .ShouldBeNull();
        McpInputBounds.Text(null, McpInputBounds.TitleBytes, "title").ShouldBeNull();
    }

    [Fact]
    public void tag_的个数与单个长度都要判()
    {
        McpInputBounds.Tags(null).ShouldBeNull();
        McpInputBounds.Tags(new List<string> { "a", "b" }).ShouldBeNull();
        McpInputBounds.Tags(Enumerable.Range(0, 100).Select(i => i.ToString()).ToList())
            .ShouldNotBeNull("tag 个数没判");
        McpInputBounds.Tags(new List<string> { new('y', 500) })
            .ShouldNotBeNull("单个 tag 长度没判");
    }

    [Fact]
    public void 站点与分享链的元数据_走的是同一个判定源()
    {
        // 上一轮只补了建站，分享链在下一轮才被指出来 —— 同一族的兄弟。
        var over = new string('x', 1000);
        WebPagesOpenApiController.ValidateMetadata(
            new WebPagesOpenApiController.PublishPageRequest { Title = over }).ShouldNotBeNull();
        WebPagesOpenApiController.ValidateShareMetadata(
            new WebPagesOpenApiController.CreateShareRequest { Title = over }).ShouldNotBeNull();
        WebPagesOpenApiController.ValidateShareMetadata(null).ShouldBeNull();

        DocumentStoreOpenApiController.ValidateStoreMetadata(
            new DocumentStoreOpenApiController.CreateStoreRequest { Name = over }).ShouldNotBeNull();
        DocumentStoreOpenApiController.ValidateEntryMetadata(
            new DocumentStoreOpenApiController.CreateEntryRequest { Title = over }).ShouldNotBeNull();
    }
}
