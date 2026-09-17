using PrdAgent.LlmGw.LogicalModels;

namespace PrdAgent.LlmGw.Provisioning;

/// <summary>
/// 批量导入上游模型时，把物理模型登上白名单所需的两个判断。
///
/// 抽出来单放不是为了复用，是为了**能被单测直接断言**：这两件事写在
/// minimal-api 的端点闭包里就只能靠跑整条导入链路才验得到，而它们恰恰是
/// 「删掉之后编译照过、测试照绿」的那类逻辑。
/// </summary>
public static class GatewayWhitelistPublishing
{
    /// <summary>
    /// 上游模型名 -> 公开模型名。
    ///
    /// 中转商的模型名普遍带供应商前缀（<c>openai/gpt-4o</c>、<c>anthropic/claude-sonnet-4</c>）。
    /// 这层前缀**在名录认得出来的时候**要剥掉，否则从官网导一次得到 <c>gpt-4o</c>、
    /// 从中转导一次得到 <c>openai/gpt-4o</c>，同一个模型在白名单里变成两个公开名——
    /// 「一个模型多个来源」就永远合不起来，而这正是白名单存在的理由。
    ///
    /// **但不许无条件剥。** 上一版对任何带斜杠的名字都取最后一段，于是管理员显式导入一个
    /// 名录外的 <c>private-provider/gpt-4o</c> 会被算成公开名 <c>gpt-4o</c>，
    /// 发布那一步按这个公开名找到**已存在的那条 gpt-4o**、用途又恰好相同，
    /// 就把这个私有上游当成它的又一条线路挂了上去——普通的 <c>gpt-4o</c> 流量从此可能落到
    /// 一个毫不相干的上游（第 70 轮 review）。
    ///
    /// 判据与 <c>ModelCatalog.Find</c> 完全一致，并且**直接问它**而不是照着它再写一遍：
    /// 名录只在「剥掉的那一段正是命中那条登记自己的厂商段」时才认这种等价
    /// （<c>openai/claude-3-opus</c> 这种拼出来的组合它是拒绝的）。名录认得出来 → 用它的规范
    /// 标识当公开名；认不出来 → **整串保留**（PublicId 的字符集本来就允许斜杠），
    /// 宁可多出一条 <c>private-provider/gpt-4o</c>，也不要把它混进别人的模型里。
    ///
    /// 版本后缀（<c>:free</c>、<c>-2024-08-06</c>）一律保留，它们是不同的模型。
    /// </summary>
    public static string ToPublicId(string upstreamModelName, ModelCatalog.CatalogOverrides? catalogOverrides = null)
    {
        var name = (upstreamModelName ?? string.Empty).Trim();
        if (name.Length == 0) return string.Empty;
        var slash = name.LastIndexOf('/');
        if (slash >= 0)
        {
            // 斜杠在末尾 = 上游名里根本没有模型段（"openai/"）。返回空让调用方跳过，
            // 而不是退回整串——那会拿供应商名当公开模型名，在白名单里凭空造一条 "openai"。
            if (slash == name.Length - 1) return string.Empty;
            // 名录认得出这个完整标识（含它自己登记过的厂商前缀）才收敛到规范标识；
            // 认不出来就整串保留，不替它假设这个前缀是可剥的。
            name = ModelCatalog.Find(name, catalogOverrides) is { } known ? known.CanonicalId : name;
        }
        // 逻辑模型的 PublicId 校验：首字符必须是字母或数字，其余只允许 . _ : / -
        // 斜杠**要留着**：名录认不出来的标识整串保留，而它多半带着厂商段。
        // 上一版这里漏了斜杠——反正那时前缀总会被剥掉，留不留看不出区别；
        // 改成「认不出就不剥」之后，漏掉它会把 private-provider/gpt-4o 挤成
        // private-providergpt-4o，一个谁也认不出的名字。
        var cleaned = new string(name.Where(c => char.IsLetterOrDigit(c) || c is '.' or '_' or ':' or '/' or '-').ToArray());
        while (cleaned.Length > 0 && !char.IsLetterOrDigit(cleaned[0])) cleaned = cleaned[1..];
        return cleaned.Length is >= 2 and <= 160 ? cleaned : string.Empty;
    }

    /// <summary>
    /// 能力码 -> 逻辑模型的 ModelType；一个模态都认不出来时回 <c>null</c>。
    ///
    /// 顺序是判据不是偏好：一个模型同时声明 image_generation 与 chat 时（多模态很常见），
    /// 必须判成生图——拿它当对话模型调度，请求会带着错误的入参打到生图端点。
    /// 反过来把对话模型判成生图只会少用一个模型，代价小得多。宁可窄，不可宽。
    ///
    /// **认不出来时回 null，不兜底成 chat。** 兜底成 chat 曾经写着「猜错也只是少了个可选项」，
    /// 那句话只在模型确实是对话模型时成立。管理员放行一个名录外模型、而它的名字又推不出
    /// 任何能力时，提交上来的能力是空的；publish 成 chat 之后它就是一个货真价实的对话模型：
    /// 普通对话调用方不要求任何场景能力，于是它会被列出、被选中、被按对话契约调用，
    /// 而那个上游可能是生图、视频或别的东西。猜错的代价不是「少一个选项」，
    /// 是「一个不该被选中的模型进了对话默认面」（no-rootless-tree：认不出就说认不出，不编）。
    ///
    /// 返回 null 不等于模型不能用：物理模型照常入库，只是不登白名单。
    /// 补法是去模型管理给它标能力，再登记——那是一个人拍板的动作，不是这里猜的。
    /// </summary>
    public static string? TryResolveModelType(IReadOnlyCollection<string> capabilityCodes)
    {
        var codes = capabilityCodes
            .Select(x => (x ?? string.Empty).Trim().ToLowerInvariant())
            .Where(x => x.Length > 0)
            .ToHashSet(StringComparer.Ordinal);

        if (codes.Contains("video_generation")) return "video-gen";
        if (codes.Contains(LogicalModelCapabilityPolicy.ImageGeneration)
            || codes.Contains("text2img") || codes.Contains("img2img")
            || codes.Contains("vision_generation") || codes.Contains("image_layering")) return "generation";
        if (codes.Contains("embedding")) return "embedding";
        if (codes.Contains("rerank")) return "rerank";
        if (codes.Contains("asr")) return "asr";
        if (codes.Contains("tts")) return "tts";
        // vision 与 chat 同时声明时判 chat（多模态对话模型的常态，gpt-4o 就是）。
        //
        // 上面那句「宁可窄不可宽」对生图成立——入参完全不同，打错端点就是硬失败。
        // 对 vision 不成立：带图对话走的就是 /v1/chat/completions，入参兼容。
        // 判成 vision 的后果是它接不了最常用的那类请求：普通文本对话用 ModelTypes.Chat
        // 解析，而目录查询按 ModelType 精确匹配；又因为 PublicId 跨用途唯一，
        // 同一个标识没法再补一条 chat 的。一次导入把 gpt-4o 变成一个只能看图的模型。
        if (codes.Contains("vision") && !codes.Contains("chat")) return "vision";
        // 明说自己是对话模型的才判对话。
        if (codes.Contains("chat")) return "chat";
        // 一个模态都认不出来：如实回 null，由调用方决定怎么说这件事。
        return null;
    }
}
