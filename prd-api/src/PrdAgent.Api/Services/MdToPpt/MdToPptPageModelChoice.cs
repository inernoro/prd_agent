using PrdAgent.Core.LlmGateway;

namespace PrdAgent.Api.Services.MdToPpt;

/// <summary>页面生成走 LLM Gateway 直出时，这次运行到底钉哪个对外模型。</summary>
internal enum MdToPptPageModelOutcome
{
    /// <summary>按运行配置里的模型发（或配置没写模型，交给网关按调用方默认对外模型选）。</summary>
    UseProfileModel,

    /// <summary>运行配置是隐式兜底来的，它的模型网关不认识；本次改用网关给该用途配的默认对外模型。</summary>
    UseGatewayDefault,

    /// <summary>发出去也必然失败，直接如实拒绝，不再让每一页各自退化成兜底版式。</summary>
    Reject,
}

/// <summary>
/// 一次 PPT 运行的页面模型决定。整次运行只算一次，所有页面共用同一个结果——
/// 否则并行的几页会各自去网关撞同一堵墙，再各自悄悄退化成兜底版式（N1 事故的形状）。
/// </summary>
internal sealed record MdToPptPageModelChoice(
    MdToPptPageModelOutcome Outcome,
    string? ExpectedModel,
    string? RequestedModel,
    string? DisplayModel,
    string? Notice)
{
    /// <summary>
    /// 网关解析失败里，唯一代表「这个名字不在对外模型目录里」的那一档。
    /// 其余失败（配置面读不到、调用方被停用、线路全挂）改名字也救不了，不在这里改判。
    /// </summary>
    internal const string NotInCatalogStage = "no-logical-model";

    internal static MdToPptPageModelChoice ProfileModel(string? model) =>
        new(MdToPptPageModelOutcome.UseProfileModel, model, model, model, null);

    /// <summary>
    /// 唯一判定源。输入全部是已经取回来的事实（配置里的模型名、是否用户点名选的、网关两次解析的结果），
    /// 输出是有限的三种结局；调用方不许在别处再判一次。
    /// </summary>
    internal static MdToPptPageModelChoice Choose(
        string? profileModel,
        bool explicitlySelected,
        GatewayModelResolution? requestedResolution,
        GatewayModelResolution? defaultResolution)
    {
        var requested = string.IsNullOrWhiteSpace(profileModel) ? null : profileModel.Trim();

        // 配置没点名模型：本来就是交给网关按调用方默认对外模型选，行为不变。
        if (requested == null) return ProfileModel(null);

        // 没查到结论、或网关认这个名字：照旧按配置里的模型发。
        if (requestedResolution == null || requestedResolution.Success) return ProfileModel(requested);

        // 失败但不是「目录里没有这个名字」：换名字救不了，照旧发，让真实错误在页面级如实暴露。
        if (!string.Equals(requestedResolution.FailureStage, NotInCatalogStage, StringComparison.Ordinal))
            return ProfileModel(requested);

        if (explicitlySelected)
        {
            return new MdToPptPageModelChoice(
                MdToPptPageModelOutcome.Reject,
                null,
                requested,
                requested,
                $"你选的运行配置里的模型「{requested}」不在 LLM Gateway 的对外模型目录里（或没有授权给 MD 转 PPT），页面无法生成。"
                + "请在模型选择里改选「MAP 默认模型」，或请网关管理员把它登记为对外模型后重试。");
        }

        if (defaultResolution is { Success: true })
        {
            var defaultPublicId = string.IsNullOrWhiteSpace(defaultResolution.LogicalModelPublicId)
                ? null
                : defaultResolution.LogicalModelPublicId.Trim();
            var actual = string.IsNullOrWhiteSpace(defaultResolution.ActualModel)
                ? defaultPublicId
                : defaultResolution.ActualModel.Trim();
            var label = defaultPublicId != null && actual != null && !string.Equals(defaultPublicId, actual, StringComparison.Ordinal)
                ? $"{defaultPublicId}（{actual}）"
                : defaultPublicId ?? actual ?? "网关默认对外模型";
            return new MdToPptPageModelChoice(
                MdToPptPageModelOutcome.UseGatewayDefault,
                defaultPublicId,
                requested,
                actual ?? label,
                $"默认运行配置里的模型「{requested}」不在 LLM Gateway 的对外模型目录里，本次改用网关为 MD 转 PPT 配置的默认对外模型 {label} 生成页面。"
                + "想固定用某个模型，请在模型选择里点名一个网关认识的配置。");
        }

        return new MdToPptPageModelChoice(
            MdToPptPageModelOutcome.Reject,
            null,
            requested,
            requested,
            $"默认运行配置里的模型「{requested}」不在 LLM Gateway 的对外模型目录里，网关也没有给 MD 转 PPT 配默认对外模型，页面无法生成。"
            + "请网关管理员给该用途设默认对外模型，或把该模型登记为对外模型后重试。");
    }
}
