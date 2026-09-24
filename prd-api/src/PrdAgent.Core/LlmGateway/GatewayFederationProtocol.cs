namespace PrdAgent.Core.LlmGateway;

/// <summary>
/// LLMGW 之间通过 OpenAI-compatible 数据面互联时使用的最小扩展协议。
/// 请求正文保持 OpenAI 标准形状，只用请求头携带逐跳信息和回环保护证据。
/// </summary>
public static class GatewayFederationProtocol
{
    public const string ProviderId = "llmgw";
    public const string HopHeader = "X-LLMGW-Hop";
    public const string PathHeader = "X-LLMGW-Path";
    public const int DefaultMaxHops = 2;
    public const int MaxPathLength = 512;

    public static bool IsFederatedProvider(string? providerId)
        => string.Equals(providerId?.Trim(), ProviderId, StringComparison.OrdinalIgnoreCase);

    public static string NormalizeNodeId(string? configured, string? fallback = null)
    {
        var candidate = string.IsNullOrWhiteSpace(configured) ? fallback : configured;
        var normalized = (candidate ?? string.Empty).Trim().ToLowerInvariant();
        if (normalized.Length is 0 or > 80)
            return string.Empty;
        return normalized.All(ch => char.IsAsciiLetterOrDigit(ch) || ch is '.' or '_' or '-')
            ? normalized
            : string.Empty;
    }

    public static int NormalizeMaxHops(int? configured)
        => Math.Clamp(configured ?? DefaultMaxHops, 1, 8);

    public static GatewayFederationInboundDecision ValidateInbound(
        string? hopHeader,
        string? pathHeader,
        string? currentNodeId,
        int maxHops)
    {
        var hasHop = !string.IsNullOrWhiteSpace(hopHeader);
        var hasPath = !string.IsNullOrWhiteSpace(pathHeader);
        if (!hasHop && !hasPath)
            return GatewayFederationInboundDecision.Allow(null);

        if (!hasHop || !hasPath
            || !int.TryParse(hopHeader?.Trim(), out var hop)
            || hop < 1)
        {
            return GatewayFederationInboundDecision.Reject(
                "FEDERATION_TRACE_INVALID",
                "网关联邦链路头不完整或格式错误，请检查 X-LLMGW-Hop 与 X-LLMGW-Path。",
                400);
        }

        if (pathHeader!.Length > MaxPathLength)
        {
            return GatewayFederationInboundDecision.Reject(
                "FEDERATION_PATH_TOO_LONG",
                "网关联邦路径过长，请检查是否存在错误转发。",
                508);
        }

        var nodes = pathHeader.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Select(node => NormalizeNodeId(node))
            .ToList();
        if (nodes.Count != hop
            || nodes.Any(string.IsNullOrWhiteSpace)
            || nodes.Distinct(StringComparer.OrdinalIgnoreCase).Count() != nodes.Count)
        {
            return GatewayFederationInboundDecision.Reject(
                "FEDERATION_TRACE_INVALID",
                "网关联邦跳数与路径不一致，请检查转发配置。",
                400);
        }

        var normalizedMaxHops = NormalizeMaxHops(maxHops);
        if (hop > normalizedMaxHops)
        {
            return GatewayFederationInboundDecision.Reject(
                "FEDERATION_MAX_HOPS_EXCEEDED",
                $"网关联邦链路已超过最大 {normalizedMaxHops} 跳，请检查上游配置。",
                508);
        }

        var nodeId = NormalizeNodeId(currentNodeId);
        if (nodeId.Length > 0 && nodes.Contains(nodeId, StringComparer.OrdinalIgnoreCase))
        {
            return GatewayFederationInboundDecision.Reject(
                "FEDERATION_LOOP_DETECTED",
                "网关联邦链路再次经过当前节点，已终止请求以防止回环。",
                508);
        }

        return GatewayFederationInboundDecision.Allow(new GatewayFederationTrace(hop, string.Join(',', nodes)));
    }

    public static GatewayFederationOutboundDecision BuildOutbound(
        int? inboundHop,
        string? inboundPath,
        string currentNodeId,
        int maxHops)
    {
        var nodeId = NormalizeNodeId(currentNodeId);
        if (nodeId.Length == 0)
        {
            return GatewayFederationOutboundDecision.Reject(
                "FEDERATION_NODE_ID_INVALID",
                "当前网关没有可用的联邦节点标识，请配置 LlmGateway:FederationNodeId。");
        }

        var existingNodes = string.IsNullOrWhiteSpace(inboundPath)
            ? new List<string>()
            : inboundPath.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                .Select(node => NormalizeNodeId(node))
                .ToList();
        if ((inboundHop.HasValue || existingNodes.Count > 0)
            && (inboundHop is null || inboundHop < 1 || inboundHop != existingNodes.Count))
        {
            return GatewayFederationOutboundDecision.Reject(
                "FEDERATION_TRACE_INVALID",
                "已有网关联邦跳数与路径不一致，已终止请求。");
        }
        if (existingNodes.Any(string.IsNullOrWhiteSpace)
            || existingNodes.Distinct(StringComparer.OrdinalIgnoreCase).Count() != existingNodes.Count
            || existingNodes.Contains(nodeId, StringComparer.OrdinalIgnoreCase))
        {
            return GatewayFederationOutboundDecision.Reject(
                "FEDERATION_LOOP_DETECTED",
                "当前网关已经出现在联邦路径中，已终止请求以防止回环。");
        }

        var hop = (inboundHop ?? 0) + 1;
        var normalizedMaxHops = NormalizeMaxHops(maxHops);
        if (hop > normalizedMaxHops)
        {
            return GatewayFederationOutboundDecision.Reject(
                "FEDERATION_MAX_HOPS_EXCEEDED",
                $"网关联邦链路将超过最大 {normalizedMaxHops} 跳，已终止请求。");
        }

        existingNodes.Add(nodeId);
        var path = string.Join(',', existingNodes);
        if (path.Length > MaxPathLength)
        {
            return GatewayFederationOutboundDecision.Reject(
                "FEDERATION_PATH_TOO_LONG",
                "网关联邦路径过长，已终止请求。");
        }

        return GatewayFederationOutboundDecision.Allow(new GatewayFederationTrace(hop, path));
    }
}

public sealed record GatewayFederationTrace(int Hop, string Path);

public sealed record GatewayFederationInboundDecision(
    bool Allowed,
    GatewayFederationTrace? Trace,
    string? ErrorCode,
    string? ErrorMessage,
    int StatusCode)
{
    public static GatewayFederationInboundDecision Allow(GatewayFederationTrace? trace)
        => new(true, trace, null, null, 200);

    public static GatewayFederationInboundDecision Reject(string code, string message, int statusCode)
        => new(false, null, code, message, statusCode);
}

public sealed record GatewayFederationOutboundDecision(
    bool Allowed,
    GatewayFederationTrace? Trace,
    string? ErrorCode,
    string? ErrorMessage)
{
    public static GatewayFederationOutboundDecision Allow(GatewayFederationTrace trace)
        => new(true, trace, null, null);

    public static GatewayFederationOutboundDecision Reject(string code, string message)
        => new(false, null, code, message);
}
