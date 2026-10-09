using Microsoft.Extensions.Logging;
using MongoDB.Driver;
using PrdAgent.Core.LlmGateway;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.LLM;
using PrdAgent.Infrastructure.LlmGateway.ImageGen;
using static PrdAgent.Core.Models.AppCallerRegistry;

namespace PrdAgent.Api.Services.Mcp;

public sealed record LiteraryMcpModelSelection(
    bool Success,
    string? LogicalModelPublicId,
    string? ErrorCode,
    string? ErrorMessage)
{
    public static LiteraryMcpModelSelection Selected(string publicId)
        => new(true, publicId, null, null);

    public static LiteraryMcpModelSelection Failed(string code, string message)
        => new(false, null, code, message);
}

public interface ILiteraryMcpModelSelectionService
{
    Task<LiteraryMcpModelSelection> ResolveForRunAsync(
        string ownerUserId,
        string agentApiKeyId,
        string appCallerCode,
        CancellationToken ct);

    Task<LiteraryMcpModelSelection> ValidateFixedModelAsync(
        string logicalModelPublicId,
        CancellationToken ct);

    /// <summary>
    /// 选中模型的图片能力（尺寸清单与约束），取自网关目录随条目下发的能力快照——网页尺寸选择器读的是同一份。
    /// 读不到返回 null，由调用方明说，不当成「什么尺寸都收」。
    /// </summary>
    Task<ImageGenAdapterInfo?> GetImageCapabilitiesAsync(
        string appCallerCode,
        string logicalModelPublicId,
        CancellationToken ct);
}

/// <summary>
/// MCP 文学配图的模型契约：网页偏好与每把密钥的固定选择互不覆盖，入队前统一解析成
/// 逻辑模型 PublicId。控制器把这个 PublicId 写入 run 后，后续配置变化不会改写在途任务。
/// </summary>
public sealed class LiteraryMcpModelSelectionService(
    MongoDbContext db,
    ILlmGateway gateway,
    ILogger<LiteraryMcpModelSelectionService> logger) : ILiteraryMcpModelSelectionService
{
    private static readonly string[] LiteraryImageCallers =
    [
        LiteraryAgent.Illustration.Text2Img,
        LiteraryAgent.Illustration.Img2Img,
    ];

    public async Task<LiteraryMcpModelSelection> ResolveForRunAsync(
        string ownerUserId,
        string agentApiKeyId,
        string appCallerCode,
        CancellationToken ct)
    {
        if (!LiteraryImageCallers.Contains(appCallerCode, StringComparer.Ordinal))
            return LiteraryMcpModelSelection.Failed("MODEL_SCENARIO_INVALID", "当前文学配图场景未注册，无法选择模型。");

        var key = await db.AgentApiKeys
            .Find(x => x.Id == agentApiKeyId && x.OwnerUserId == ownerUserId)
            .FirstOrDefaultAsync(ct);
        if (key == null)
            return LiteraryMcpModelSelection.Failed("MODEL_KEY_NOT_FOUND", "当前 MCP 客户端配置不存在，请重新连接客户端后重试。");

        if (key.McpLiteraryImageModelMode == McpLiteraryImageModelMode.Fixed)
        {
            var fixedPublicId = key.McpLiteraryImageModelPublicId?.Trim();
            if (string.IsNullOrWhiteSpace(fixedPublicId))
                return LiteraryMcpModelSelection.Failed("MODEL_CONFIGURATION_INVALID", "这台客户端选择了固定模型，但没有保存模型，请在智能体接入台重新选择。");

            var fixedCatalog = await gateway.GetAvailablePoolsAsync(appCallerCode, ModelTypes.ImageGen, ct);
            return fixedCatalog.Any(x => string.Equals(x.Code, fixedPublicId, StringComparison.Ordinal))
                ? LiteraryMcpModelSelection.Selected(fixedPublicId)
                : LiteraryMcpModelSelection.Failed("MODEL_UNAVAILABLE",
                    "固定模型当前不可用，请在智能体接入台更换模型后重试；系统没有自动切换到其他模型。");
        }

        var preferences = await db.UserPreferences
            .Find(x => x.UserId == ownerUserId)
            .FirstOrDefaultAsync(ct);
        var preferredPoolId = preferences?.LiteraryAgentPreferences?.ImageModelId?.Trim();
        // 入队预检与预设查询只选择逻辑模型，不认领实际线路的恢复租约。
        // 真正发送图片请求时由 Worker 解析线路，否则只读查询或尺寸拒绝会占掉唯一的半开探测。
        var catalog = await gateway.GetAvailablePoolsAsync(appCallerCode, ModelTypes.ImageGen, ct);
        string? preferredPublicId = null;
        if (!string.IsNullOrWhiteSpace(preferredPoolId))
        {
            var rawId = preferredPoolId.StartsWith("pool_", StringComparison.Ordinal)
                ? preferredPoolId["pool_".Length..]
                : preferredPoolId;
            preferredPublicId = catalog.FirstOrDefault(pool =>
                string.Equals(pool.Id, rawId, StringComparison.Ordinal)
                || string.Equals(pool.Code, preferredPoolId, StringComparison.Ordinal))?.Code?.Trim();
        }

        if (!string.IsNullOrWhiteSpace(preferredPublicId))
        {
            return LiteraryMcpModelSelection.Selected(preferredPublicId);
        }

        var dynamicPublicId = catalog.FirstOrDefault(x => x.IsDefault)?.Code?.Trim();
        if (string.IsNullOrWhiteSpace(dynamicPublicId))
            return LiteraryMcpModelSelection.Failed("MODEL_UNAVAILABLE", "当前没有可用的文学配图模型，请管理员检查模型目录与默认路由。");
        return LiteraryMcpModelSelection.Selected(dynamicPublicId);
    }

    public async Task<LiteraryMcpModelSelection> ValidateFixedModelAsync(
        string logicalModelPublicId,
        CancellationToken ct)
    {
        var publicId = logicalModelPublicId?.Trim();
        if (string.IsNullOrWhiteSpace(publicId))
            return LiteraryMcpModelSelection.Failed("MODEL_CONFIGURATION_INVALID", "固定模式必须选择一个模型。");

        foreach (var appCaller in LiteraryImageCallers)
        {
            var resolution = await gateway.ResolveRequiredLogicalModelAsync(
                appCaller,
                ModelTypes.ImageGen,
                publicId,
                ct);
            var checkedResolution = ExactOrFailure(publicId, resolution,
                "该模型不能同时用于文学创作的文生图与图生图，请选择两种场景都可用的模型。");
            if (!checkedResolution.Success) return checkedResolution;
        }
        return LiteraryMcpModelSelection.Selected(publicId);
    }

    public async Task<ImageGenAdapterInfo?> GetImageCapabilitiesAsync(
        string appCallerCode,
        string logicalModelPublicId,
        CancellationToken ct)
    {
        try
        {
            return (await GatewayImageModelCatalog.ReadAsync(gateway, appCallerCode, ct))
                .FirstOrDefault(x => string.Equals(x.Model.Code, logicalModelPublicId, StringComparison.Ordinal))
                ?.ImageCapabilities;
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            // 目录读不到不是「什么尺寸都收」：返回 null，由调用方明说并拒绝入队。
            logger.LogWarning(ex, "[LiteraryMcp] 读取模型 {Model} 的图片能力失败 caller={Caller}", logicalModelPublicId, appCallerCode);
            return null;
        }
    }

    private static LiteraryMcpModelSelection ExactOrFailure(
        string requestedPublicId,
        GatewayModelResolution resolution,
        string message)
        => resolution.Success
           && string.Equals(requestedPublicId, resolution.LogicalModelPublicId?.Trim(), StringComparison.Ordinal)
            ? LiteraryMcpModelSelection.Selected(requestedPublicId)
            : LiteraryMcpModelSelection.Failed("MODEL_UNAVAILABLE", message);
}
