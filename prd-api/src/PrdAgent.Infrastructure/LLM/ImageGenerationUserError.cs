using PrdAgent.Core.Models;
using PrdAgent.Core.LlmGateway;
using PrdAgent.Infrastructure.LlmGateway;

namespace PrdAgent.Infrastructure.LLM;

/// <summary>
/// 把生图上游的诊断错误归一为普通用户能理解且可操作的错误。
/// 原始响应只允许进入服务端日志，禁止进入 API、SSE、任务记录或界面文案。
/// </summary>
internal static class ImageGenerationUserError
{
    internal readonly record struct Result(string Code, string Message);

    internal static Result FromGateway(GatewayRawResponse response)
    {
        if (response.ErrorCode == ImageInputNormalizer.ErrorCode)
            return new Result(ImageInputNormalizer.ErrorCode, ImageInputNormalizer.ErrorMessage);

        if (string.Equals(
                response.ErrorCode,
                GatewayQuotaAlertPolicy.QuotaErrorCode,
                StringComparison.OrdinalIgnoreCase))
        {
            return new Result(
                GatewayQuotaAlertPolicy.QuotaErrorCode,
                GatewayQuotaAlertPolicy.UserReadableQuotaMessage);
        }

        return Classify(response.StatusCode, response.ErrorMessage ?? response.Content);
    }

    internal static Result FromException(Exception exception)
        => exception switch
        {
            TaskCanceledException => new Result(
                ErrorCodes.IMAGE_GEN_TIMEOUT,
                "图片生成等待超时，请稍后重试。"),
            HttpRequestException => Unavailable(),
            _ => Unavailable()
        };

    internal static Result MissingImage()
        => new(
            ErrorCodes.IMAGE_GEN_UNAVAILABLE,
            "生图服务已响应，但没有返回可用图片，请重试。若持续出现，请联系管理员。");

    internal static Result ModelUnavailable()
        => new(
            ErrorCodes.IMAGE_GEN_UNAVAILABLE,
            "当前没有可用的生图服务，请稍后重试。若持续出现，请联系管理员。");

    /// <summary>
    /// 路由解析失败 → 用户可见结果。
    ///
    /// 过去这里一律返回 IMAGE_GEN_UNAVAILABLE「当前没有可用的生图服务」，
    /// 于是「能力名不兼容」「appCaller 未绑池」「池空」「全熔断」「平台关闭」
    /// 「Provider 故障」「Offering 配错」七种完全不同的问题在用户和管理员眼里长得一模一样，
    /// 管理员据此误判成供应商宕机。现在结构化原因直接作为错误码透出，
    /// 用户拿到的是「重试有没有用」，管理员在日志里拿到点名定位串。
    /// </summary>
    internal static Result FromRouteFailure(string? failureCode)
        => GatewayRouteFailure.All.Contains(failureCode ?? string.Empty, StringComparer.Ordinal)
            ? new Result(failureCode!, GatewayRouteFailure.UserMessage(failureCode))
            : ModelUnavailable();

    internal static Result Classify(int? statusCode, string? diagnostic)
    {
        var text = diagnostic ?? string.Empty;

        if (statusCode == 429 || ContainsAny(text, "rate limit", "too many requests", "quota exceeded", "insufficient quota"))
        {
            return new Result(
                ErrorCodes.RATE_LIMITED,
                "当前生图请求较多，请稍后再试。");
        }

        if (statusCode == 408 || ContainsAny(text, "timed out", "timeout", "deadline exceeded"))
        {
            return new Result(
                ErrorCodes.IMAGE_GEN_TIMEOUT,
                "图片生成等待超时，请稍后重试。");
        }

        if (IsContentSafetyDenial(text))
        {
            return new Result(
                ErrorCodes.IMAGE_GEN_REQUEST_REJECTED,
                "这次描述或参考图未通过内容安全检查，请调整后重试。");
        }

        if (statusCode is 400 or 422)
        {
            if (ContainsAny(
                    text,
                    "input must have at least 1 token",
                    "no endpoints found that support image output",
                    "does not support image generation",
                    "unsupported output modality",
                    "unsupported modalities"))
            {
                return new Result(
                    ErrorCodes.IMAGE_GEN_UNAVAILABLE,
                    "当前生图模型暂时无法处理这组参考图，请更换模型或减少参考图后重试。");
            }

            return new Result(
                ErrorCodes.IMAGE_GEN_REQUEST_REJECTED,
                "当前生图模型无法处理这次请求，请检查描述、参考图和图片尺寸后重试。");
        }

        return Unavailable();
    }

    private static Result Unavailable()
        => new(
            ErrorCodes.IMAGE_GEN_UNAVAILABLE,
            "当前生图服务暂时不可用，请稍后重试。若持续出现，请联系管理员。");

    internal static bool IsContentSafetyDenial(string? diagnostic)
        => ContainsAny(
            diagnostic ?? string.Empty,
            "content policy",
            "content_policy",
            "content filter",
            "content_filter",
            "safety policy",
            "safety system",
            "moderation",
            "blocked by safety",
            "blocked for safety",
            "unsafe content",
            "responsible ai policy");

    private static bool ContainsAny(string text, params string[] values)
        => values.Any(value => text.Contains(value, StringComparison.OrdinalIgnoreCase));
}
