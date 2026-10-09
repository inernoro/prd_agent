using System.Text.RegularExpressions;
using Microsoft.Extensions.Configuration;
using PrdAgent.Core.LlmGateway;
using PrdAgent.Core.Models;

namespace PrdAgent.Infrastructure.LlmGateway;

/// <summary>部署级 GPT 版本下限。按真实上游模型判定，不能被逻辑别名、重试或名录放行标记绕过。</summary>
public sealed class GatewayModelVersionPolicy(IConfiguration? configuration)
{
    public const string ConfigKey = "LlmGateway:MinimumGptVersion";
    public const string ErrorCode = "MODEL_VERSION_NOT_ALLOWED";
    private readonly string? _minimum = configuration?[ConfigKey];
    private static readonly Regex GptVersion = new(
        @"^(?:gpt|chatgpt)-(?<major>\d+)(?:\.(?<minor>\d+))?(?=$|[-._]|o(?:$|-))",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

    public bool Allows(string? model)
    {
        if (string.IsNullOrWhiteSpace(_minimum)) return true;
        // Provider 前缀不改变实际模型的版本；GPT Image / audio 等独立产品不套聊天版本号。
        var name = (model ?? "").Trim().Split('/').Last();
        var match = GptVersion.Match(name);
        if (!match.Success) return true;
        if (!Version.TryParse(_minimum, out var minimum)) return false;
        if (!int.TryParse(match.Groups["major"].Value, out var major)) return false;
        var minor = match.Groups["minor"].Success && int.TryParse(match.Groups["minor"].Value, out var value) ? value : 0;
        return new Version(major, minor) >= minimum;
    }

    public string Message => $"本次调用已停止：GPT 模型必须为 {_minimum} 或更高版本。请管理员调整模型的主线路和备用线路后重试。";

    public ModelResolutionResult Filter(ModelResolutionResult resolution, bool allowPromotion, string appCallerCode)
    {
        if (!resolution.Success) return resolution;
        var permitted = (resolution.RetryCandidates ?? []).Where(x => Allows(x.ActualModel)).ToList();
        resolution.RetryCandidates = permitted;
        if (Allows(resolution.ActualModel)) return resolution;
        if (allowPromotion && permitted.Count > 0)
        {
            var selected = permitted[0];
            selected.RetryCandidates = permitted.Skip(1).ToList();
            return selected;
        }
        return ModelResolutionResult.NotFound(resolution.ExpectedModel, Message, ErrorCode,
            "model-version-policy", appCallerCode);
    }
}
