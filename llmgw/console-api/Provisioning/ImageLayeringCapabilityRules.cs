using MongoDB.Bson;
using PrdAgent.LlmGw.Mongo;

namespace PrdAgent.LlmGw.Provisioning;

/// <summary>
/// 图片分层能力卡「装没装好 / 验没验过」的判定。
///
/// 抽成纯函数是因为这两条判据都属于「写错了也编译得过、跑起来也不报错、
/// 只是卡片永远显示错的状态」——不脱开 Mongo 就没法用测试钉住它们。
/// </summary>
public static class ImageLayeringCapabilityRules
{
    /// <summary>
    /// 网关请求日志里「本次真正打到上游的模型」的字段名。
    ///
    /// 集合里只有 Model，没有 ActualModel（console 展示侧的 BuildRouterTrace 也是从 Model 读的）。
    /// 查一个不存在的字段不会报错，只会永远 0 命中——验证状态因此卡在「等待验证」。
    /// 写成常量，让查询侧和展示侧共用同一个名字。
    /// </summary>
    public const string UpstreamModelLogField = "Model";

    /// <summary>凭据是否已录入。展示用的 HasKey 与下面的安装判定共用这一处判据。</summary>
    public static bool HasKey(BsonDocument? exchange)
        => exchange?.AsNullableString("TargetApiKeyEncrypted") is { Length: > 0 };

    /// <summary>
    /// 「已安装」= 运行时真能把这条能力解析出来，所以判据必须和 ModelResolver 的解析条件对齐：
    /// Exchange 自身启用（<c>Eq(e =&gt; e.Enabled, true)</c>）、Exchange 下那个模型条目启用
    /// （<c>effectiveModels.Any(m =&gt; m.Enabled &amp;&amp; ...)</c>）、逻辑模型启用、offering 存在、凭据已录。
    ///
    /// 少查任何一个，管理员一禁用，卡片仍报「已安装」而请求全部失败——
    /// 用户看到的状态和系统的实际行为对不上，且卡片只提供「更新凭据」这一个出口。
    /// </summary>
    public static bool IsInstalled(
        BsonDocument? exchange,
        BsonDocument? logicalModel,
        BsonDocument? offering,
        string modelId)
    {
        if (exchange is null || offering is null) return false;
        if (!HasKey(exchange)) return false;
        if (exchange.AsNullableBool("Enabled") == false) return false;
        if (FindExchangeModel(exchange, modelId)?.AsNullableBool("Enabled") == false) return false;
        if (logicalModel?.AsNullableBool("Enabled") == false) return false;
        return true;
    }

    /// <summary>从 Exchange 的 Models 数组里取出指定模型条目；取不到返回 null。</summary>
    public static BsonDocument? FindExchangeModel(BsonDocument exchange, string modelId)
    {
        if (!exchange.TryGetValue("Models", out var models) || !models.IsBsonArray) return null;
        foreach (var entry in models.AsBsonArray)
        {
            if (!entry.IsBsonDocument) continue;
            var doc = entry.AsBsonDocument;
            if (string.Equals(doc.GetStringOrEmpty("ModelId"), modelId, StringComparison.Ordinal))
                return doc;
        }
        return null;
    }
}
