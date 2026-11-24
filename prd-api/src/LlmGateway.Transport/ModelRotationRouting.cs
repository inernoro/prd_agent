using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text;

namespace PrdAgent.GatewayTransport;

public static class ModelRotationRouting
{
    public const string PilotCaller = "tapd-bug-agent.extract::chat";
    public const string PolicyCollection = "llmgw_model_upgrade_policies";

    public static string PolicyId(string tenantId, string logicalId)
        => "upgrade-" + Hash(tenantId + "\n" + logicalId);

    public static string Hash(string value)
        => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value))).ToLowerInvariant();

    public static bool IsTrialUser(string policyId, string userId, int percentage)
    {
        if (percentage is not (5 or 25) || string.IsNullOrWhiteSpace(userId)) return false;
        var hash = SHA256.HashData(Encoding.UTF8.GetBytes(policyId + "\n" + userId));
        return BinaryPrimitives.ReadUInt32BigEndian(hash) % 100 < percentage;
    }
}
