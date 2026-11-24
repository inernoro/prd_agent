using PrdAgent.Core.LlmGateway;
using PrdAgent.Core.Models;

namespace PrdAgent.Core.Security;

/// <summary>从持久化已提交作业冻结的只读目标；不是再次生成的许可。</summary>
public sealed record VideoReceiptTarget(string OwnerId, string AppCallerCode, string JobId, string Model, string OfferingId)
{
    public bool Matches(GatewayRawRequest request, GatewayModelResolution? resolution = null)
    {
        if (string.IsNullOrWhiteSpace(JobId) || string.IsNullOrWhiteSpace(Model) || string.IsNullOrWhiteSpace(OfferingId)
            || request.AppCallerCode != AppCallerCode || request.ModelType != ModelTypes.VideoGen
            || request.HttpMethod != "GET" || request.EndpointPath != "/videos/" + Uri.EscapeDataString(JobId)
            || request.RequiredOfferingId != OfferingId || request.ExpectBinaryResponse || request.IsMultipart
            || request.CanonicalImageRequest is not null || request.MultipartFields?.Count > 0
            || request.MultipartFiles?.Count > 0 || request.MultipartFileRefs?.Count > 0 || request.ExtraHeaders?.Count > 0)
            return false;
        if (request.RequestBody is { } body && (body.Count != 2
            || body["_gateway_operation"]?.ToString() != "status" || body["task_id"]?.ToString() != JobId)) return false;
        return resolution is null || resolution.Success && resolution.ActualModel == Model && resolution.OfferingId == OfferingId;
    }
}
