using PrdAgent.Core.Models;

namespace PrdAgent.Api.Services;

/// <summary>实验室的未来执行引用校验；历史和未替换的失效配置保留原身份。</summary>
internal static class ModelLabModelReferences
{
    public static void Annotate(
        IEnumerable<ModelLabSelectedModel> models,
        IReadOnlyList<BusinessModelOption> options,
        bool hasUnknownPurpose = false)
    {
        foreach (var model in models)
        {
            var reference = BusinessModelReferenceService.Resolve(
                options, model.LogicalModelId, model.PlatformId, model.ModelId);
            var unknown = !reference.Success && hasUnknownPurpose;
            model.ModelReferenceStatus = unknown ? "unknown" : reference.Status;
            model.ModelReferenceReason = unknown
                ? "部分用途目录暂时不可用，原模型引用已保留；请稍后重新核对。"
                : reference.Reason;
        }
    }

    public static bool TryNormalize(
        IReadOnlyList<BusinessModelOption> options,
        IEnumerable<ModelLabSelectedModel> incoming,
        IReadOnlyList<ModelLabSelectedModel>? existing,
        out List<ModelLabSelectedModel> normalized,
        out string? reason)
    {
        normalized = new();
        reason = null;
        var retained = (existing ?? Array.Empty<ModelLabSelectedModel>()).ToList();
        foreach (var selected in incoming)
        {
            var reference = BusinessModelReferenceService.Resolve(
                options, selected.LogicalModelId, selected.PlatformId, selected.ModelId);
            if (reference.Success)
            {
                normalized.Add(new ModelLabSelectedModel
                {
                    LogicalModelId = reference.LogicalModelId,
                    PlatformId = "logical-model",
                    ModelId = reference.PublicId,
                    ModelName = reference.PublicId,
                    Name = reference.Name,
                    Group = selected.Group,
                    ModelReferenceStatus = reference.Status,
                    ModelReferenceReason = reference.Reason
                });
                continue;
            }

            // 只允许原有同一身份留待修复；不能把新坏引用保存成未来执行入口。
            var index = retained.FindIndex(old => SameIdentity(old, selected));
            if (index < 0)
            {
                reason = reference.Reason;
                normalized.Clear();
                return false;
            }

            retained.RemoveAt(index);
            normalized.Add(new ModelLabSelectedModel
            {
                LogicalModelId = selected.LogicalModelId,
                PlatformId = selected.PlatformId,
                ModelId = selected.ModelId,
                ModelName = selected.ModelName,
                Name = selected.Name,
                Group = selected.Group,
                ModelReferenceStatus = reference.Status,
                ModelReferenceReason = reference.Reason
            });
        }
        return true;
    }

    private static bool SameIdentity(ModelLabSelectedModel a, ModelLabSelectedModel b)
        => a.LogicalModelId == b.LogicalModelId
           && a.PlatformId == b.PlatformId
           && a.ModelId == b.ModelId
           && a.ModelName == b.ModelName;
}
